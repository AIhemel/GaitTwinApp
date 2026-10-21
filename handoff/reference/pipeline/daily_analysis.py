"""Daily multi-sensor analysis pipeline (one subject, one day).

Usage:  python daily_analysis.py <day_dir>

<day_dir>/day_config.json describes the day: date, wearable/hydration files and the
recording sessions (folder, short key, label, context). Contexts used by the figures:
  gait_test     short insole recordings
  indoor        environment node (+ posture cushion) while sitting indoors
  outdoor_walk  walk with insole + environment node (+ GPS)
  walk          other walking session with the insoles
  overnight     environment node in the bedroom while sleeping
  transport     riding a vehicle (rickshaw, metro, bus): in-vehicle exposure; no gait analysis
Optional: "temp_offset_c" (added to the environment node's temperature, e.g. -5 for self-heating).
Per session, optional: "start_local"/"end_local" ("HH:MM[:SS]", or "YYYY-MM-DD HH:MM") to use only part of a
recording (data streams are clipped to that span; also used when session.meta.json lacks an end time), and
"streams": a list restricting which streams of the folder belong to the session.
Optional "events": [{"start": "HH:MM", "end": "HH:MM", "label": "...", "exclude_gait": false}] -- participant
notes (e.g. a stop at a restaurant, stairs); they are shaded on the time-series figures and stored in
minute_table.csv. With "exclude_gait": true, strides inside the event (e.g. vehicle vibration) are discarded.

Outputs (all regenerated on every run) go to <day_dir>/analysis_output/:
  figures/d<N>_*.pdf|png   thesis figures for \\documentclass[12pt, a4paper]{report}
  latex/fig_*.tex          one figure environment (with caption) per figure
  latex/metrics_table.tex  headline metrics (needs booktabs + longtable)
  figures.tex              \\input of every figure snippet
  summary.json             nested results
  daily_metrics.csv        one row of headline metrics -> concatenate across days
  minute_table.csv         per-minute merged data from every sensor -> cross-day / ML
  strides_<session>_<side>.csv
"""
import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib.colors import LinearSegmentedColormap
from scipy.signal import butter, filtfilt

# ---- page geometry: report, 12pt, a4paper, default margins -> \textwidth = 390pt = 5.4 in.
# Figures are drawn at this width and included with width=\textwidth, so font sizes below
# are the sizes on paper. If margins change, set TEXTWIDTH_IN = \the\textwidth / 72.27.
TEXTWIDTH_IN = 5.4
MAX_HEIGHT_IN = 4.2  # about half a page, leaves room for caption and text
TZ = "Asia/Dhaka"    # overwritten from day_config.json

# reference palette (dataviz skill, light mode)
C = {"blue": "#2a78d6", "orange": "#eb6834", "aqua": "#1baf7a", "yellow": "#eda100",
     "magenta": "#e87ba4", "green": "#008300", "violet": "#4a3aa7", "red": "#e34948",
     "ink": "#0b0b0b", "ink2": "#52514e", "grid": "#e1e0d9", "band": "#ecebe6"}
DIVERGING = LinearSegmentedColormap.from_list(  # blue <-> red, neutral grey midpoint
    "bluered", ["#184f95", "#6da7ec", "#f0efec", "#ef9a99", "#b8302f"])
plt.rcParams.update({
    "figure.facecolor": "white", "axes.facecolor": "white", "savefig.facecolor": "white",
    "axes.edgecolor": "#9a9890", "axes.labelcolor": C["ink"], "axes.titlecolor": C["ink"],
    "axes.grid": True, "grid.color": C["grid"], "grid.linewidth": 0.6,
    "axes.spines.top": False, "axes.spines.right": False,
    "xtick.color": C["ink2"], "ytick.color": C["ink2"],
    "xtick.labelcolor": C["ink"], "ytick.labelcolor": C["ink"],
    "lines.linewidth": 1.4,
    "font.family": ["Segoe UI", "DejaVu Sans"],
    # 10-11 pt on paper (figure is printed at 100%)
    "font.size": 10, "axes.labelsize": 10.5, "axes.titlesize": 10.5, "xtick.labelsize": 10,
    "ytick.labelsize": 10, "legend.fontsize": 10, "axes.titleweight": "normal",
    "axes.titlelocation": "left", "legend.frameon": False, "pdf.fonttype": 42,
})
WHITE_BOX = {"facecolor": "white", "edgecolor": "none", "pad": 1.5}
WALK_CONTEXTS = ("outdoor_walk", "walk")


# =========================================================================== day / sessions
@dataclass
class Session:
    key: str
    label: str
    context: str
    path: Path
    start: pd.Timestamp
    end: pd.Timestamp
    streams: tuple = None   # whitelist of streams; None = every file in the folder
    clipped: bool = False   # True when the session uses only part of the folder's recording

    def has(self, stream):
        return (self.path / f"{stream}.csv").exists() and (self.streams is None or stream in self.streams)

    def span_ms(self):
        return self.start.timestamp() * 1000, self.end.timestamp() * 1000

    def read(self, stream):
        d = pd.read_csv(self.path / f"{stream}.csv")
        if self.clipped and stream != "events":
            t = d.utc_ms.fillna(d.rx_ms) if "utc_ms" in d and "rx_ms" in d else d.get("utc_ms", d.get("rx_ms"))
            a, b = self.span_ms()
            d = d[(t >= a) & (t <= b)]
        return d


class Day:
    def __init__(self, base):
        global TZ
        self.base = Path(base).resolve()
        cfg = json.loads((self.base / "day_config.json").read_text(encoding="utf-8-sig"))
        self.cfg = cfg
        self.n = cfg["day"]
        TZ = cfg.get("timezone", TZ)
        self.prefix = f"d{self.n}"
        self.temp_offset = float(cfg.get("temp_offset_c", 0))
        self.start = pd.Timestamp(cfg["date"], tz=TZ)
        self.end = self.start + pd.Timedelta(days=1)
        if cfg.get("window_end_local"):  # e.g. a night recording filed with this day that ends the next morning
            self.end = pd.Timestamp(cfg["window_end_local"], tz=TZ)
        self.out = self.base / "analysis_output"
        self.fig = self.out / "figures"
        self.tex = self.out / "latex"
        for d in (self.fig, self.tex):
            shutil.rmtree(d, ignore_errors=True)
            d.mkdir(parents=True)
        self.sessions = []
        for s in cfg["sessions"]:
            p = self.base / s["folder"]
            m = json.loads((p / "session.meta.json").read_text(encoding="utf-8-sig"))

            def when(key, meta_key):
                if s.get(key):
                    v = s[key]
                    return pd.Timestamp(v if len(v) > 8 else f"{cfg['date']} {v}", tz=TZ)
                return pd.Timestamp(m[meta_key]).tz_convert(TZ) if m.get(meta_key) else None
            start, end = when("start_local", "startTime"), when("end_local", "endTime")
            if end is None:
                raise ValueError(f"session {s['key']}: no end time in session.meta.json; set end_local")
            self.sessions.append(Session(s["key"], s["label"], s["context"], p, start, end,
                                         tuple(s["streams"]) if s.get("streams") else None,
                                         bool(s.get("start_local") or s.get("end_local"))))
        self.figures = []  # (name, caption)
        at = lambda v: pd.Timestamp(v if len(v) > 8 else f"{cfg['date']} {v}", tz=TZ)
        self.events = [{"start": at(e["start"]), "end": at(e["end"]), "label": e["label"],
                        "exclude_gait": bool(e.get("exclude_gait")), "zoom": e.get("zoom")}
                       for e in cfg.get("events", [])]

    def with_stream(self, stream, context=None):
        return [s for s in self.sessions if s.has(stream) and (context is None or s.context == context)]

    def session_legend(self):
        return ", ".join(f"{s.key}~{s.label.lower()} ({s.start:%H:%M}--{s.end:%H:%M})" for s in self.sessions)

    def temp_note(self):
        return (rf" Temperature includes a {self.temp_offset:+.0f}\,°C correction for sensor self-heating."
                if self.temp_offset else "")


# =========================================================================== helpers
def fig_size(h):
    return (TEXTWIDTH_IN, min(h, MAX_HEIGHT_IN))


def save(day, fig, name, caption):
    name = f"{day.prefix}_{name}"
    fig.savefig(day.fig / f"{name}.pdf")
    fig.savefig(day.fig / f"{name}.png", dpi=300)
    plt.close(fig)
    day.figures.append((name, caption))


def to_local(ms):
    return pd.to_datetime(ms, unit="ms", utc=True).dt.tz_convert(TZ)


def ms_ts(ms):
    return pd.to_datetime(ms, unit="ms", utc=True).tz_convert(TZ)


def time_axis(ax, minutes=None, hours=None):
    if minutes:
        ax.xaxis.set_major_locator(mdates.MinuteLocator(byminute=range(0, 60, minutes), tz=TZ))
    if hours:
        ax.xaxis.set_major_locator(mdates.HourLocator(interval=hours, tz=TZ))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=TZ))


def gapped(t, y, max_gap_s=40):
    """Insert NaN where samples are further apart than max_gap_s so lines break at data gaps."""
    t = pd.Series(t).reset_index(drop=True)
    y = pd.Series(y).reset_index(drop=True).astype(float)
    gap = t.diff().dt.total_seconds() > max_gap_s
    y[gap] = np.nan
    return t, y


def mark_events(day, axes, t0, t1, label_ax=None):
    """Shade participant-noted events inside [t0, t1]; return a caption fragment naming them."""
    hits = [e for e in day.events if e["start"] < t1 and e["end"] > t0]
    for i, e in enumerate(hits):
        for ax in axes:
            ax.axvspan(e["start"], e["end"], color=C["yellow"], alpha=0.22, lw=0, zorder=0)
        if label_ax is not None:
            label_ax.text(e["start"] + (e["end"] - e["start"]) / 2, 1.0, "ABCDEFGH"[i], ha="center", va="bottom",
                          fontweight="bold", transform=label_ax.get_xaxis_transform())
    if not hits:
        return ""
    return " Yellow bands mark noted events: " + "; ".join(
        f"{'ABCDEFGH'[i]}~{e['label']} ({e['start']:%H:%M}--{e['end']:%H:%M})" for i, e in enumerate(hits)) + "."


def lowpass(x, fs, fc=6.0):
    b, a = butter(2, fc / (fs / 2))
    return filtfilt(b, a, x)


def r2(x):
    return None if x is None or pd.isna(x) else round(float(x), 2)


# =========================================================================== gait
def detect_strides(d, fs=112.0, normalize=False):
    """Heel strikes = rising edges of plantar load (sum of the 3 FSRs).

    FSRs read high when loaded (standing still gives ~4000 on all three).
    Threshold with hysteresis between the swing and stance load levels.
    normalize: scale every sensor between its own 5th and 95th percentile (0..~1), so that sensors of different types
    or ranges (e.g. replacement FSRs) and constant preload do not matter; load shares use the normalised signals.
    """
    ch = d[["Heel_FSR", "Met1_FSR", "Met5_FSR"]].to_numpy(float).copy()
    p95 = np.percentile(ch, 95, axis=0)
    if normalize:  # each sensor between its own low (5th) and high (95th percentile) level: removes preload too
        p5 = np.percentile(ch, 5, axis=0)
        ch = (ch - p5) / np.maximum(p95 - p5, 1.0)
    else:
        # a replacement sensor with a much smaller output range (e.g. 0-70 instead of 0-4095) would contribute almost
        # nothing to the summed load; rescale such channels to the range of the strongest one (dead channels stay 0)
        small = (p95 > 5) & (p95 < 0.25 * p95.max())
        ch[:, small] *= p95.max() / p95[small]
    load = lowpass(ch.sum(axis=1), fs)
    # adaptive thresholds: sensor levels drift during a session (insole shifting, preload changes), so the
    # swing/stance levels are tracked with rolling 5th/95th percentiles over ~10 s (computed at ~10 Hz)
    step = max(1, int(round(fs / 10)))
    sub = pd.Series(load[::step])
    win = max(5, int(10 * fs / step))
    lo_s = sub.rolling(win, center=True, min_periods=win // 4).quantile(0.05).bfill().ffill().to_numpy()
    hi_s = sub.rolling(win, center=True, min_periods=win // 4).quantile(0.95).bfill().ffill().to_numpy()
    idx = np.arange(len(load)) / step
    lo, hi = np.interp(idx, np.arange(len(sub)), lo_s), np.interp(idx, np.arange(len(sub)), hi_s)
    rng_g = np.percentile(load, 95) - np.percentile(load, 5)
    hi = np.maximum(hi, lo + 0.3 * rng_g)  # standing still: no modulation, keep thresholds apart
    on_th, off_th = lo + 0.55 * (hi - lo), lo + 0.35 * (hi - lo)
    contact = np.zeros(len(load), bool)
    state = load[0] > on_th[0]
    for i, v in enumerate(load):
        if state and v < off_th[i]:
            state = False
        elif not state and v > on_th[i]:
            state = True
        contact[i] = state
    t = d["utc_ms"].to_numpy()
    edges = np.diff(contact.astype(int))
    hs = np.where(edges == 1)[0] + 1   # heel strike (foot loads)
    to = np.where(edges == -1)[0] + 1  # toe off

    fsr = ch if normalize else d[["Heel_FSR", "Met1_FSR", "Met5_FSR"]].to_numpy(float)
    tilt = foot_tilt(d)
    tilt_rate = np.gradient(lowpass(tilt, fs), t / 1000)  # deg/s, positive while the foot rotates away from flat
    acc = np.sqrt(d.Accel_X**2 + d.Accel_Y**2 + d.Accel_Z**2).to_numpy(float)

    def impact(h):
        """Heel-strike impact: peak acceleration within -200..+150 ms of the pressure-based heel strike."""
        m = (t >= t[h] - 200) & (t <= t[h] + 150)
        return t[m][np.argmax(acc[m])] if m.sum() >= 5 else np.nan

    def pushoff(a, b):
        """Push-off timing: impact to peak foot tilt (maximum plantarflexion, just after toe-off), % of stride.

        Uses only the orientation and acceleration sensors, so it stays comparable when a pressure sensor fails.
        """
        h = impact(a)
        if np.isnan(h):
            return np.nan
        T = t[b] - t[a]
        m = (t >= h) & (t < h + 0.9 * T)
        return 100 * (t[m][np.argmax(tilt[m])] - h) / T if m.sum() >= 10 else np.nan

    def toe_off_imu(a, b):
        """IMU toe-off: the instant the push-off rotation rate has fallen to half its peak, between the peak
        rotation rate and maximum plantarflexion. Validated against the pressure toe-off on right-foot strides
        with all sensors original and healthy (days 1-2: median difference about 0 ms); independent of the
        pressure sensors, so it stays valid when a sensor is replaced."""
        T = t[b] - t[a]
        m = np.where((t >= t[a] + 0.3 * T) & (t < t[a] + 0.9 * T))[0]
        if len(m) < 10:
            return np.nan
        pk = m[:np.argmax(tilt[m]) + 1]  # up to maximum plantarflexion
        if len(pk) < 4:
            return np.nan
        i = pk[np.argmax(tilt_rate[pk])]
        while i < b and tilt_rate[i] > 0.5 * tilt_rate[pk].max():
            i += 1
        return t[i] if i < b else np.nan

    rows = []
    for a, b in zip(hs[:-1], hs[1:]):
        stride_s = (t[b] - t[a]) / 1000
        if not 0.7 <= stride_s <= 2.0:  # outside normal walking stride range
            continue
        toe = to[(to > a) & (to < b)]
        if len(toe) != 1:
            continue
        seg = d.iloc[a:b]
        share = fsr[a:b].sum(axis=0) / fsr[a:b].sum()
        h_imu, to_imu = impact(a), toe_off_imu(a, b)
        st_imu = to_imu - h_imu  # impact (initial contact) to IMU toe-off
        rows.append({
            "hs_ms": t[a], "stride_s": stride_s,
            "stance_pct": 100 * (t[toe[0]] - t[a]) / (t[b] - t[a]),
            "pitch_range_deg": seg["Pitch"].max() - seg["Pitch"].min(),
            "peak_acc_ms2": np.sqrt(seg.Accel_X**2 + seg.Accel_Y**2 + seg.Accel_Z**2).max(),
            "heel_share": share[0], "met1_share": share[1], "met5_share": share[2],
            "tilt_range_deg": float(tilt[a:b].max() - tilt[a:b].min()),
            "hs_imu_ms": impact(a),
            "pushoff_pct": pushoff(a, b),
            "stance_s": (t[toe[0]] - t[a]) / 1000, "swing_s": (t[b] - t[toe[0]]) / 1000,
            "to_imu_ms": to_imu, "to_fsr_ms": t[toe[0]],
            "stance_imu_pct": 100 * st_imu / (t[b] - t[a]), "stance_imu_s": st_imu / 1000,
            "swing_imu_s": stride_s - st_imu / 1000,
        })
    s = pd.DataFrame(rows)
    if len(s):
        # strides belong to one continuous walking bout if consecutive (gap < 2.5 s)
        gap = np.diff(s.hs_ms.to_numpy(), prepend=s.hs_ms.iloc[0]) / 1000
        s["bout"] = (gap > 2.5).cumsum()
    return s, load, contact


def gait_summary(s, duration_s):
    if s.empty:
        return {"strides_detected": 0}
    # bouts with >= 10 strides = steady walking; drop first/last 2 strides (accel/decel)
    steady = s.groupby("bout").filter(lambda g: len(g) >= 10)
    steady = steady.groupby("bout", group_keys=False).apply(lambda g: g.iloc[2:-2])
    use = steady if len(steady) >= 10 else s
    st = use.stride_s
    return {
        "recording_min": round(duration_s / 60, 1),
        "strides_detected": int(len(s)),
        "steps_estimated": int(2 * len(s)),
        "walking_bouts_>=10_strides": int(s.groupby("bout").size().ge(10).sum()),
        "time_walking_min": round(s.stride_s.sum() / 60, 1),
        "stride_time_s_median": round(st.median(), 3),
        "stride_time_cv_pct": round(100 * st.std() / st.mean(), 1),
        "cadence_steps_per_min": round(120 / st.median(), 1),
        "stance_pct_median": round(use.stance_pct.median(), 1),
        "pushoff_pct_median": round(use.pushoff_pct.median(), 1) if "pushoff_pct" in use else None,
        "stance_imu_pct_median": round(use.stance_imu_pct.median(), 1),
        "stance_imu_s_median": round(use.stance_imu_s.median(), 3),
        "swing_imu_s_median": round(use.swing_imu_s.median(), 3),
        "pitch_range_deg_median": round(use.pitch_range_deg.median(), 1),
        "peak_acc_ms2_median": round(use.peak_acc_ms2.median(), 1),
        "load_share_heel_met1_met5_pct": [round(100 * use[c].mean(), 1) for c in
                                          ("heel_share", "met1_share", "met5_share")],
    }


def analyze_gait(day, sess):
    g = sess.read("gait")
    ev = sess.read("events")
    out, right = {}, None
    for side, d in g.groupby("side"):
        wins = connection_windows(ev, "GAIT" if side == "R" else "GAIT_LEFT", sess.span_ms())
        d = timed_side(d, wins)  # per-connection clock: the node clock restarts on reconnection
        d["utc_ms"] = d.t
        dur = (d.t.iloc[-1] - d.t.iloc[0]) / 1000
        dt = np.diff(d.t.to_numpy())
        fs = len(d) / max(1e-9, dur - dt[dt > 200].sum() / 1000)  # rate over the time actually streamed
        gap_frac = dt[dt > 200].sum() / 1000 / dur
        info = {"samples": len(d), "duration_s": round(dur, 1), "rate_hz": round(fs, 1),
                "gaps_>200ms": int((dt > 200).sum()), "gap_time_pct": round(100 * gap_frac, 1)}
        # strides spanning a gap are removed below, so a single longer disconnection can be allowed per day
        if fs < day.cfg.get("min_rate_hz", 80) or gap_frac > day.cfg.get("max_gap_frac", 0.10):
            info["note"] = "stream too sparse/gappy for stride segmentation"
            out[side] = info
            continue
        s, load, contact = detect_strides(d, fs, normalize=bool(day.cfg.get("normalize_fsr")))
        if len(s):  # strides spanning a data gap are not real strides
            gap_ends = d.t.to_numpy()[1:][dt > 200]
            span_gap = [((gap_ends > h) & (gap_ends <= h + 1000 * st)).any() for h, st in zip(s.hs_ms, s.stride_s)]
            s = s[~np.array(span_gap)].reset_index(drop=True)
        for e in day.events:  # e.g. vehicle vibration noted by the participant is not walking
            if e["exclude_gait"] and len(s):
                ts = to_local(s.hs_ms)
                s = s[~((ts >= e["start"]) & (ts < e["end"]))].reset_index(drop=True)
        s.to_csv(day.out / f"strides_{sess.key}_{side}.csv", index=False)
        if day.cfg.get("lr_profiles") and len(s) >= 30:
            save_profiles(day, sess, side, d, s)
        info.update(gait_summary(s, dur))
        out[side] = info
        if side == "R":
            right = (d, s, load, contact)
    return out, right


def save_profiles(day, sess, side, d, s, n_pts=100):
    """Each foot's normalised pressure (per sensor, 0 = unloaded, 1 = its own 95th percentile) and foot tilt over its own
    steady strides, resampled to 0-100 % of the stride. Uses only that foot's clock, so it is valid even when the two
    insoles' clocks are not aligned."""
    st = steady(s)
    t = d.utc_ms.to_numpy(float)
    F = d[FSR].to_numpy(float)
    lo, hi = np.percentile(F, 5, axis=0), np.percentile(F, 95, axis=0)
    F = (F - lo) / np.maximum(hi - lo, 1.0)  # 0 = the sensor's own unloaded level, 1 = its 95th percentile
    tilt = foot_tilt(d)
    curves = {c: [] for c in ("heel", "met1", "met5", "tilt")}
    for r in st.itertuples():
        a, b = r.hs_ms, r.hs_ms + 1000 * r.stride_s
        i, j = np.searchsorted(t, a), np.searchsorted(t, b)
        if j - i < 30:
            continue
        g = np.linspace(a, b, n_pts, endpoint=False)
        for k, c in enumerate(("heel", "met1", "met5")):
            curves[c].append(np.interp(g, t[i:j + 1], F[i:j + 1, k]))
        curves["tilt"].append(np.interp(g, t[i:j + 1], tilt[i:j + 1]))
    np.savez(day.out / f"profiles_{sess.key}_{side}.npz", **{k: np.array(v) for k, v in curves.items()},
             stance_pct=st.stance_pct.to_numpy(), stride_s=st.stride_s.to_numpy(), pushoff=st.pushoff_pct.to_numpy(),
             tilt_range=st.tilt_range_deg.to_numpy())


def plot_lr_profiles(day, sess, health=None):
    """Left vs right foot from each foot's own strides (no inter-insole timing needed)."""
    P = {s: np.load(day.out / f"profiles_{sess.key}_{s}.npz") for s in ("L", "R")}
    x = np.arange(100)
    fig, ax = plt.subplots(2, 2, figsize=fig_size(3.9), sharex=True, layout="constrained")
    res = {"strides": {s: int(len(P[s]["heel"])) for s in P}}
    for a, c, title in zip(ax.ravel(), ("heel", "met1", "met5", "tilt"),
                           ("(a) Heel", "(b) First metatarsal (Met1)", "(c) Fifth metatarsal (Met5)", "(d) Foot tilt")):
        for s, col, ls in (("L", C["orange"], "--"), ("R", C["blue"], "-")):
            m = np.median(P[s][c], axis=0)
            q1, q3 = np.percentile(P[s][c], [25, 75], axis=0)
            a.fill_between(x, q1, q3, color=col, alpha=0.18, lw=0)
            a.plot(x, m, color=col, ls=ls, lw=1.8, label="Left" if s == "L" else "Right")
            if c != "tilt":
                on = m > 0.3
                pk = int(np.argmax(m))
                after = np.where(~on[pk:])[0]
                res.setdefault(c, {})[s] = {"loaded_pct_of_stride": round(float(on.mean() * 100), 1),
                                            "peak_at_pct": pk,
                                            "unload_at_pct": int(pk + after[0]) if len(after) else None}
            else:
                res.setdefault("tilt_peak_at_pct", {})[s] = int(np.argmax(m))
        a.set_title(title, loc="left")
        a.set_ylabel("Normalised load" if c != "tilt" else "Tilt (°)")
    for a in ax[1]:
        a.set_xlabel("Stride (% from heel strike)")
    ax[0, 0].legend(loc="upper right", fontsize=9)
    for s in ("L", "R"):
        res[f"stride_s_{s}"] = round(float(np.median(P[s]["stride_s"])), 3)
        res[f"pressure_stance_{s}"] = round(float(np.median(P[s]["stance_pct"])), 1)
        res[f"pushoff_{s}"] = round(float(np.nanmedian(P[s]["pushoff"])), 1)
        res[f"tilt_range_{s}"] = round(float(np.median(P[s]["tilt_range"])), 1)
    save(day, fig, f"lr_profiles_{sess.key}",
         rf"Left and right foot during session {sess.key} from each foot's own steady strides (left {res['strides']['L']}, "
         rf"right {res['strides']['R']}). Each pressure sensor is scaled between its own unloaded level (5th percentile, 0) and "
         r"its 95th percentile (1), so sensors of different types and constant preload do not affect the comparison of shape "
         r"and timing; lines: median, bands: inter-quartile range. (a)--(c) Heel, "
         r"first- and fifth-metatarsal load over the stride; (d) foot tilt from the flat, loaded position. Pressure-based "
         rf"stance (normalised): left {res['pressure_stance_L']:.1f}\,\%, right {res['pressure_stance_R']:.1f}\,\% of the stride; "
         rf"stride time {res['stride_s_L']:.2f} vs {res['stride_s_R']:.2f}\,s; foot-tilt range {res['tilt_range_L']:.0f}° vs "
         rf"{res['tilt_range_R']:.0f}°.")
    return res


def plot_gait_pressure(day, sess, right):
    d, s, load, contact = right
    b = s.groupby("bout").size().idxmax()
    t0 = s[s.bout == b].hs_ms.iloc[len(s[s.bout == b]) // 2]
    m = (d.utc_ms >= t0) & (d.utc_ms < t0 + 6000)
    tt = (d.utc_ms[m] - t0) / 1000
    fig, ax = plt.subplots(figsize=fig_size(2.8), constrained_layout=True)
    ax.fill_between(tt, 0, 4095, where=contact[m.to_numpy()], color=C["band"], step="mid", lw=0, label="Stance")
    for col, c, ls in (("Heel_FSR", C["blue"], "-"), ("Met1_FSR", C["orange"], "--"), ("Met5_FSR", C["aqua"], ":")):
        ax.plot(tt, d.loc[m, col], color=c, ls=ls, lw=1.6, label=col.replace("_FSR", ""))
    ax.set(xlabel="Time (s)", ylabel="FSR output (counts)", ylim=(0, 4600), xlim=(0, 6))
    ax.legend(ncol=4, loc="upper center", bbox_to_anchor=(0.5, 1.15), handlelength=2.2)
    save(day, fig, "gait_pressure",
         rf"Right-insole plantar pressure during 6\,s of steady walking (session {sess.key}, "
         rf"{sess.label.lower()}). Lines show the heel, first-metatarsal (Met1) and fifth-metatarsal (Met5) "
         r"force-sensitive resistors (12-bit ADC counts; higher means more load). Shaded intervals are stance "
         r"phases detected by hysteresis thresholding of the summed, 6\,Hz low-pass filtered load.")


def plot_gait_strides(day, sess, s, gs):
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.0), constrained_layout=True)
    med = s.stride_s.median()
    ax[0].plot(to_local(s.hs_ms), s.stride_s, "o", ms=2.4, color=C["blue"], alpha=0.5, mew=0)
    ax[0].axhline(med, color=C["ink"], lw=1, ls="--")
    ax[0].set(ylabel="Stride time (s)", xlabel="Local time", ylim=(0.9, 2.05), title="(a) Stride time")
    time_axis(ax[0], minutes=10)
    ax[1].hist(s.stance_imu_pct.dropna(), bins=np.arange(46, 90, 2), color=C["blue"], edgecolor="white", lw=0.6,
               label="IMU")
    ax[1].hist(s.stance_pct, bins=np.arange(46, 90, 2), histtype="step", color=C["orange"], lw=1.5, ls="--",
               label="Pressure")
    ax[1].axvline(60, color=C["ink"], lw=1, ls=":")
    ax[1].legend(loc="upper right", handlelength=1.6)
    ax[1].set(xlabel="Stance (% of stride)", ylabel="Strides", title="(b) Stance phase")
    save(day, fig, "gait_strides",
         rf"Right-foot stride parameters, session {sess.key} ({gs['strides_detected']} strides). "
         rf"(a) Stride time of every detected stride; dashed line = median ({med:.2f}\,s, "
         rf"cadence {gs['cadence_steps_per_min']:.0f} steps/min). (b) Stance phase as a percentage of stride "
         rf"time from IMU gait events (bars; heel-strike impact to IMU toe-off; median of steady-walking strides "
         rf"{gs['stance_imu_pct_median']:.1f}\,\%) and from the pressure sensors (dashed outline; "
         rf"{gs['stance_pct_median']:.1f}\,\%){' -- not valid on this day because the first-metatarsal sensor had been replaced' if day.cfg.get('stance_invalid_sides') else ''}; "
         r"dotted line = typical healthy value of about 60\,\%.")


def plot_gait_compare(day, strides, summaries):
    keys = list(strides)
    labels = [f"{k}\n{next(s for s in day.sessions if s.key == k).start:%H:%M}" for k in keys]
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.0), constrained_layout=True)
    for i, (col, ylab, title) in enumerate((("stride_s", "Stride time (s)", "(a) Stride time"),
                                            ("stance_imu_pct", "Stance (% of stride)", "(b) Stance phase (IMU)"))):
        bp = ax[i].boxplot([strides[k][col].dropna() for k in keys], widths=0.55, showfliers=False,
                           patch_artist=True, medianprops={"color": C["ink"], "lw": 1.6})
        for p in bp["boxes"]:
            p.set(facecolor=C["band"], edgecolor=C["ink2"])
        ax[i].set_xticks(range(1, len(keys) + 1), labels)
        ax[i].set(ylabel=ylab, title=title)
        ax[i].grid(axis="x", visible=False)
    n_txt = ", ".join(f"{k}: $n={summaries[k]['R']['strides_detected']}$" for k in keys)
    save(day, fig, "gait_compare",
         rf"Right-foot (a) stride time and (b) stance phase (IMU gait events) across the gait recordings of day~{day.n} "
         rf"({n_txt}; session start time below each key). Boxes show the inter-quartile range and median; "
         r"whiskers extend to 1.5\,IQR (outliers not drawn).")


# =========================================================================== pressure-sensor health
FSR = ["Heel_FSR", "Met1_FSR", "Met5_FSR"]
HEALTH = {"ok": (C["aqua"], ""), "low range": (C["yellow"], ".."), "dropout": (C["red"], "///")}


def sensor_health(sess):
    """Per-minute status of every pressure sensor while that foot is moving.

    dropout: no signal, or a full-range signal that reads exactly 0 in more than half of the samples
    (open circuit / loose solder joint); low range: 95th percentile above 0 but below 10 % of the strongest sensor
    on the same foot (e.g. a replacement sensor with a smaller output range). Minutes in which the foot is not
    moving are not rated.
    """
    g = sess.read("gait")
    rows = []
    for side, d in g.groupby("side"):
        d = d.assign(t=to_local(d.rx_ms).dt.floor("1min"),
                     acc=np.sqrt(d.Accel_X**2 + d.Accel_Y**2 + d.Accel_Z**2))
        moving = d.groupby("t").acc.std() > 2.0
        ref = d[FSR].quantile(0.95).max()
        for c in FSR:
            st = d.groupby("t")[c].agg(zero=lambda v: (v == 0).mean(), p95=lambda v: v.quantile(0.95))
            st = st[moving.reindex(st.index, fill_value=False)]
            # no signal -> dropout; small but present signal -> low range (a low-range sensor also reads 0 whenever
            # lightly loaded); full-range signal that is zero most of the time -> intermittent connection (dropout)
            status = np.where(st.p95 < 2, "dropout",
                              np.where(st.p95 < 0.1 * ref, "low range",
                                       np.where(st.zero > 0.5, "dropout", "ok")))
            rows += [{"side": side, "sensor": c.replace("_FSR", ""), "minute": t, "status": v}
                     for t, v in zip(st.index, status)]
    return pd.DataFrame(rows)


def plot_sensor_health(day, health):
    keys = list(health)
    labels = [f"{s} {c}" for s in ("L", "R") for c in ("Heel", "Met1", "Met5")]
    fig, axes = plt.subplots(len(keys), 1, figsize=fig_size(1.2 + 1.5 * len(keys)), squeeze=False, layout="constrained")
    for ax, k in zip(axes[:, 0], keys):
        h = health[k]
        for y, lab in enumerate(labels):
            side, sen = lab.split()
            r = h[(h.side == side) & (h.sensor == sen)]
            for row in r.itertuples():
                c, hatch = HEALTH[row.status]
                ax.barh(y, pd.Timedelta(minutes=1), left=row.minute, height=0.7, color=c, hatch=hatch,
                        edgecolor="white", lw=0.2)
        ax.set_yticks(range(len(labels)), labels)
        ax.invert_yaxis()
        ax.set_title(f"Session {k}", loc="left")
        ax.grid(axis="y", visible=False)
        time_axis(ax, **tick_step(pd.DataFrame({"t": [h.minute.min(), h.minute.max()]})))
    axes[-1, 0].set_xlabel("Local time")
    handles = [plt.Rectangle((0, 0), 1, 1, fc=c, hatch=hh, ec="white") for c, hh in HEALTH.values()]
    fig.legend(handles, list(HEALTH), loc="outside upper center", ncol=3)
    summ = "; ".join(
        f"session {k}: " + ", ".join(
            rf"{s} {c} {100 * (g.status != 'ok').mean():.0f}\,\% faulty"
            for (s, c), g in health[k].groupby(["side", "sensor"]) if (g.status != "ok").mean() >= 0.1)
        for k in keys)
    save(day, fig, "sensor_health",
         r"Status of each insole pressure sensor for every minute in which that foot was moving: OK, low range "
         r"(signal present but its 95th percentile below 10\,\% of the foot's strongest sensor, e.g. a replacement "
         r"sensor with a smaller output range) or dropout (no signal, or a full-range signal that is exactly zero in "
         r"more than half of the samples, typical of a loose connection). "
         rf"Sensors faulty in at least 10\,\% of moving minutes: {summ or 'none'}.")


# =========================================================================== posture
POSE_STYLE = {  # colour + hatch so the figure survives greyscale printing
    "STRAIGHT": (C["green"], ""), "UPRIGHT": (C["green"], ""), "LEAN_BACKWARD": (C["blue"], ""),
    "LEAN_FORWARD": (C["orange"], ".."),
    "SLOUCH": (C["red"], "///"), "LEAN_LEFT": (C["violet"], "\\\\\\"), "LEAN_RIGHT": (C["magenta"], "xx"),
}


# Participant check (day 5): sitting deliberately upright is reported by the cushion as LEAN_FORWARD, so that
# category is relabelled as upright; genuine forward leaning cannot be separated from it.
POSE_RELABEL = {"LEAN_FORWARD": "UPRIGHT"}


def posture_segments(sess):
    p = sess.read("posture")
    p["pose_name"] = p.pose_name.replace(POSE_RELABEL)
    ev = sess.read("events")
    # replayed events were queued on the cushion with no usable time - drop for durations
    live = p[p.replayed == 0].copy()
    live["onset_ms"] = live.utc_ms - 10_000  # pose committed after being held 10 s
    conn, windows = None, []
    session_start = ev.loc[ev.event == "session_start", "rx_ms"].iloc[0]
    stops = ev.loc[ev.event == "session_stop", "rx_ms"]
    session_stop = stops.iloc[-1] if len(stops) else sess.span_ms()[1]
    for _, r in ev[ev.node == "POSTURE"].iterrows():
        if r.event in ("status_at_start_connected", "connected"):
            conn = r.rx_ms if r.event == "connected" else session_start
        elif r.event == "disconnected" and conn is not None:
            windows.append((conn, r.rx_ms))
            conn = None
    if conn is not None:
        windows.append((conn, session_stop))
    a0, b0 = sess.span_ms()
    windows = [(max(a, a0), min(b, b0)) for a, b in windows if b > a0 and a < b0]
    segs = []
    for w0, w1 in windows:
        inside = live[(live.onset_ms >= w0 - 15_000) & (live.onset_ms < w1)].sort_values("onset_ms")
        for i, r in enumerate(inside.itertuples()):
            end = inside.onset_ms.iloc[i + 1] if i + 1 < len(inside) else w1
            segs.append({"session": sess.key, "pose": r.pose_name, "start": max(r.onset_ms, w0), "end": end})
    return pd.DataFrame(segs), windows, len(live)


def analyze_posture(day):
    all_segs, all_windows, n_live = [], [], 0
    for sess in day.with_stream("posture"):
        s, w, n = posture_segments(sess)
        all_segs.append(s); all_windows += w; n_live += n
    if not all_segs:
        return None, None, None
    segs = pd.concat(all_segs, ignore_index=True)
    segs["min"] = (segs.end - segs.start) / 60_000
    total = segs["min"].sum()
    by_pose = segs.groupby("pose")["min"].sum().sort_values(ascending=False)
    session_min = sum((s.end - s.start).total_seconds() / 60 for s in day.with_stream("posture"))
    return {
        "connected_windows_local": [f"{ms_ts(a):%H:%M}-{ms_ts(b):%H:%M}" for a, b in all_windows],
        "session_min": round(session_min, 1),
        "monitored_min": round(sum(b - a for a, b in all_windows) / 60_000, 1),
        "classified_min": round(total, 1),
        "live_pose_changes": int(n_live),
        "minutes_by_pose": by_pose.round(1).to_dict(),
        "pct_by_pose": (100 * by_pose / total).round(1).to_dict(),
        "pct_upright_straight": round(100 * (by_pose.get("STRAIGHT", 0) + by_pose.get("UPRIGHT", 0)) / total, 1),
        "median_bout_min": round(segs["min"].median(), 1),
    }, segs, all_windows


def plot_posture(day, summary, segs, windows):
    fig, ax = plt.subplots(2, 1, figsize=fig_size(3.8), constrained_layout=True,
                           gridspec_kw={"height_ratios": [0.55, 1.3]})
    a0, a1 = ms_ts(windows[0][0]), ms_ts(windows[-1][1])
    for w0, w1 in windows:
        ax[0].axvspan(ms_ts(w0), ms_ts(w1), ymin=0.1, ymax=0.9, color=C["band"], lw=0)
    for r in segs.itertuples():
        c, h = POSE_STYLE[r.pose]
        ax[0].axvspan(ms_ts(r.start), ms_ts(r.end), ymin=0.1, ymax=0.9, facecolor=c, hatch=h,
                      edgecolor="white", lw=0.4)
    ax[0].set(yticks=[], xlim=(a0, a1), title="(a) Posture timeline")
    ax[0].grid(False)
    time_axis(ax[0], **tick_step(pd.DataFrame({"t": [a0, a1]})))
    pct = pd.Series(summary["pct_by_pose"]).sort_values()
    for y, (k, v) in enumerate(pct.items()):
        c, h = POSE_STYLE[k]
        ax[1].barh(y, v, height=0.62, color=c, hatch=h, edgecolor="white", lw=0.4)
        ax[1].text(v + 1, y, f"{v:.0f}% ({summary['minutes_by_pose'][k]:.0f} min)", va="center")
    ax[1].set_yticks(range(len(pct)), [k.replace("_", " ").capitalize() for k in pct.index])
    upr = r" ``Upright'' is the cushion's lean-forward category, which the participant confirmed is how it reports " \
          r"deliberately upright sitting; genuine forward leaning cannot be separated from it." \
        if "UPRIGHT" in pct.index else ""
    ax[1].set(xlabel="Share of classified sitting time (%)", xlim=(0, max(62, pct.max() * 1.35)),
              title="(b) Time in each posture")
    ax[1].grid(axis="y", visible=False)
    ws = ", ".join(w.replace("-", "--") for w in summary["connected_windows_local"])
    save(day, fig, "posture",
         rf"Sitting posture from the smart cushion. (a) Pose held over time; the cushion was connected during "
         rf"{ws} ({summary['monitored_min']:.0f} of {summary['session_min']:.0f}\,min). Light grey = connected "
         r"but no live pose event yet; white = disconnected. Onsets are shifted 10\,s earlier to correct for the "
         rf"cushion's commit delay. (b) Share of the {summary['classified_min']:.0f} classified minutes in each "
         rf"pose; median time between pose changes {summary['median_bout_min']:.1f}\,min.{upr}")


# =========================================================================== environment
ENV_COLS = {"co2_ppm": "CO$_2$ (ppm)", "temp_c": "Temp. (°C)", "rh_pct": "RH (%)",
            "pm25": "PM$_{2.5}$ (µg/m³)", "pm10": "PM$_{10}$ (µg/m³)", "dba": "Sound (dBA)"}
ENV_REFS = {"co2_ppm": (1000, "1000 ppm"), "pm25": (15, "WHO 24-h guideline"), "dba": (70, "70 dBA")}


def load_env(day, sessions):
    if not sessions:
        return None
    e = pd.concat([s.read("environment").assign(session=s.key) for s in sessions]).sort_values("utc_ms")
    e["temp_c"] = e.temp_c.astype(float) + day.temp_offset  # sensor self-heating correction (day_config)
    e["t"] = to_local(e.utc_ms)
    return e.reset_index(drop=True)


def env_stats(e):
    st = {}
    for c in ENV_COLS:
        v = e[c].dropna().astype(float)
        st[c] = {"mean": round(v.mean(), 1), "median": round(v.median(), 1), "p5": round(v.quantile(.05), 1),
                 "p95": round(v.quantile(.95), 1), "max": round(v.max(), 1), "min": round(v.min(), 1)}
    st["pct_time_co2_over_1000"] = round(100 * (e.co2_ppm > 1000).mean(), 1)
    st["pct_time_pm25_over_WHO24h_15"] = round(100 * (e.pm25 > 15).mean(), 1)
    st["pct_time_pm25_over_BD_NAAQS_65"] = round(100 * (e.pm25 > 65).mean(), 1)
    st["pct_time_dba_over_70"] = round(100 * (e.dba > 70).mean(), 1)
    st["samples"] = int(len(e))
    return st


def env_axis(ax, e, c, letter, ref_label=True):
    t, y = gapped(e.t, e[c])
    ax.plot(t, y, color=C["blue"], lw=1.1)
    if c in ENV_REFS:
        ax.axhline(ENV_REFS[c][0], color=C["red"], lw=1.1, ls="--")
        if ref_label:
            ax.text(0.99, ENV_REFS[c][0], ENV_REFS[c][1], color=C["red"], va="bottom", ha="right",
                    transform=ax.get_yaxis_transform(), zorder=5, bbox=WHITE_BOX)
    ax.set_ylabel(ENV_COLS[c])
    ax.set_title(f"({letter})", loc="left", x=-0.02)


def env_stack(e, cols, height, minutes=None, hours=None):
    fig, axes = plt.subplots(len(cols), 1, figsize=fig_size(height), sharex=True, constrained_layout=True,
                             squeeze=False)
    axes = axes[:, 0]
    for ax, c, letter in zip(axes, cols, "abcdef"):
        env_axis(ax, e, c, letter)
    time_axis(axes[-1], minutes=minutes, hours=hours)
    axes[-1].set_xlabel("Local time")
    return fig, axes


def tick_step(e):
    span_min = (e.t.iloc[-1] - e.t.iloc[0]).total_seconds() / 60
    return ({"minutes": 10} if span_min <= 50 else {"minutes": 15} if span_min <= 150
            else {"minutes": 30} if span_min <= 240 else {"hours": 2})


def session_blocks(e, join_gap_min=30):
    """Split env samples into blocks of sessions separated by more than join_gap_min (one panel column each)."""
    blocks, cur = [], []
    for _, g in sorted(e.groupby("session"), key=lambda kv: kv[1].t.iloc[0]):
        if cur and (g.t.iloc[0] - cur[-1].t.iloc[-1]).total_seconds() / 60 > join_gap_min:
            blocks.append(pd.concat(cur))
            cur = []
        cur.append(g)
    blocks.append(pd.concat(cur))
    return blocks


def column_ticks(span_min, width_in):
    """Tick step (minutes) giving at most ~one label per 0.6 in of panel width."""
    for m in (5, 10, 15, 20, 30, 60, 120, 180):
        if span_min / m <= max(width_in / 0.6, 1.5):
            return {"hours": m // 60} if m >= 60 else {"minutes": m}
    return {"hours": 4}


def env_grid(e, cols, height):
    """Like env_stack, but sessions hours apart get their own column (shared y per row) instead of one
    time axis with a long empty stretch between them."""
    blocks = session_blocks(e)
    if len(blocks) == 1:
        return env_stack(e, cols, height, **tick_step(e)), blocks
    dur = np.array([(b.t.iloc[-1] - b.t.iloc[0]).total_seconds() / 60 for b in blocks])
    widths = np.maximum(dur, 0.45 * dur.max())
    fig, axes = plt.subplots(len(cols), len(blocks), figsize=fig_size(height), sharey="row", squeeze=False,
                             constrained_layout=True, gridspec_kw={"width_ratios": widths, "wspace": 0.04})
    plot_w = TEXTWIDTH_IN * 0.85 * widths / widths.sum()
    for j, b in enumerate(blocks):
        for i, c in enumerate(cols):
            ax = axes[i, j]
            env_axis(ax, b, c, "abcdef"[i], ref_label=False)  # named in the caption instead
            ax.set_xlim(b.t.iloc[0], b.t.iloc[-1])
            time_axis(ax, **column_ticks(dur[j], plot_w[j]))
            if j:
                ax.set_ylabel("")
                ax.set_title("", loc="left")
                ax.tick_params(axis="y", left=False)
                ax.spines["left"].set_linestyle((0, (2, 2)))
            if j < len(blocks) - 1:
                ax.spines["right"].set_linestyle((0, (2, 2)))
            if i < len(cols) - 1:
                ax.tick_params(axis="x", labelbottom=False)
        keys = ", ".join(sorted(b.session.unique()))
        axes[0, j].set_title(f"Session {keys}: {b.t.iloc[0]:%H:%M}–{b.t.iloc[-1]:%H:%M}", fontsize=10,
                             loc="right" if j == 0 else "left")
    fig.supxlabel("Local time", fontsize=10.5)
    return (fig, axes[:, 0]), blocks


def plot_env_indoor(day, e, s, keys):
    span = f"session{'s' if len(keys) > 1 else ''} {', '.join(keys)}, {e.t.iloc[0]:%H:%M}--{e.t.iloc[-1]:%H:%M}"
    (fig, ax), blocks = env_grid(e, ["co2_ppm", "pm25"], 3.6)
    if len(blocks) > 1:
        span = "; ".join(rf"session{'s' if b.session.nunique() > 1 else ''} {', '.join(sorted(b.session.unique()))} "
                         rf"{b.t.iloc[0]:%H:%M}--{b.t.iloc[-1]:%H:%M}" for b in blocks)
        span += r"; each indoor period has its own panel column, with the hours between them omitted"
    multi = len(blocks) > 1
    dash = {"air": r" Dashed lines: 1000\,ppm CO$_2$ and the WHO PM$_{2.5}$ 24-h guideline." if multi else "",
            "noise": r" Dashed line: 70\,dBA." if multi else ""}
    for a in fig.axes[len(fig.axes) // 2:] if len(blocks) > 1 else ax[1:]:
        a.set_ylim(0, None)
    save(day, fig, "env_indoor_air",
         rf"Indoor air quality from the environment node (10\,s averages; {span}). (a) CO$_2$, median "
         rf"{s['co2_ppm']['median']:.0f}\,ppm, above 1000\,ppm for {s['pct_time_co2_over_1000']}\,\% of the time. "
         rf"(b) PM$_{{2.5}}$, median {s['pm25']['median']:.0f}\,$\mu$g/m$^3$, above the WHO 24-h guideline "
         rf"(15\,$\mu$g/m$^3$) for {s['pct_time_pm25_over_WHO24h_15']:.0f}\,\% of the time. Line breaks mark "
         r"periods when the node was disconnected." + dash["air"])
    (fig, ax), _ = env_grid(e, ["temp_c", "rh_pct"], 3.6)
    save(day, fig, "env_indoor_thermal",
         rf"Indoor thermal conditions ({span}): (a) air temperature, median {s['temp_c']['median']:.1f}\,°C "
         rf"(5--95th percentile {s['temp_c']['p5']:.1f}--{s['temp_c']['p95']:.1f}\,°C); (b) relative humidity, "
         rf"median {s['rh_pct']['median']:.0f}\,\%.{day.temp_note()}")
    (fig, ax), _ = env_grid(e, ["dba"], 2.4)
    save(day, fig, "env_indoor_noise",
         rf"Indoor A-weighted sound level ({span}), median {s['dba']['median']:.0f}\,dBA "
         rf"(95th percentile {s['dba']['p95']:.0f}\,dBA); above 70\,dBA for {s['pct_time_dba_over_70']:.0f}\,\% "
         r"of the time." + dash["noise"])


def tick_step_narrow(e):
    """Coarser ticks for half-width (two-column) panels."""
    span_min = (e.t.iloc[-1] - e.t.iloc[0]).total_seconds() / 60
    return ({"minutes": 5} if span_min <= 20 else {"minutes": 10} if span_min <= 45
            else {"minutes": 30} if span_min <= 120 else {"hours": 2})


def plot_env_outdoor(day, e, s, sess, prefix="env_walk"):
    fig, axes = plt.subplots(2, 2, figsize=fig_size(4.2), sharex=True, constrained_layout=True)
    trip = prefix == "env_trip"  # in vehicles CO2 build-up matters more than humidity
    cols = ["pm25", "temp_c", "co2_ppm" if trip else "rh_pct", "dba"]
    for ax, c, letter in zip(axes.ravel(), cols, "abcd"):
        env_axis(ax, e, c, letter, ref_label=False)
    axes[0, 0].set_ylim(0, None)
    for ax in axes[1]:
        time_axis(ax, **tick_step_narrow(e))
        ax.set_xlabel("Local time")
    evs = mark_events(day, axes.ravel(), e.t.iloc[0], e.t.iloc[-1], label_ax=axes[0, 0])
    co2 = (r" CO$_2$ is omitted because readings fell below the physically plausible outdoor level of about "
           rf"420\,ppm (minimum {s['co2_ppm']['min']:.0f}\,ppm)." if s["co2_ppm"]["min"] < 400 else
           rf" CO$_2$ (not shown) had a median of {s['co2_ppm']['median']:.0f}\,ppm.")
    if trip:
        co2 = (rf" Panel (c) shows CO$_2$ instead of humidity (median {s['co2_ppm']['median']:.0f}, maximum "
               rf"{s['co2_ppm']['max']:.0f}\,ppm); the sensor reads low outdoors, so the rise inside vehicles is more "
               r"reliable than the absolute level.")
    save(day, fig, f"{prefix}_{sess.key}",
         rf"Environment node during session {sess.key} ({sess.label.lower()}, 10\,s averages): "
         rf"(a) PM$_{{2.5}}$, median {s['pm25']['median']:.0f}\,$\mu$g/m$^3$, peak {s['pm25']['max']:.0f} "
         rf"(dashed: WHO 24-h guideline); (b) temperature, median {s['temp_c']['median']:.1f}\,°C; "
         + (r"(c) CO$_2$; " if trip else rf"(c) relative humidity, median {s['rh_pct']['median']:.0f}\,\%; ") +
         rf"(d) sound level, median "
         rf"{s['dba']['median']:.0f}\,dBA (dashed: 70\,dBA).{co2}{evs}{day.temp_note()}")


def plot_env_overnight(day, e, s, sess, sleep_span):
    fig, axes = plt.subplots(2, 2, figsize=fig_size(4.2), sharex=True, constrained_layout=True)
    overlap = sleep_span and sleep_span[0] < e.t.iloc[-1] and sleep_span[1] > e.t.iloc[0]
    for ax, c, letter in zip(axes.ravel(), ["co2_ppm", "pm25", "temp_c", "dba"], "abcd"):
        if overlap:
            ax.axvspan(sleep_span[0], sleep_span[1], color=C["band"], lw=0, zorder=0)
        env_axis(ax, e, c, letter, ref_label=False)
    axes[0, 1].set_ylim(0, None)
    for ax in axes[1]:
        time_axis(ax, **tick_step(e))
        ax.set_xlabel("Local time")
    axes[0, 0].set_xlim(e.t.iloc[0], e.t.iloc[-1])
    sl = (rf" The grey band marks sleep ({sleep_span[0]:%H:%M}--{sleep_span[1]:%H:%M}) from the wrist band."
          if overlap else rf" The recording ended before sleep began"
          + (rf" ({sleep_span[0]:%H:%M})." if sleep_span else "."))
    save(day, fig, f"env_overnight_{sess.key}",
         rf"Bedroom environment overnight (session {sess.key}, {e.t.iloc[0]:%H:%M}--{e.t.iloc[-1]:%H:%M}, 10\,s "
         rf"averages): (a) CO$_2$, median {s['co2_ppm']['median']:.0f}\,ppm (max {s['co2_ppm']['max']:.0f}); "
         rf"(b) PM$_{{2.5}}$, median {s['pm25']['median']:.0f}\,$\mu$g/m$^3$ (max {s['pm25']['max']:.0f}); "
         rf"(c) temperature, median {s['temp_c']['median']:.1f}\,°C; (d) sound level, median "
         rf"{s['dba']['median']:.0f}\,dBA. Dashed lines: 1000\,ppm CO$_2$, WHO PM$_{{2.5}}$ 24-h guideline, "
         rf"70\,dBA.{sl}{day.temp_note()}")


# =========================================================================== GPS
def analyze_gps(sess, strides):
    gps = sess.read("gps").drop_duplicates()
    gps = gps[gps.accuracy_m <= 20].sort_values("utc_ms").reset_index(drop=True)
    if len(gps) < 3:  # no usable fixes (e.g. indoors or a very short recording)
        return {"gps_fixes": int(len(gps)), "note": "too few accurate GPS fixes"}, None
    lat0 = np.radians(gps.lat.mean())
    gps["x_m"] = np.radians(gps.lon - gps.lon.iloc[0]) * 6_371_000 * np.cos(lat0)
    gps["y_m"] = np.radians(gps.lat - gps.lat.iloc[0]) * 6_371_000
    gps["t"] = to_local(gps.utc_ms)
    seg = np.hypot(np.diff(gps.x_m), np.diff(gps.y_m))
    moving = gps[gps.speed_mps > 0.3]
    res = {"gps_distance_m": round(seg[seg < 30].sum()),  # drop GPS jumps
           "gps_span_min": round((gps.utc_ms.iloc[-1] - gps.utc_ms.iloc[0]) / 60000, 1),
           "gps_start_local": f"{gps.t.iloc[0]:%H:%M}",
           "median_moving_speed_mps": round(moving.speed_mps.median(), 2),
           "weather_temp_c": float(gps.weather_temp_c.dropna().median()),
           "weather_rh_pct": float(gps.weather_rh_pct.dropna().median())}
    if strides is not None and len(strides):
        # stride length = GPS speed (interpolated at each heel strike) * stride time
        sp = np.interp(strides.hs_ms, gps.utc_ms, gps.speed_mps)
        ok = (sp > 0.5) & (strides.hs_ms >= gps.utc_ms.min())
        res["stride_length_m_median"] = round(float(np.median(sp[ok] * strides.stride_s[ok])), 2)
    return res, gps


def plot_route(day, sess, gps, e, g):
    pm = np.interp(gps.utc_ms, e.utc_ms, e.pm25)
    vmax = np.percentile(pm, 98)  # a single spike would wash out the colour scale
    fig, ax = plt.subplots(figsize=fig_size(4.2), constrained_layout=True)
    sc = ax.scatter(gps.x_m, gps.y_m, c=np.minimum(pm, vmax), cmap="Blues", s=15, vmin=min(30, pm.min()), vmax=vmax,
                    edgecolors=C["ink2"], linewidths=0.2)
    span = max(np.ptp(gps.x_m), np.ptp(gps.y_m))
    off = 0.05 * span
    ax.plot(0, 0, marker="o", ms=9, mfc="none", mec=C["ink"], mew=1.5)
    ax.text(0, -off, "Start", va="top", ha="center", bbox=WHITE_BOX)
    xe, ye = gps.x_m.iloc[-1], gps.y_m.iloc[-1]
    ax.plot(xe, ye, marker="s", ms=8, mfc="none", mec=C["ink"], mew=1.5)
    loop = np.hypot(xe, ye) < 2 * off  # ends near the start: put the label on the other side
    ax.text(xe, ye + off, "End", va="bottom", ha="center", bbox=WHITE_BOX) if loop else \
        ax.text(xe - 0.6 * off, ye, "End", va="center", ha="right", bbox=WHITE_BOX)
    ax.set_aspect("equal")
    ax.set(xlabel="East of start (m)", ylabel="North of start (m)")
    fig.colorbar(sc, ax=ax, label="PM$_{2.5}$ (µg/m³)", shrink=0.85, extend="max" if pm.max() > vmax else "neither")
    save(day, fig, f"walk_route_{sess.key}",
         rf"GPS track of session {sess.key} (fixes with accuracy $\leq$20\,m; logging began at "
         rf"{g['gps_start_local']}): {g['gps_distance_m']}\,m in {g['gps_span_min']:.0f}\,min at a median speed of "
         rf"{g['median_moving_speed_mps']:.2f}\,m/s, in metres from the start point, coloured by the PM$_{{2.5}}$ "
         rf"concentration measured by the body-worn environment node (colour scale capped at the 98th percentile, "
         rf"{vmax:.0f}\,$\mu$g/m$^3$; maximum {pm.max():.0f}).")


# =========================================================================== wearable (Health Connect export)
SLEEP_STAGES = {1: "awake", 2: "sleeping", 3: "out_of_bed", 4: "light", 5: "deep", 6: "rem", 7: "awake_in_bed"}
STAGE_Y = {"deep": 0, "light": 1, "rem": 2, "awake": 3, "awake_in_bed": 3, "out_of_bed": 3, "sleeping": 1}
STAGE_COLORS = {"deep": C["violet"], "light": C["blue"], "rem": C["aqua"], "awake": C["orange"]}


def load_wearable(day):
    """Health Connect CSV mixing several apps; repeated syncs append identical rows, so dedupe.

    Sources: gadgetbridge = Xiaomi Smart Band 10 (HR, SpO2, sleep, 1-min steps),
    FitbitMobile, fitness (Google Fit), phone (Android step counter).
    Sources overlap, so totals are reported per source and never summed across them.
    """
    f = day.cfg.get("wearable_file") or sorted(day.base.glob("Fit_*.csv"))[-1].name
    w = pd.read_csv(day.base / f)
    n_raw = len(w)
    w = w.drop_duplicates(subset=["Wall_Clock_Start_ISO", "Wall_Clock_End_ISO", "DataType", "SourceApp", "Value"])
    w["start"] = pd.to_datetime(w.Wall_Clock_Start_ISO, utc=True, format="ISO8601").dt.tz_convert(TZ)
    w["end"] = pd.to_datetime(w.Wall_Clock_End_ISO, utc=True, format="ISO8601").dt.tz_convert(TZ)
    w["src"] = w.SourceApp.str.replace(r"\.jac.*", "", regex=True).str.split(".").str[-1]
    return w, n_raw - len(w)


def analyze_sleep(day, w, hr, spo2):
    ss = w[(w.DataType == "SLEEP_SESSION") & (w.end > day.start) & (w.start < day.start + pd.Timedelta(hours=14))]
    if ss.empty:
        return None, None, None
    # the band re-exports a growing session: among overlapping copies keep the longest; distinct sessions less
    # than 4 h apart are parts of one split night (e.g. asleep, awake for two hours, asleep again)
    parts = []
    for _, s in ss.sort_values("Value", ascending=False).iterrows():
        if not any(s.start < p.end and s.end > p.start for p in parts):
            parts.append(s)
    parts = sorted(parts, key=lambda p: p.start)
    first = max(range(len(parts)), key=lambda i: parts[i].Value)
    night = [parts[first]]
    for p in parts[first + 1:]:
        if (p.start - night[-1].end) <= pd.Timedelta(hours=4):
            night.append(p)
    for p in reversed(parts[:first]):
        if (night[0].start - p.end) <= pd.Timedelta(hours=4):
            night.insert(0, p)
    st = pd.concat([pd.DataFrame(json.loads(p.ExtraJSON)["stages"]) for p in night], ignore_index=True)
    st["start"] = pd.to_datetime(st.startTime, utc=True).dt.tz_convert(TZ)
    st["end"] = pd.to_datetime(st.endTime, utc=True).dt.tz_convert(TZ)
    st["stage"] = st.stage.map(SLEEP_STAGES)
    st["min"] = (st.end - st.start).dt.total_seconds() / 60
    by = st.groupby("stage")["min"].sum()
    asleep = by.drop(labels=["awake", "awake_in_bed", "out_of_bed"], errors="ignore").sum()
    in_bed = sum(p.Value for p in night)
    t0, t1 = night[0].start, night[-1].end
    inside = lambda t: np.any([(t >= p.start) & (t < p.end) for p in night], axis=0)
    hr_sleep = hr[inside(hr.start)].set_index("start").Value
    sp = spo2[inside(spo2.start)].Value
    pct = (100 * by.drop(labels=["awake", "awake_in_bed", "out_of_bed"], errors="ignore") / asleep).round(1)
    return {
        "device": json.loads(night[0].ExtraJSON)["title"],
        "bed_local": f"{t0:%H:%M}", "wake_local": f"{t1:%H:%M}",
        "segments": [f"{p.start:%H:%M}-{p.end:%H:%M}" for p in night],
        "wake_gap_h": round(sum((b.start - a.end).total_seconds() for a, b in zip(night[:-1], night[1:])) / 3600, 2),
        "time_in_bed_h": round(in_bed / 60, 2), "asleep_h": round(asleep / 60, 2),
        "efficiency_pct": round(100 * asleep / in_bed, 1),
        "stage_min": by.round(0).to_dict(), "stage_pct_of_sleep": pct.to_dict(),
        "hr_sleep_mean": round(hr_sleep.mean(), 1),
        "hr_sleep_lowest_10min": round(hr_sleep.rolling("10min").mean().min(), 1),
        "spo2_sleep_mean": round(sp.mean(), 1), "spo2_sleep_min": float(sp.min()) if len(sp) else None,
    }, st, (t0, t1)


def plot_wearable_day(day, mt, sleep_span):
    hrd = mt.hr.dropna()
    fig, ax = plt.subplots(2, 1, figsize=fig_size(4.0), sharex=True, constrained_layout=True,
                           gridspec_kw={"height_ratios": [1.5, 1]})
    for sess in day.sessions:
        for x in ax:
            x.axvspan(sess.start, sess.end, color=C["band"], lw=0, zorder=0)
    # stagger session letters that would collide
    last_x = None
    for sess in day.sessions:
        x = sess.start + (sess.end - sess.start) / 2
        if last_x is not None and (x - last_x) < pd.Timedelta(minutes=50):
            x = last_x + pd.Timedelta(minutes=50)
        ax[0].text(x, 150, sess.key, ha="center", va="bottom", fontweight="bold")
        last_x = x
    # break the line where the band was not worn instead of drawing across the gap
    dt = hrd.index.to_series().diff()
    gap = max(pd.Timedelta(minutes=15), 5 * dt.median()) if len(hrd) > 2 else pd.Timedelta(hours=1)
    hrp = hrd.copy()
    if (dt > gap).any():
        brk = pd.Series(np.nan, index=hrd.index[(dt > gap).values] - pd.Timedelta(seconds=1))
        hrp = pd.concat([hrd, brk]).sort_index()
    ax[0].plot(hrp.index, hrp.values, color=C["red"], lw=0.8)
    ax[0].set(ylabel="Heart rate (bpm)", ylim=(45, 162), title="(a) Heart rate")
    s15 = mt.steps_band.resample("15min").sum()
    ax[1].bar(s15.index, s15.values, width=pd.Timedelta(minutes=13), align="edge", color=C["blue"])
    ax[1].set(ylabel="Steps / 15 min", title="(b) Steps", xlabel="Local time")
    time_axis(ax[1], hours=3)
    ax[1].set_xlim(day.start, hrd.index.max() + pd.Timedelta(minutes=20))
    sl = f"; sleep {sleep_span[0]:%H:%M}--{sleep_span[1]:%H:%M}" if sleep_span else ""
    step_min = float(np.median(np.diff(hrd.index.values).astype("timedelta64[s]").astype(float))) / 60 if len(hrd) > 2 else 1
    rate = r"1\,sample/min" if step_min < 1.5 else rf"one sample every {step_min:.0f}\,min, with some 1-min stretches"
    save(day, fig, "wearable_day",
         rf"Wrist band over day~{day.n}: (a) heart rate ({rate}) and (b) steps per 15\,min{sl}. "
         rf"Grey bands mark the sensor sessions: {day.session_legend()}."
         + (r" Breaks in the heart-rate line are periods with no band data." if (dt > gap).any() else ""))


def plot_sleep(day, mt, stages, span, sl):
    fig, ax = plt.subplots(2, 1, figsize=fig_size(3.6), sharex=True, constrained_layout=True)
    for r in stages.itertuples():
        y = STAGE_Y.get(r.stage, 1)
        ax[0].fill_between([r.start, r.end], y - 0.38, y + 0.38, color=STAGE_COLORS.get(r.stage, C["orange"]), lw=0)
    ax[0].set_yticks(range(4), ["Deep", "Light", "REM", "Awake"])
    ax[0].set(ylim=(-0.6, 3.6), title="(a) Sleep stages")
    ax[0].grid(axis="y", visible=False)
    a, b = span[0] - pd.Timedelta(minutes=20), span[1] + pd.Timedelta(minutes=20)
    h = mt.hr[a:b].dropna()
    ax[1].plot(h.index, h.values, color=C["red"], lw=0.9)
    ax[1].set(ylabel="HR (bpm)", title="(b) Heart rate", xlabel="Local time")
    time_axis(ax[1], hours=1)
    ax[1].set_xlim(a, b)
    p = sl["stage_pct_of_sleep"]
    save(day, fig, "sleep",
         rf"Sleep before day~{day.n} from the wrist band. (a) Hypnogram, {sl['bed_local']}--{sl['wake_local']}: "
         rf"{sl['asleep_h']:.1f}\,h asleep (efficiency {sl['efficiency_pct']:.0f}\,\%), {p.get('light', 0):.0f}\,\% light, "
         rf"{p.get('deep', 0):.0f}\,\% deep and {p.get('rem', 0):.0f}\,\% REM. (b) Heart rate (mean "
         rf"{sl['hr_sleep_mean']:.0f}\,bpm, lowest 10-min mean {sl['hr_sleep_lowest_10min']:.0f}\,bpm)."
         + (rf" SpO$_2$ averaged {sl['spo2_sleep_mean']:.1f}\,\% (minimum {sl['spo2_sleep_min']:.0f}\,\%)."
            if sl.get("spo2_sleep_min") is not None else " The band recorded no SpO$_2$."))


# =========================================================================== hydration (smart-bottle log)
def analyze_hydration(day, extra=None):
    """Drinks from the smart-bottle log (values read off the bottle by the participant), plus drinks detected in
    the bottle's own data stream (extra: rows with local_time, volume_ml, note). The combined list is saved as
    analysis_output/hydration_all.csv for the cross-day comparison."""
    f = day.base / day.cfg.get("hydration_file", "hydration_manual.csv")
    if not f.exists():
        return None, None
    h = pd.read_csv(f)
    if extra is not None and len(extra):
        h = pd.concat([h, extra], ignore_index=True)
    h["t"] = pd.to_datetime(h.local_time).dt.tz_localize(TZ)
    h = h.sort_values("t").reset_index(drop=True)
    h.drop(columns="t").to_csv(day.out / "hydration_all.csv", index=False)
    gaps = h.t.diff().dt.total_seconds() / 3600
    i = gaps.idxmax() if gaps.notna().any() else None  # a single drink has no gap
    walks = [s for s in day.with_stream("gps") if s.context in ("outdoor_walk", "walk")] \
        or [s for s in day.sessions if s.context == "outdoor_walk"]
    res = {
        "total_ml": int(h.volume_ml.sum()), "drinks": int(len(h)), "mean_ml": round(h.volume_ml.mean()),
        "from_bottle_stream_ml": int(extra.volume_ml.sum()) if extra is not None and len(extra) else 0,
        "first": f"{h.t.iloc[0]:%H:%M}", "last": f"{h.t.iloc[-1]:%H:%M}",
        "longest_gap_h": round(gaps.max(), 1) if i is not None else None,
        "longest_gap": f"{h.t.loc[i - 1]:%H:%M}-{h.t.loc[i]:%H:%M}" if i is not None else None,
        "partial": bool(day.cfg.get("hydration_partial")),  # only some drinks reported: no daily totals
        "pct_after_20h": round(100 * h[h.t.dt.hour >= 20].volume_ml.sum() / h.volume_ml.sum(), 1),
    }
    if walks:
        res["ml_before_walk"] = int(h[h.t < walks[0].start].volume_ml.sum())
    # fluid in the 2 h before each walk (participant drank before walks on day 7)
    res["ml_2h_before_walks"] = {s.key: int(h[(h.t < s.start) & (h.t >= s.start - pd.Timedelta(hours=2))].volume_ml.sum())
                                 for s in day.sessions if s.context in WALK_CONTEXTS}
    return res, h


# =========================================================================== event close-ups ("zoom" events)
def gait_timed(sess, side):
    """One insole's samples on the per-connection clock (as in analyze_gait), or None."""
    g = sess.read("gait")
    d = g[g.side == side]
    if d.empty:
        return None
    wins = connection_windows(sess.read("events"), "GAIT" if side == "R" else "GAIT_LEFT", sess.span_ms())
    d = timed_side(d, wins)
    if d is None:
        return None
    d["utc_ms"] = d.t
    return d.reset_index(drop=True)


def plot_event_gait(day, ev, sess, half_s=6):
    """Close-up of a gait event (e.g. a slip): acceleration, foot tilt and pressure of both feet in a window of
    +-half_s around the largest acceleration inside the noted period, and stride times of the surrounding minutes."""
    dr = gait_timed(sess, "R")
    tl = to_local(dr.utc_ms)
    inside = (tl >= ev["start"]) & (tl <= ev["end"])
    acc_r = np.sqrt(dr.Accel_X**2 + dr.Accel_Y**2 + dr.Accel_Z**2)
    centre = tl[acc_r[inside].idxmax()] if inside.any() else ev["start"] + (ev["end"] - ev["start"]) / 2
    t0, t1 = centre - pd.Timedelta(seconds=half_s), centre + pd.Timedelta(seconds=half_s)
    fig = plt.figure(figsize=fig_size(4.2), layout="constrained")
    gs = fig.add_gridspec(4, 1, height_ratios=[1, 0.8, 0.9, 0.9])
    ax = [fig.add_subplot(gs[0])]
    ax += [fig.add_subplot(gs[i], sharex=ax[0]) for i in (1, 2)]
    ax.append(fig.add_subplot(gs[3]))
    res = {"label": ev["label"]}
    for side, c, ls in (("R", C["blue"], "-"), ("L", C["orange"], "--")):
        d = gait_timed(sess, side)
        if d is None:
            continue
        fs = len(d) / max(1e-9, (d.t.iloc[-1] - d.t.iloc[0]) / 1000)
        tl = to_local(d.utc_ms)
        acc = np.sqrt(d.Accel_X**2 + d.Accel_Y**2 + d.Accel_Z**2)
        tilt = pd.Series(lowpass(foot_tilt(d), fs))
        m = (tl >= t0) & (tl <= t1)
        lab = "Right" if side == "R" else "Left"
        if m.sum() < 10:
            res[f"{side}_samples"] = 0
            continue
        x, y = gapped(tl[m], acc[m], max_gap_s=0.5)
        ax[0].plot(x, y, color=c, lw=0.9, ls=ls, label=lab)
        x, y = gapped(tl[m], tilt[m], max_gap_s=0.5)
        ax[1].plot(x, y, color=c, lw=1.3, ls=ls)
        if side == "R":
            for col, cc, l2 in (("Heel_FSR", C["blue"], "-"), ("Met1_FSR", C["orange"], "--"), ("Met5_FSR", C["aqua"], ":")):
                x, y = gapped(tl[m], d.loc[m, col], max_gap_s=0.5)
                ax[2].plot(x, y, color=cc, ls=l2, lw=1.1, label=col.replace("_FSR", ""))
        inside = (tl >= ev["start"]) & (tl <= ev["end"])
        if inside.any():
            k = acc[inside].idxmax()
            res[f"{side}_peak_acc_ms2"] = round(float(acc[k]), 1)
            res[f"{side}_peak_time"] = f"{tl[k]:%H:%M:%S}"
        f = day.out / f"strides_{sess.key}_{side}.csv"
        if f.exists():
            s = pd.read_csv(f)
            res[f"{side}_median_stride_peak_acc_ms2"] = round(float(s.peak_acc_ms2.median()), 1)
            ts = to_local(s.hs_ms)
            w = (ts >= ev["start"] - pd.Timedelta(minutes=2)) & (ts <= ev["end"] + pd.Timedelta(minutes=2))
            ax[3].plot(ts[w], s.stride_s[w], "o" if side == "R" else "^", color=c, ms=3.5, label=lab)
    for a in ax[:3]:
        a.axvline(centre, color=C["red"], lw=1, ls=":", zorder=0)
    ax[3].axvspan(ev["start"], ev["end"], color=C["yellow"], alpha=0.3, lw=0, zorder=0)
    if res.get("R_peak_acc_ms2"):
        ax[0].annotate(f"{ev['label']}: {res['R_peak_acc_ms2']:.0f} m/s²", (centre, res["R_peak_acc_ms2"]),
                       xytext=(8, -4), textcoords="offset points", va="top", color=C["red"], fontsize=10,
                       bbox=WHITE_BOX)
    ax[0].set(ylabel="Accel. (m/s²)", title=f"(a) Foot acceleration")
    ax[0].set_ylim(0, None)
    ax[0].legend(loc="upper left", ncol=2, fontsize=9.5)
    ax[1].set(ylabel="Tilt (°)", title="(b) Foot tilt from flat")
    ax[2].set(ylabel="FSR (counts)", title="(c) Right-foot pressure", xlim=(t0, t1), ylim=(0, 5600))
    ax[2].legend(loc="upper left", ncol=3, fontsize=9.5)
    for a in ax[:2]:
        a.tick_params(axis="x", labelbottom=False)
    ax[2].xaxis.set_major_locator(mdates.SecondLocator(bysecond=range(0, 60, 2), tz=TZ))
    ax[2].xaxis.set_major_formatter(mdates.DateFormatter("%H:%M:%S", tz=TZ))
    ax[3].set(ylabel="Stride (s)", title="(d) Stride times, 2 min either side", xlabel="Local time")
    time_axis(ax[3], minutes=1)
    pk = res.get("R_peak_acc_ms2")
    txt = (rf" The right foot's acceleration peaked at {pk:.1f}\,m/s$^2$ at {res['R_peak_time']}, against a median "
           rf"heel-strike peak of {res['R_median_stride_peak_acc_ms2']:.1f}\,m/s$^2$ over the walk." if pk else "")
    save(day, fig, f"event_{ev['label'].split()[0].lower()}",
         rf"Close-up of the {ev['label']} noted by the participant (session {sess.key}). (a)--(c): {2 * half_s}\,s centred "
         r"on the largest acceleration inside the noted period (dotted line): (a) acceleration magnitude of each foot; "
         r"(b) foot tilt away from the loaded flat position; (c) right-foot pressure sensors. (d) Stride time of every "
         rf"detected stride in the 2 minutes before and after; shaded: noted period ({ev['start']:%H:%M:%S}--"
         rf"{ev['end']:%H:%M:%S}), whose strides are excluded from the gait analysis.{txt} A foot without a line was "
         r"disconnected.")
    return res


def plot_event_env(day, ev, pad_min=2.5):
    """Close-up of an exposure event: particle size fractions, CO2, temperature and sound at 10-s resolution."""
    t0, t1 = ev["start"] - pd.Timedelta(minutes=pad_min), ev["end"] + pd.Timedelta(minutes=pad_min)
    ss = [s for s in day.with_stream("environment") if s.start <= t1 and s.end >= t0]
    e = load_env(day, ss)
    e = e[(e.t >= t0) & (e.t <= t1)]
    if len(e) < 5:
        return None
    fig, axes = plt.subplots(2, 2, figsize=fig_size(3.9), sharex=True, constrained_layout=True)
    a = axes.ravel()
    for col, c, ls, lab in (("pm1", C["violet"], ":", "PM$_1$"), ("pm25", C["blue"], "-", "PM$_{2.5}$"),
                            ("pm10", C["orange"], "--", "PM$_{10}$")):
        x, y = gapped(e.t, e[col])
        a[0].plot(x, y, color=c, ls=ls, lw=1.5, label=lab)
    a[0].set(ylabel="µg/m³", title="(a) Particles")
    a[0].legend(loc="upper right", fontsize=9.5)
    for ax_, col, lab, letter in ((a[1], "co2_ppm", "CO$_2$ (ppm)", "b"), (a[2], "temp_c", "Temp. (°C)", "c"),
                                  (a[3], "dba", "Sound (dBA)", "d")):
        x, y = gapped(e.t, e[col])
        ax_.plot(x, y, color=C["blue"], lw=1.4)
        ax_.set(ylabel=lab, title=f"({letter})")
    for ax_ in a:
        ax_.axvspan(ev["start"], ev["end"], color=C["yellow"], alpha=0.25, lw=0, zorder=0)
    for ax_ in axes[1]:
        time_axis(ax_, minutes=2 if pad_min * 2 < 10 else 5)
        ax_.set_xlabel("Local time")
    inside = e[(e.t >= ev["start"]) & (e.t <= ev["end"])]
    k = inside.pm25.idxmax()
    res = {"label": ev["label"], "pm25_max": float(inside.pm25.max()), "pm10_max": float(inside.pm10.max()),
           "pm1_max": float(inside.pm1.max()), "peak_time": f"{e.t[k]:%H:%M:%S}",
           "pm1_share_at_peak_pct": round(100 * float(e.pm1[k] / e.pm10[k]), 0),
           "co2_before": float(e[e.t < ev["start"]].co2_ppm.median()), "co2_max": float(e.co2_ppm.max()),
           "pm25_before": float(e[e.t < ev["start"]].pm25.median()),
           "pm25_after": float(e[e.t > ev["end"]].pm25.median())}
    sat = " The three size fractions reached the same value (3{,}333), the sensor's ceiling, so the true peak was higher." \
        if res["pm25_max"] >= 3300 else ""
    save(day, fig, f"event_{ev['label'].split()[0].lower().replace('-', '')}",
         rf"Close-up of the {ev['label']} (shaded, {ev['start']:%H:%M:%S}--{ev['end']:%H:%M:%S}), environment node at 10\,s "
         rf"resolution. PM$_{{2.5}}$ rose from about {res['pm25_before']:.0f} to {res['pm25_max']:,.0f}\,$\mu$g/m$^3$ at "
         rf"{res['peak_time']} and was back at {res['pm25_after']:.0f}\,$\mu$g/m$^3$ within minutes; CO$_2$ rose from "
         rf"{res['co2_before']:.0f} to {res['co2_max']:,.0f}\,ppm.{sat}{day.temp_note()}")
    return res


# =========================================================================== smart bottle (hydration node)
def bottle_plateaus(t, w, tol_g=3.0, min_n=20, max_gap_s=10):
    """Stable stretches of the bottle weight: >= min_n samples whose 20-sample range is within tol_g, not
    spanning a data gap. Neighbouring plateaus closer than 4 g are merged (slow drift of the load cell)."""
    t, w = pd.Series(t).reset_index(drop=True), pd.Series(w, dtype=float).reset_index(drop=True)
    run = (t.diff().dt.total_seconds() > max_gap_s).cumsum()
    rng = w.groupby(run).transform(lambda v: v.rolling(min_n, center=True, min_periods=min_n // 2).max()
                                   - v.rolling(min_n, center=True, min_periods=min_n // 2).min())
    stable = (rng <= tol_g).fillna(False)
    blk = (stable != stable.shift()).cumsum() + run * 10_000
    ps = []
    for _, g in w[stable].groupby(blk[stable]):
        if len(g) >= min_n:
            ps.append({"t0": t[g.index[0]], "t1": t[g.index[-1]], "level": float(g.median()), "n": len(g)})
    merged = []
    for p in ps:
        if merged and abs(p["level"] - merged[-1]["level"]) < 4:
            m = merged[-1]
            m.update(t1=p["t1"], level=(m["level"] * m["n"] + p["level"] * p["n"]) / (m["n"] + p["n"]), n=m["n"] + p["n"])
        else:
            merged.append(dict(p))
    return merged


def analyze_bottle(day, hyd=None):
    """Smart-bottle channels: Fused_mL (the node's fused estimate, main channel: the load cell while the bottle
    stands on it, a capacitive estimate while it is lifted), Weight_g (load cell) and Cap_mL (capacitive level;
    a reading of 500 mL is the sensor's invalid/saturated value and is discarded).

    Content changes are the steps between stable Fused plateaus: increases are fills/pours (never intake),
    decreases are removals. A removal is a drink if a logged drink is within 10 min, or if day_config sets
    "bottle_removals_are_drinks" (participant confirmed). Known reference pours ("bottle_checks") test each channel.
    """
    sess = day.with_stream("hydration")
    if not sess:
        return None, None
    h = pd.concat([s.read("hydration") for s in sess])
    h = h[h.offline == 0]  # replayed offline records carry no reliable time
    h = h.assign(t=to_local(h.utc_ms.fillna(h.rx_ms))).sort_values("t").reset_index(drop=True)
    if len(h) < 60:
        return None, None
    cap_invalid = h.Cap_mL >= 499.5
    h["Cap_mL"] = h.Cap_mL.where(~cap_invalid)
    pl = bottle_plateaus(h.t, h.Fused_mL)
    # while the bottle is lifted off the load cell, Fused holds a capacitive estimate: not a resting level
    pl = [p for p in pl if not (h[(h.t >= p["t0"]) & (h.t <= p["t1"])].Weight_g.median() < 2 and p["level"] > 5)]
    ser ={c: h.set_index("t")[c] for c in ("Weight_g", "Cap_mL")}
    removals_ok = bool(day.cfg.get("bottle_removals_are_drinks"))
    events = []
    for a, b in zip(pl[:-1], pl[1:]):
        d = b["level"] - a["level"]
        if abs(d) < 8:
            continue
        between = h[(h.t > a["t1"]) & (h.t < b["t0"])]
        diff = {c: float(s[b["t0"]:b["t1"]].median() - s[a["t0"]:a["t1"]].median()) for c, s in ser.items()}
        tev = b["t0"] if d > 0 else a["t1"]  # a drink starts when the bottle leaves the load cell
        ev = {"time": f"{tev:%H:%M:%S}", "t": tev, "before_ml": round(a["level"], 1), "after_ml": round(b["level"], 1),
              "change_ml": round(d, 1), "kind": "added" if d > 0 else "removed",
              "lifted": bool(len(between) and between.Weight_g.min() < 2 and min(a["level"], b["level"]) > 5),
              "weight_change_g": round(diff["Weight_g"], 1),
              "cap_change_ml": None if np.isnan(diff["Cap_mL"]) else round(diff["Cap_mL"], 1)}
        if d < 0:
            near = hyd[(hyd.t - b["t0"]).abs() <= pd.Timedelta(minutes=10)] if hyd is not None else []
            ev["logged_drink_ml"] = int(near.volume_ml.sum()) if len(near) else None
            ev["counted_as_drink"] = bool(ev["logged_drink_ml"] is None and removals_ok)
        events.append(ev)
    checks = []
    for c in day.cfg.get("bottle_checks", []):
        tc = pd.Timestamp(f"{day.cfg['date']} {c['time']}", tz=TZ)
        cand = [e for e in events if e["kind"] == "added" and abs((e["t"] - tc).total_seconds()) <= 180]
        row = {"label": c["label"], "time": c["time"], "reference_g": c["grams"]}
        if cand:
            e = cand[0]
            for k, v in (("fused", e["change_ml"]), ("weight", e["weight_change_g"]), ("cap", e["cap_change_ml"])):
                row[k] = v
                row[f"{k}_err_pct"] = None if v is None else round(100 * (v - c["grams"]) / c["grams"], 1)
        checks.append(row)
    longest = max(pl, key=lambda p: (p["t1"] - p["t0"]).total_seconds())
    seg = h[(h.t >= longest["t0"]) & (h.t <= longest["t1"])]
    res = {"window": f"{h.t.iloc[0]:%H:%M}-{h.t.iloc[-1]:%H:%M}", "samples": int(len(h)),
           "events": [{k: v for k, v in e.items() if k != "t"} for e in events], "checks": checks,
           "drift_ml": round(float(seg.Fused_mL.quantile(0.95) - seg.Fused_mL.quantile(0.05)), 1),
           "cap_drift_ml": round(float(seg.Cap_mL.quantile(0.95) - seg.Cap_mL.quantile(0.05)), 1),
           "drift_window": f"{longest['t0']:%H:%M}-{longest['t1']:%H:%M}",
           "cap_invalid_pct": round(100 * float(cap_invalid.mean()), 1)}
    res["drinks_from_stream"] = [{"time": e["time"][:5], "ml": round(-e["change_ml"])} for e in events
                                 if e.get("counted_as_drink")]
    return res, (h, pl, events)


def bottle_extra_drinks(day, res):
    """Drinks detected in the bottle stream (counted removals) as rows for the hydration log."""
    if not res or not res.get("drinks_from_stream"):
        return None
    return pd.DataFrame([{"local_time": f"{day.cfg['date']} {d['time']}", "volume_ml": d["ml"],
                          "note": "smart-bottle stream (removal)"} for d in res["drinks_from_stream"]])


def plot_bottle(day, res, data):
    h, pl, events = data
    fig, ax = plt.subplots(2, 1, figsize=fig_size(3.9), sharex=True, constrained_layout=True,
                           gridspec_kw={"height_ratios": [1.6, 1]})
    t, fz = gapped(h.t, h.Fused_mL, max_gap_s=10)
    _, c = gapped(h.t, h.Cap_mL, max_gap_s=10)
    top = max(p["level"] for p in pl) * 1.45 + 15
    ax[0].plot(t, fz.clip(upper=top), color=C["blue"], lw=1.3)
    for p in pl:
        ax[0].plot([p["t0"], p["t1"]], [p["level"]] * 2, color=C["ink"], lw=3, solid_capstyle="butt", alpha=0.55)
    for e in events:
        x = pd.Timestamp(f"{day.cfg['date']} {e['time']}", tz=TZ)
        ref = next((ck for ck in res["checks"] if ck.get("fused") == e["change_ml"]), None)
        txt = f"{e['change_ml']:+.0f} mL" + (f" (ref. {ref['reference_g']} g)" if ref else
                                             " (drink)" if e.get("counted_as_drink") or e.get("logged_drink_ml") else "")
        added = e["kind"] == "added"
        ax[0].annotate(txt, (x, max(e["before_ml"], e["after_ml"])), xytext=(-5 if added else 5, 6),
                       textcoords="offset points", ha="right" if added else "left", va="bottom", fontsize=10,
                       color=C["green"] if added else C["red"], bbox=WHITE_BOX)
    ax[0].set(ylabel="Fused content (mL)", ylim=(-5, top), title="(a) Fused estimate (main channel)")
    ax[1].plot(t, c, color=C["orange"], lw=1.2)
    inval = h.Cap_mL.isna() & h.Weight_g.notna()
    ax[1].plot(h.t[inval], np.full(int(inval.sum()), 188.0), "|", color=C["red"], ms=6, alpha=0.5)
    ax[1].text(0.99, 0.95, "| = invalid 500 mL reading (removed)", transform=ax[1].transAxes, va="top", ha="right",
               color=C["red"], fontsize=9.5)
    ax[1].set(ylabel="Level (mL)", ylim=(-5, 200), xlabel="Local time", title="(b) Capacitive level sensor")
    time_axis(ax[1], minutes=15 if (h.t.iloc[-1] - h.t.iloc[0]).total_seconds() < 7200 else 30)
    c0 = res["checks"][0] if res["checks"] else None
    chk_txt = (rf" Test: {c0['reference_g']}\,g poured at {c0['time']} was measured as {c0['fused']:.1f}\,mL by the fused "
               rf"estimate ({c0['fused_err_pct']:+.1f}\,\%), {c0['weight']:.1f}\,g by the load cell and {c0['cap']:.0f}\,mL by "
               rf"the level sensor ({c0['cap_err_pct']:+.0f}\,\%)." if c0 and c0.get("fused") is not None else "")
    save(day, fig, "bottle",
         rf"Smart-bottle node ({res['window'].replace('-', '--')}, 1\,s samples; line breaks = disconnected). (a) Fused "
         r"content estimate; dark bars: stable plateaus; labels: content change between plateaus (green: added, red: "
         r"removed). Short spikes while the bottle was handled are clipped. (b) Capacitive level sensor; readings of "
         rf"500\,mL are the sensor's invalid value and were removed ({res['cap_invalid_pct']:.0f}\,\% of samples)." + chk_txt +
         rf" Drift at constant content ({res['drift_window'].replace('-', '--')}, 5--95th percentile): fused "
         rf"{res['drift_ml']:.1f}\,mL, level sensor {res['cap_drift_ml']:.0f}\,mL.")


def plot_hydration(day, h, hs):
    fig, ax = plt.subplots(figsize=fig_size(3.0), constrained_layout=True)
    for sess in day.sessions:
        ax.axvspan(sess.start, sess.end, color=C["band"], lw=0, zorder=0)
    x0 = min(day.start + pd.Timedelta(hours=8), h.t.iloc[0].floor("h"))
    t = pd.concat([pd.Series([x0]), h.t, pd.Series([day.end])])
    cum = np.concatenate([[0], h.volume_ml.cumsum(), [h.volume_ml.sum()]])
    ax.step(t, cum, where="post", color=C["blue"], lw=1.8)
    stream = h.note.astype(str).str.contains("stream") if "note" in h else pd.Series(False, index=h.index)
    ax.plot(h.t[~stream], h.volume_ml.cumsum()[~stream], "o", color=C["blue"], ms=5)
    if stream.any():
        ax.plot(h.t[stream], h.volume_ml.cumsum()[stream], "D", mfc="white", mec=C["blue"], mew=1.5, ms=6)
    ax.axhspan(2000, 2500, color=C["aqua"], alpha=0.18, lw=0)
    ax.text(x0 + pd.Timedelta(minutes=12), 2250, "EFSA adequate total water intake", va="center")
    ax.set(ylabel="Cumulative intake (mL)", xlabel="Local time", ylim=(0, 2750), xlim=(x0, day.end))
    time_axis(ax, hours=2)
    walk_txt = f" {hs['ml_before_walk']}\\,mL was consumed before the first walk." if "ml_before_walk" in hs else ""
    st_txt = (rf" Open diamonds: drinks detected in the bottle's data stream ({hs['from_bottle_stream_ml']}\,mL)."
              if hs.get("from_bottle_stream_ml") else "")
    partial = (r" Only the drink before the walk was reported for this day, so the total is not the day's intake."
               if hs.get("partial") else "")
    gap_txt = (rf" Longest gap without drinking: {hs['longest_gap_h']:.0f}\,h ({hs['longest_gap'].replace('-', '--')})."
               if hs.get("longest_gap") else "")
    save(day, fig, "hydration",
         rf"Cumulative fluid intake from the smart-bottle log ({hs['drinks']} drinks, {hs['total_ml']}\,mL).{st_txt}{partial} "
         r"Grey bands mark the sensor sessions; the shaded band is the EFSA adequate intake for total water "
         rf"(2.0--2.5\,L/day, including water from food).{walk_txt}{gap_txt}")


# =========================================================================== per-minute merged table
def minute_table(day, hr, band_steps, strides, env, gps, segs, stages, sleep_span, hyd, strides_left=None):
    idx = pd.date_range(day.start, day.end - pd.Timedelta(minutes=1), freq="1min")
    mt = pd.DataFrame(index=idx)
    mt.index.name = "minute"
    mt["hr"] = hr.set_index("start").Value.resample("1min").mean().reindex(idx)
    # band logs 1-min step records only for active minutes; worn (HR present) + no record = 0
    bs = band_steps.set_index("start").Value.resample("1min").sum().reindex(idx)
    mt["steps_band"] = bs.where(bs.notna(), np.where(mt.hr.notna(), 0, np.nan))
    for col in ("steps_insole", "stride_time_s", "stance_pct"):
        mt[col] = np.nan
    for key, s in strides.items():
        sess = next(x for x in day.sessions if x.key == key)
        # only minutes while the right insole was actually recording (first to last detected stride)
        t0, t1 = to_local(s.hs_ms).min().floor("1min"), to_local(s.hs_ms).max().floor("1min")
        left = strides_left.get(key) if strides_left else None
        if left is not None and len(left):  # extend to the left insole's coverage when it recorded longer
            t0 = min(t0, to_local(left.hs_ms).min().floor("1min"))
            t1 = max(t1, to_local(left.hs_ms).max().floor("1min"))
        rng = mt.index[(mt.index >= max(sess.start.floor("1min"), t0)) & (mt.index <= min(sess.end.floor("1min"), t1))]
        m = to_local(s.hs_ms).dt.floor("1min")
        n_r = s.groupby(m).size().reindex(rng, fill_value=0)
        if left is not None and len(left):
            # steps = 2 x strides of whichever insole detected more strides in that minute (one may drop out)
            n_l = left.groupby(to_local(left.hs_ms).dt.floor("1min")).size().reindex(rng, fill_value=0)
            n_r = np.maximum(n_r, n_l)
        mt.loc[rng, "steps_insole"] = (2 * n_r).values
        mt.loc[rng, "stride_time_s"] = s.groupby(m).stride_s.median().reindex(rng).values
        # IMU stance: valid on every day, unlike pressure stance after the Met1 replacement
        mt.loc[rng, "stance_pct"] = s.groupby(m).stance_imu_pct.median().reindex(rng).values
    if env is not None:
        em = env.set_index("t")[list(ENV_COLS)].astype(float).resample("1min").mean()
        mt = mt.join(em, how="left")
    else:
        for c in ENV_COLS:
            mt[c] = np.nan
    mt["gps_speed_mps"] = (gps.set_index("t").speed_mps.resample("1min").mean().reindex(idx)
                           if gps is not None else np.nan)
    mt["posture"] = None
    if segs is not None:
        for r in segs.itertuples():
            mid = mt.index + pd.Timedelta(seconds=30)
            mt.loc[(mid >= ms_ts(r.start)) & (mid < ms_ts(r.end)), "posture"] = r.pose
    mt["sleep_stage"] = None
    if stages is not None:
        for r in stages.itertuples():
            mid = mt.index + pd.Timedelta(seconds=30)
            mt.loc[(mid >= r.start) & (mid < r.end), "sleep_stage"] = r.stage
    mt["water_ml"] = (hyd.set_index("t").volume_ml.resample("1min").sum().reindex(idx, fill_value=0)
                      if hyd is not None else np.nan)
    # wrist optical HR can lock onto the arm-swing/step rhythm while walking and report cadence instead of heart
    # rate; flag runs (>= 2 consecutive minutes) where HR is within 6 bpm of the insole step rate
    match = (mt.steps_insole >= 80) & ((mt.hr - mt.steps_insole).abs() <= 6)
    mt["hr_cadence_lock"] = match & (match.shift(1, fill_value=False) | match.shift(-1, fill_value=False))
    mt["event"] = None
    for e in day.events:
        mt.loc[e["start"]:e["end"], "event"] = e["label"]
    mt["session"] = None
    mt["context"] = np.where(mt.hr.notna(), "awake", None)
    if sleep_span:
        mt.loc[sleep_span[0]:sleep_span[1], "context"] = "sleep"
    for sess in day.sessions:
        mt.loc[sess.start:sess.end, "session"] = sess.key
        if sess.context != "overnight":  # overnight env sessions keep the sleep/awake context
            mt.loc[sess.start:sess.end, "context"] = sess.context
    mt.to_csv(day.out / "minute_table.csv")
    return mt


# =========================================================================== relationships
def analyze_hr_steps(mt):
    aw = mt[(mt.context != "sleep") & mt.context.notna() & mt.hr.notna() & mt.steps_band.notna()]
    rho = aw.hr.corr(aw.steps_band, method="spearman")
    hr_aw = mt.hr.where((mt.context != "sleep") & mt.context.notna())
    lags = range(-5, 16)
    xc = pd.Series([hr_aw.corr(mt.steps_band.shift(k)) for k in lags], index=list(lags))
    bins = pd.cut(aw.steps_band, [-0.1, 0, 30, 60, 90, 300], labels=["0", "1–30", "31–60", "61–90", ">90"])
    return {
        "awake_minutes": int(len(aw)), "spearman_rho": r2(rho),
        "peak_lag_min": int(xc.idxmax()), "peak_lag_r": r2(xc.max()), "r_lag0": r2(xc.loc[0]),
        "hr_median_by_steps_bin": aw.groupby(bins, observed=True).hr.median().round(1).to_dict(),
        "n_by_steps_bin": aw.groupby(bins, observed=True).size().to_dict(),
    }, aw, bins, xc


def plot_hr_steps(day, aw, bins, xc, res):
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.1), constrained_layout=True)
    groups = [aw.hr[bins == b].values for b in bins.cat.categories]
    keep = [i for i, g in enumerate(groups) if len(g)]
    bp = ax[0].boxplot([groups[i] for i in keep], widths=0.6, showfliers=False, patch_artist=True,
                       medianprops={"color": C["ink"], "lw": 1.6})
    for p in bp["boxes"]:
        p.set(facecolor=C["band"], edgecolor=C["ink2"])
    ax[0].set_xticks(range(1, len(keep) + 1), [bins.cat.categories[i] for i in keep])
    ax[0].set(xlabel="Steps per minute", ylabel="Heart rate (bpm)", title="(a) HR by step rate")
    ax[0].grid(axis="x", visible=False)
    ax[1].axhline(0, color=C["ink2"], lw=0.8)
    ax[1].axvline(0, color=C["ink2"], lw=0.8, ls=":")
    ax[1].plot(xc.index, xc.values, "o-", color=C["blue"], ms=4)
    ax[1].plot(res["peak_lag_min"], res["peak_lag_r"], "o", ms=9, mfc="none", mec=C["ink"], mew=1.4)
    ax[1].set(xlabel="Lag of HR behind steps (min)", ylabel="Pearson r", title="(b) Cross-correlation")
    ns = ", ".join(f"{k}: {v}" for k, v in res["n_by_steps_bin"].items())
    save(day, fig, "hr_steps",
         rf"Heart-rate response to stepping (wrist band, {res['awake_minutes']} awake minutes). (a) Heart rate "
         rf"grouped by the number of steps in the same minute (minutes per group: {ns}); Spearman "
         rf"$\rho={res['spearman_rho']:.2f}$. (b) Correlation between heart rate and step count shifted by "
         rf"$-5$ to $+15$\,min; the strongest association ($r={res['peak_lag_r']:.2f}$) occurs when heart rate lags "
         rf"steps by {res['peak_lag_min']}\,min (circled). Minute samples are autocorrelated, so no $p$-values "
         r"are reported.")


CONTEXT_NAMES = {"gait_test": "Gait tests", "indoor": "Indoor sitting", "outdoor_walk": "Walking",
                 "walk": "Walking", "transport": "Transport", "awake": "Other awake"}


def analyze_hr_context(mt):
    lab = mt.context.map(CONTEXT_NAMES)
    st = mt.sleep_stage.map({"deep": "Sleep: deep", "light": "Sleep: light", "rem": "Sleep: REM"})
    lab = st.where(mt.context == "sleep", lab)
    order = ["Sleep: deep", "Sleep: light", "Sleep: REM", "Indoor sitting", "Other awake", "Transport",
             "Gait tests", "Walking"]
    order = [o for o in order if (lab == o).any() and mt.hr[lab == o].notna().sum() >= 3]
    res = {o: {"n_min": int(mt.hr[lab == o].notna().sum()), "median": round(mt.hr[lab == o].median(), 1),
               "iqr": [round(mt.hr[lab == o].quantile(.25), 1), round(mt.hr[lab == o].quantile(.75), 1)]}
           for o in order}
    return res, lab, order


def plot_hr_context(day, mt, lab, order, res):
    fig, ax = plt.subplots(figsize=fig_size(3.4), constrained_layout=True)
    data = [mt.hr[lab == o].dropna().values for o in order]
    bp = ax.boxplot(data, vert=False, widths=0.6, showfliers=False, patch_artist=True,
                    medianprops={"color": C["ink"], "lw": 1.6})
    for p, o in zip(bp["boxes"], order):
        p.set(facecolor=C["violet"] if o.startswith("Sleep") else C["band"], edgecolor=C["ink2"],
              alpha=0.35 if o.startswith("Sleep") else 1)
    ax.set_yticks(range(1, len(order) + 1), [f"{o} ({res[o]['n_min']})" for o in order])
    ax.set(xlabel="Heart rate (bpm)")
    ax.grid(axis="y", visible=False)
    save(day, fig, "hr_context",
         r"Heart rate by context over the day (minutes per context in brackets). Sleep stages come from the "
         r"wrist band; awake contexts come from the sensor sessions (gait tests, indoor sitting with the "
         r"environment node, walking sessions) and all remaining awake minutes. Boxes show "
         r"the inter-quartile range and median; whiskers extend to 1.5\,IQR.")


CORR_LABELS = {"co2_ppm": "CO$_2$", "pm25": "PM$_{2.5}$", "pm10": "PM$_{10}$", "temp_c": "Temp.", "rh_pct": "RH",
               "dba": "Sound", "hr": "HR", "steps_insole": "Cadence", "stride_time_s": "Stride time",
               "stance_pct": "Stance", "gps_speed_mps": "Speed"}


def corr_matrix(df, min_n=10):
    r = df.corr(method="spearman", min_periods=min_n)
    v = df.notna().astype(int)
    n = v.T @ v
    return r, n


def plot_corr(day, df, name, caption):
    df = df.loc[:, df.notna().sum() >= 10]
    if df.shape[1] < 3:  # not enough overlapping data for a correlation map
        return None
    r, n = corr_matrix(df)
    cols = list(df.columns)
    k = len(cols)
    vals = r.values[1:, :-1]
    mask = np.triu(np.ones((k - 1, k - 1), bool), 1)
    fig, ax = plt.subplots(figsize=fig_size(4.2), constrained_layout=True)
    im = ax.imshow(np.ma.array(vals, mask=mask | np.isnan(vals)), cmap=DIVERGING, vmin=-1, vmax=1)
    for i in range(k - 1):
        for j in range(i + 1):
            v = vals[i, j]
            if np.isnan(v):
                continue
            txt = f"{v:.2f}".replace("0.", ".")
            ax.text(j, i, txt, ha="center", va="center", fontsize=10,
                    color="white" if abs(v) > 0.6 else C["ink"])
    ax.set_xticks(range(k - 1), [CORR_LABELS[c] for c in cols[:-1]], rotation=40, ha="right")
    ax.set_yticks(range(k - 1), [CORR_LABELS[c] for c in cols[1:]])
    ax.grid(False)
    for s in ax.spines.values():
        s.set_visible(False)
    fig.colorbar(im, ax=ax, label=r"Spearman $\rho$", shrink=0.85)
    nmin, nmax = int(n.values[np.tril_indices(k, -1)].min()), int(n.values[np.tril_indices(k, -1)].max())
    save(day, fig, name, caption + rf" Spearman rank correlations of 1-min means ($n={nmin}$--{nmax} minutes per "
                                   r"pair). Minute samples are autocorrelated, so coefficients are descriptive and "
                                   r"no $p$-values are reported.")
    return {f"{a}~{b}": r2(r.loc[a, b]) for i, a in enumerate(cols) for b in cols[:i]}


def analyze_agreement(mt, gait_keys):
    m = mt[mt.session.isin(gait_keys) & mt.steps_insole.notna() & mt.steps_band.notna()]
    diff = m.steps_insole - m.steps_band
    mean = (m.steps_insole + m.steps_band) / 2
    return {"minutes": int(len(m)), "insole_total": int(m.steps_insole.sum()), "band_total": int(m.steps_band.sum()),
            "bias": round(diff.mean(), 1), "loa_low": round(diff.mean() - 1.96 * diff.std(), 1),
            "loa_high": round(diff.mean() + 1.96 * diff.std(), 1),
            "pearson_r": r2(m.steps_insole.corr(m.steps_band))}, m, mean, diff


def plot_agreement(day, m, mean, diff, a):
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.1), constrained_layout=True)
    hi = max(m.steps_insole.max(), m.steps_band.max()) * 1.08
    ax[0].plot([0, hi], [0, hi], color=C["ink2"], lw=1, ls="--")
    for key, mk, c in zip(sorted(m.session.unique()), "osD^", (C["blue"], C["orange"], C["aqua"], C["violet"])):
        g = m[m.session == key]
        ax[0].plot(g.steps_band, g.steps_insole, mk, ms=5, color=c, alpha=0.8, label=key)
    ax[0].set(xlim=(-6, hi), ylim=(-6, hi), xlabel="Band (steps/min)", ylabel="Insole (steps/min)",
              title="(a) Per-minute steps")
    ax[0].set_aspect("equal")
    ax[0].legend(title="Session", loc="upper left", handletextpad=0.2)
    ax[1].plot(mean, diff, "o", ms=4.5, color=C["blue"], alpha=0.8)
    for y, ls in ((a["bias"], "-"), (a["loa_low"], "--"), (a["loa_high"], "--")):
        ax[1].axhline(y, color=C["ink"], lw=1, ls=ls)
    ax[1].text(0.98, a["loa_high"], f"+1.96 SD: {a['loa_high']:.0f}", transform=ax[1].get_yaxis_transform(),
               ha="right", va="bottom", bbox=WHITE_BOX)
    ax[1].text(0.98, a["loa_low"], f"−1.96 SD: {a['loa_low']:.0f}", transform=ax[1].get_yaxis_transform(),
               ha="right", va="top", bbox=WHITE_BOX)
    ax[1].set(xlabel="Mean of both (steps/min)", ylabel="Insole − band", title="(b) Bland–Altman")
    save(day, fig, "agreement",
         rf"Agreement between insole-derived steps (2\,$\times$ the strides of the insole with more detections in each "
         rf"minute) and wrist-band steps for "
         rf"every minute of the gait sessions ({a['minutes']} minutes; totals {a['insole_total']} vs "
         rf"{a['band_total']}). (a) Per-minute counts with the line of identity ($r={a['pearson_r']:.2f}$). "
         rf"(b) Bland--Altman plot: mean difference {a['bias']:+.1f}\,steps/min (solid), 95\,\% limits of "
         rf"agreement {a['loa_low']:.0f} to {a['loa_high']:.0f}\,steps/min (dashed).")


def plot_walk_steps_hr(day, mt, sess):
    w = mt.loc[sess.start.floor("1min"):sess.end.floor("1min")]
    fig, ax = plt.subplots(2, 1, figsize=fig_size(3.8), sharex=True, constrained_layout=True)
    ax[0].plot(w.index, w.steps_insole, color=C["blue"], marker="o", ms=4.5, label="Insole")
    ax[0].plot(w.index, w.steps_band, color=C["orange"], marker="s", ms=4.5, ls="--", label="Wrist band")
    ax[0].set(ylabel="Steps/min", title="(a) Step rate", ylim=(0, max(175, w[["steps_insole", "steps_band"]].max().max() * 1.1)))
    ax[0].legend(loc="upper left", ncol=2)
    ax[1].plot(w.index, w.hr, color=C["red"], marker="o", ms=4.5)
    lk = w[w.hr_cadence_lock]
    if len(lk):
        ax[1].plot(lk.index, lk.hr, "o", ms=8, mfc="white", mec=C["ink"], mew=1.5, label="Possible cadence lock")
        ax[1].legend(loc="lower right")
    ax[1].set(ylabel="HR (bpm)", title="(b) Heart rate", xlabel="Local time")
    time_axis(ax[1], minutes=5)
    evs = mark_events(day, ax, sess.start, sess.end, label_ax=ax[0])
    save(day, fig, f"walk_steps_hr_{sess.key}",
         rf"Session {sess.key} ({sess.label.lower()}) minute by minute: (a) step rate from the insoles "
         r"(2\,$\times$ the strides of whichever insole detected more in that minute) and the wrist band; (b) wrist-band heart rate (mean "
         rf"{w.hr.mean():.0f}\,bpm)."
         + (rf" Open circles: {int(w.hr_cadence_lock.sum())} minutes in which the band's heart rate was within 6\,bpm "
            r"of the step rate for at least two consecutive minutes, a sign that the optical sensor may have locked "
            r"onto the walking rhythm instead of the pulse." if w.hr_cadence_lock.any() else "")
         + evs)


# =========================================================================== left vs right insole
def connection_windows(ev, node, span=None):
    """(start, end) rx_ms of every BLE connection of one node within a session (clipped to span if given)."""
    start = ev.loc[ev.event == "session_start", "rx_ms"].iloc[0]
    stops = ev.loc[ev.event == "session_stop", "rx_ms"]
    # a recording that ended abnormally has no session_stop event: fall back to the session span or last event
    stop = stops.iloc[-1] if len(stops) else (span[1] if span else ev.rx_ms.max())
    wins, conn = [], None
    for r in ev[ev.node == node].itertuples():
        if r.event in ("status_at_start_connected", "connected"):
            conn = start if r.event != "connected" else r.rx_ms
        elif r.event == "disconnected" and conn is not None:
            wins.append((conn, r.rx_ms))
            conn = None
    if conn is not None:
        wins.append((conn, stop))
    if span:
        wins = [(max(a, span[0]), min(b, span[1])) for a, b in wins if b > span[0] and a < span[1]]
    return wins


def timed_side(df, wins):
    """Re-time one insole: node clock + min-delay offset fitted per BLE connection.

    The node clock (device_ms) restarts on reconnection and the app's session-wide ClockSync can rest on very
    few samples, so each connection gets its own offset = min(rx_ms - device_ms).
    """
    out = []
    for i, (a, b) in enumerate(wins):
        s = df[(df.rx_ms >= a - 2000) & (df.rx_ms <= b + 2000)].sort_values("device_ms").copy()
        if len(s) < 2:
            continue
        s["t"] = s.device_ms + clock_offset(s)
        s["conn"] = i
        out.append(s)
    return pd.concat(out).sort_values("t").drop_duplicates("t").reset_index(drop=True) if out else None


def clock_offset(s):
    """Phone-minus-node clock offset for one connection, as a lower envelope of rx_ms - device_ms.

    Connections longer than 2 min get a linear fit to the per-30-s latency floor, which removes crystal drift
    between node and phone (measured at 8-21 ppm, i.e. up to ~45 ms over 35 min); shorter ones a constant.
    A constant difference in minimum radio latency between two nodes cannot be seen from timestamps alone.
    """
    lat = (s.rx_ms - s.device_ms).to_numpy(float)
    dev = s.device_ms.to_numpy(float)
    if dev.max() - dev.min() < 120_000:
        return np.full(len(s), lat.min())
    w = ((dev - dev.min()) // 30_000).astype(int)
    floor = pd.Series(lat).groupby(w).min()
    centre = pd.Series(dev).groupby(w).median()
    a, b = np.polyfit(centre.values, floor.values, 1)
    off = a * dev + b
    return off - max(0.0, (off - lat).max())  # keep the line at or below every sample's latency


def stream_quality(df, wins):
    conn_s = sum(b - a for a, b in wins) / 1000
    dt = np.diff(df.t.to_numpy())
    span = (df.t.max() - df.t.min())
    return {"samples": int(len(df)), "connections": len(wins), "connected_s": round(conn_s),
            "rate_hz": round(len(df) / conn_s, 1) if conn_s else None,
            "coverage_pct": round(100 * dt[dt <= 20].sum() / span, 1) if span else 0.0}


def foot_tilt(df):
    """Foot tilt (deg) relative to the foot's flat, loaded orientation; independent of IMU mounting and heading.

    Gravity direction in the sensor frame comes from the orientation quaternion; the reference is the median
    gravity direction while the foot is loaded (flat foot), so the angle is the foot's rotation away from flat.
    """
    x, y, z, w = (df[c].to_numpy(float) for c in ("Quat_I", "Quat_J", "Quat_K", "Quat_Real"))
    gs = np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], axis=1)
    gs /= np.linalg.norm(gs, axis=1, keepdims=True)
    load = df[["Heel_FSR", "Met1_FSR", "Met5_FSR"]].sum(axis=1).to_numpy(float)
    ref = np.median(gs[load >= np.percentile(load, 75)], axis=0)
    ref /= np.linalg.norm(ref)
    return np.degrees(np.arccos(np.clip(gs @ ref, -1, 1)))


def _shift(rc, lc):
    """Bins by which the left curve lags the right one (circular, sub-bin by parabolic interpolation)."""
    n = len(rc)
    r = np.array([np.corrcoef(rc, np.roll(lc, -k))[0, 1] for k in range(n)])
    k = int(np.nanargmax(r))
    y0, y1, y2 = r[k - 1], r[k], r[(k + 1) % n]
    den = y0 - 2 * y1 + y2
    return (k + (0.5 * (y0 - y2) / den if den else 0)) % n, float(y1)


def analyze_left_right(day, sess, nbins=40, n_boot=300):
    g = sess.read("gait")
    if (g.side == "L").sum() < 200 or (g.side == "R").sum() < 200:
        return None
    ev = sess.read("events")
    wl, wr = connection_windows(ev, "GAIT_LEFT", sess.span_ms()), connection_windows(ev, "GAIT", sess.span_ms())
    L, R = timed_side(g[g.side == "L"], wl), timed_side(g[g.side == "R"], wr)
    res = {"session": sess.key, "quality": {"L": stream_quality(L, wl), "R": stream_quality(R, wr)}}
    s, _, _ = detect_strides(R.assign(utc_ms=R.t), len(R) / ((R.t.max() - R.t.min()) / 1000))
    s = s[(s.stride_s >= 0.8) & (s.stride_s <= 1.6)].reset_index(drop=True)  # steady walking strides
    hs, T = s.hs_ms.to_numpy(), s.stride_s.to_numpy() * 1000

    def place(df):
        """Gait-cycle phase (0-1 of the concurrent right stride) and stride index for every sample."""
        i = np.searchsorted(hs, df.t.to_numpy()) - 1
        ok = i >= 0
        i = np.clip(i, 0, len(hs) - 1)
        ph = (df.t.to_numpy() - hs[i]) / T[i]
        ok &= (ph >= 0) & (ph < 1)
        load = df[["Heel_FSR", "Met1_FSR", "Met5_FSR"]].sum(axis=1).to_numpy(float)
        lo, hi = np.percentile(load, [5, 95])
        acc = np.sqrt(df.Accel_X**2 + df.Accel_Y**2 + df.Accel_Z**2).to_numpy(float)
        return pd.DataFrame({"stride": i, "phase": ph, "load": (load - lo) / (hi - lo), "tilt": foot_tilt(df),
                             "acc": acc})[ok]

    pl, pr = place(L), place(R)
    res["left_samples_in_steady_strides"] = int(len(pl))
    res["strides_with_left_samples"] = int(pl.stride.nunique())
    for nbins in (nbins, nbins // 2):  # coarser bins when left data are sparse
        counts = np.bincount(np.minimum((pl.phase * nbins).astype(int), nbins - 1), minlength=nbins)
        if counts.min() >= 5:
            break
    if len(pl) < 400 or counts.min() < 5:
        res["note"] = "too few left-insole samples spread over the gait cycle for a left/right comparison"
        return res, None
    res["bins"] = nbins
    for d in (pl, pr):
        d["bin"] = np.minimum((d.phase * nbins).astype(int), nbins - 1)
    curves = {side: d.groupby("bin")[["load", "tilt", "acc"]].mean() for side, d in (("L", pl), ("R", pr))}
    # left/right lag from two signals: the heel-strike acceleration (independent of how each insole's pressure
    # sensors respond; primary) and the summed plantar load (secondary)
    est = {sig: _shift(curves["R"][sig].values, curves["L"][sig].values) for sig in ("acc", "load")}
    rng = np.random.default_rng(0)  # bootstrap over right strides (cluster resampling)
    ids = pl.stride.unique()
    by_l, by_r = dict(tuple(pl.groupby("stride"))), dict(tuple(pr[pr.stride.isin(ids)].groupby("stride")))
    boots = {sig: [] for sig in est}
    for _ in range(n_boot):
        pick = rng.choice(ids, len(ids))
        bl = pd.concat([by_l[i] for i in pick]).groupby("bin")[["acc", "load"]].mean().reindex(range(nbins))
        br = pd.concat([by_r[i] for i in pick if i in by_r]).groupby("bin")[["acc", "load"]].mean().reindex(range(nbins))
        if bl.notna().all().all() and br.notna().all().all():
            for sig in est:
                boots[sig].append(_shift(br[sig].values, bl[sig].values)[0])

    def ci(sig):
        k = est[sig][0]
        dev = (np.array(boots[sig]) - k + nbins / 2) % nbins - nbins / 2
        lo, hi = (100 * (k + np.percentile(dev, q)) / nbins for q in (2.5, 97.5))
        pt = 100 * k / nbins  # percentile intervals can miss a biased point estimate: widen to include it
        return [round(min(lo, pt), 1), round(max(hi, pt), 1)]

    valid = est["acc"][1] >= 0.8  # left and right impact curves must match in shape to read a lag from them
    rom = {side: float(c.tilt.max() - c.tilt.min()) for side, c in curves.items()}
    res.update({
        "phase_shift_pct": round(100 * est["acc"][0] / nbins, 1) if valid else None,
        "phase_shift_ci95_pct": ci("acc") if valid else None,
        "shape_r_acc": r2(est["acc"][1]),
        "phase_shift_load_pct": round(100 * est["load"][0] / nbins, 1), "phase_shift_load_ci95_pct": ci("load"),
        "shape_r_load": r2(est["load"][1]), "bootstrap_n": int(len(boots["acc"])),
        "right_stride_s_median": round(float(np.median(T)) / 1000, 3),
        "tilt_rom_deg": {k2: round(v, 1) for k2, v in rom.items()},
        "tilt_rom_diff_deg": round(rom["L"] - rom["R"], 1),
        "clock_note": "per-connection min-delay offsets; residual L/R clock error is estimated at a few tens of ms",
    })
    return res, curves


def plot_left_right(day, results):
    all_sessions = [k for k, (r, c) in results.items() if c is not None]
    for chunk_i in range(0, max(len(all_sessions), 1), 2):  # at most two sessions per A4 figure
        _plot_lr_chunk(day, results, all_sessions[chunk_i:chunk_i + 2], chunk_i // 2)
    _plot_lr_quality(day, results)


def _plot_lr_chunk(day, results, sessions, part):
    if sessions:
        fig, axes = plt.subplots(3, len(sessions), figsize=fig_size(4.2), sharex=True, layout="constrained",
                                 squeeze=False)
        rows = (("load", "Load (norm.)"), ("acc", "Accel. (m/s²)"), ("tilt", "Tilt (°)"))
        for j, key in enumerate(sessions):
            r, c = results[key]
            x = (np.arange(len(c["R"])) + 0.5) / len(c["R"]) * 100
            for i, (col, ylab) in enumerate(rows):
                ax = axes[i, j]
                ax.plot(x, c["R"][col], color=C["blue"], lw=1.8, label="Right")
                ax.plot(x, c["L"][col], color=C["orange"], lw=1.6, ls="--", marker="o", ms=2.5, label="Left")
                if j == 0:
                    ax.set_ylabel(ylab)
                ax.set_title(f"({'abcdefghi'[i * len(sessions) + j]})" + (f" Session {key}" if i == 0 else ""),
                             loc="left")
            if r["phase_shift_pct"] is not None:
                axes[1, j].axvline(r["phase_shift_pct"], color=C["ink2"], lw=1, ls=":")
            axes[-1, j].set_xlabel("Right gait cycle (%)")
            axes[-1, j].set_xticks([0, 25, 50, 75, 100])
        h, l = axes[0, 0].get_legend_handles_labels()
        fig.legend(h, l, loc="outside upper right", ncol=2)

        def txt(k):
            r = results[k][0]
            lag = (rf"left impact lags right by {r['phase_shift_pct']:.0f}\,\% of the cycle (95\,\% CI "
                   rf"{r['phase_shift_ci95_pct'][0]:.0f}--{r['phase_shift_ci95_pct'][1]:.0f}\,\%)"
                   if r["phase_shift_pct"] is not None else
                   rf"left and right acceleration curves do not match (shape $r={r['shape_r_acc']:.2f}$), so no lag "
                   r"is estimated")
            return (rf"session {k}: {lag}; load-based lag {r['phase_shift_load_pct']:.0f}\,\%; tilt range "
                    rf"L {r['tilt_rom_deg']['L']:.0f}° vs R {r['tilt_rom_deg']['R']:.0f}°; "
                    rf"{r['left_samples_in_steady_strides']} left samples in {r['strides_with_left_samples']} strides")
        save(day, fig, "lr_cycle" if part == 0 else f"lr_cycle_{part + 1}",
             r"Left versus right foot over the right-foot gait cycle (0\,\% = right heel strike). Every left sample "
             r"was placed at its phase within the concurrent right stride (steady strides of 0.8--1.6\,s) and "
             r"averaged in 40 phase bins (20 when data were sparse), so the method also works when the left insole "
             r"delivers only bursts of data. Top: summed plantar load, normalised per insole. Middle: acceleration "
             r"magnitude, whose heel-strike peak gives the left/right lag (dotted line; 50\,\% is symmetric) "
             r"independently of how each insole's pressure sensors respond. Bottom: foot tilt from each insole's "
             r"orientation, independent of sensor mounting. Results: " + "; ".join(txt(k) for k in sessions) + ".")


def _plot_lr_quality(day, results):
    keys = list(results)
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.0), layout="constrained")
    x = np.arange(len(keys))
    for i, (metric, ylab, title) in enumerate((("rate_hz", "Samples/s while connected", "(a) Sampling rate"),
                                               ("coverage_pct", "Time with dense data (%)", "(b) Coverage"))):
        for dx, side, c, h in ((-0.18, "R", C["blue"], ""), (0.18, "L", C["orange"], "///")):
            v = [results[k][0]["quality"][side][metric] or 0 for k in keys]
            ax[i].bar(x + dx, v, width=0.34, color=c, hatch=h, edgecolor="white", label="Right" if side == "R" else "Left")
            for xi, vi in zip(x + dx, v):
                ax[i].text(xi, vi, f"{vi:.0f}", ha="center", va="bottom")
        ax[i].set_xticks(x, keys)
        ax[i].set_xlabel("Session")
        ax[i].set(ylabel=ylab, title=title)
        ax[i].set_ylim(0, max(ax[i].get_ylim()[1], 10) * 1.12)
        ax[i].grid(axis="x", visible=False)
    h, l = ax[0].get_legend_handles_labels()
    fig.legend(h, l, loc="outside upper center", ncol=2)
    save(day, fig, "lr_quality",
         r"Data delivered by the right and left insoles in each session with both feet: (a) average sampling "
         r"rate while the node was connected (nominal about 112\,Hz) and (b) share of the recording covered by "
         r"densely sampled data (consecutive samples $\leq$20\,ms apart). The left insole's low coverage limits "
         r"the left/right comparison to cycle-averaged timing and shape.")


# =========================================================================== bilateral (both insoles streaming fully)
# stance/swing from IMU gait events (impact -> IMU toe-off): same definition on both feet, unaffected by the
# pressure sensors; the pressure-based versions are kept as a secondary check (PRESSURE_STANCE)
BI_MEASURES = [("stride_s", "Stride time"), ("stance_imu_s", "Stance time"), ("swing_imu_s", "Swing time"),
               ("stance_imu_pct", "Stance (% stride)"), ("pushoff_pct", "Push-off timing"),
               ("tilt_range_deg", "Foot-tilt range")]
PRESSURE_STANCE = ("stance_s", "swing_s", "stance_pct")


def steady(s, tol=0.15):
    """Steady-walking strides: bouts of >= 10 strides without their first/last two, and only strides within
    +-15 % of the local (11-stride) median, which removes split or merged strides from detection errors."""
    n = s.groupby("bout").bout.transform("size")
    pos = s.groupby("bout").cumcount()
    s = s[(n >= 10) & (pos >= 2) & (pos < n - 2)]
    med = s.groupby("bout").stride_s.transform(lambda x: x.rolling(11, center=True, min_periods=5).median())
    return s[(s.stride_s - med).abs() <= tol * med]


def analyze_bilateral(day, sess, Ls, Rs, health=None):
    """Stride-level left/right comparison when both insoles streamed fully.

    Every right stride is paired with the left stride whose heel strike falls inside it; only pairs in which both
    strides pass the steady-walking filter are kept, so both feet are compared over exactly the same strides.
    Per-foot measures (stride, stance, swing time, stance %, tilt range) use only that foot's own clock and are
    unaffected by the unknown latency difference between the nodes; the step phase needs both clocks.
    """
    L, R = steady(Ls), steady(Rs)
    hs_r, hs_l = Rs.hs_ms.to_numpy(), Ls.hs_ms.to_numpy()
    j = np.searchsorted(hs_l, hs_r)
    keep_l, keep_r = set(L.index), set(R.index)
    rows = []
    for i in range(len(Rs)):
        k = j[i]
        if k < len(hs_l) and hs_l[k] < hs_r[i] + 1000 * Rs.stride_s.iloc[i] and i in keep_r and k in keep_l:
            rows.append({"hs_ms": hs_r[i], "phase": (hs_l[k] - hs_r[i]) / (1000 * Rs.stride_s.iloc[i]),
                         "i_R": i, "i_L": k})
    pairs = pd.DataFrame(rows)
    pairs = pairs[(pairs.phase > 0.2) & (pairs.phase < 0.8)].reset_index(drop=True)
    PL, PR = Ls.loc[pairs.i_L].reset_index(drop=True), Rs.loc[pairs.i_R].reset_index(drop=True)
    res = {"session": sess.key, "paired_strides": int(len(pairs)), "measures": {}, "pressure_stance": {}}
    for col in [c for c, _ in BI_MEASURES] + list(PRESSURE_STANCE):
        l, r = PL[col].median(), PR[col].median()
        res["measures" if col not in PRESSURE_STANCE else "pressure_stance"][col] = {
            "L": round(float(l), 3), "R": round(float(r), 3), "si_pct": round(float(100 * (l - r) / ((l + r) / 2)), 1)}
    # IMU minus pressure toe-off per foot (ms): shows how each insole's pressure sensors place toe-off
    res["toeoff_imu_minus_fsr_ms"] = {k: round(float((d.to_imu_ms - d.to_fsr_ms).median())) for k, d in (("L", PL), ("R", PR))}
    res["cv_pct"] = {k: round(float(100 * d.stride_s.std() / d.stride_s.mean()), 1) for k, d in (("L", PL), ("R", PR))}
    # inter-foot timing from the accelerometer impact at heel strike (independent of pressure-sensor behaviour)
    T_imu = PR.hs_imu_ms.shift(-1) - PR.hs_imu_ms
    T_imu = np.where((pairs.i_R.shift(-1) == pairs.i_R + 1), T_imu, 1000 * PR.stride_s)
    pairs["phase_imu"] = (PL.hs_imu_ms - PR.hs_imu_ms) / T_imu
    pairs.loc[(pairs.phase_imu <= 0.2) | (pairs.phase_imu >= 0.8), "phase_imu"] = np.nan
    res["step_phase_median_pct"] = round(float(100 * pairs.phase_imu.median()), 1)
    res["step_phase_iqr_pct"] = [round(float(100 * pairs.phase_imu.quantile(q)), 1) for q in (.25, .75)]
    res["step_phase_fsr_median_pct"] = round(float(100 * pairs.phase.median()), 1)
    # pressure-based heel strike minus impact: a per-foot check of how the pressure sensors respond
    w = ((pairs.hs_ms - pairs.hs_ms.min()) // 300_000).astype(int)
    res["fsr_minus_impact_ms_per_5min"] = {
        k: [round(float(v)) for v in (d.hs_ms - d.hs_imu_ms).groupby(w).median()] for k, d in (("L", PL), ("R", PR))}
    res["stride_LR_corr"] = r2(PL.stride_s.corr(PR.stride_s))
    res["load_share_pct"] = {k: [round(100 * d[c].mean(), 1) for c in ("heel_share", "met1_share", "met5_share")]
                             for k, d in (("L", PL), ("R", PR))}
    # pressure toe-off (end of stance) is set by the first-metatarsal sensor, which unloads last; with Met1 faulty
    # or replaced by a different type, the pressure-based stance and swing are not valid (the IMU ones still are)
    replaced = day.cfg.get("stance_invalid_sides", [])  # sensor swapped for a different type (participant note)
    if replaced:
        for col in PRESSURE_STANCE:
            res["pressure_stance"][col]["valid"] = False
        res["note"] = f"pressure stance/swing not valid: first-metatarsal sensor replaced by a different type ({', '.join(replaced)})"
        res["forefoot_faulty_pct"] = {k: (100 if k in replaced else 0) for k in ("L", "R")}
    elif health is not None and len(health):
        bad = health[health.sensor == "Met1"].groupby("side").status.apply(lambda v: (v != "ok").mean())
        res["forefoot_faulty_pct"] = {k: round(100 * float(v)) for k, v in bad.items()}
        if (bad > 0.25).any():
            for col in PRESSURE_STANCE:
                res["pressure_stance"][col]["valid"] = False
            res["note"] = "pressure stance/swing not valid: first-metatarsal sensor faulty in >25 % of moving minutes"
    out = pd.concat([pairs, PL.add_prefix("L_"), PR.add_prefix("R_")], axis=1)
    out.to_csv(day.out / f"bilateral_pairs_{sess.key}.csv", index=False)
    return res, PL.assign(hs_ms=PL.hs_ms), PR, pairs


def plot_bilateral(day, sess, res, L, R, pairs):
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.2), constrained_layout=True, gridspec_kw={"width_ratios": [1.25, 1]})
    cols = [("stride_s", "Stride"), ("stance_imu_s", "Stance"), ("swing_imu_s", "Swing")]
    for i, (col, lab) in enumerate(cols):
        for dx, d, c, h in ((-0.18, L, C["orange"], "///"), (0.18, R, C["blue"], "")):
            bp = ax[0].boxplot([d[col].values], positions=[i + dx], widths=0.32, showfliers=False, patch_artist=True,
                               medianprops={"color": C["ink"], "lw": 1.5})
            bp["boxes"][0].set(facecolor=c, hatch=h, edgecolor=C["ink2"], alpha=0.85)
    ax[0].set_xticks(range(len(cols)), [lab for _, lab in cols])
    ax[0].set(ylabel="Time (s)", title="(a) Phase durations")
    ax[0].grid(axis="x", visible=False)
    ax[0].legend([plt.Rectangle((0, 0), 1, 1, fc=C["orange"], hatch="///", ec=C["ink2"]),
                  plt.Rectangle((0, 0), 1, 1, fc=C["blue"], ec=C["ink2"])], ["Left", "Right"], loc="upper right")
    labels = [lab for _, lab in BI_MEASURES]
    si = [res["measures"][c]["si_pct"] for c, _ in BI_MEASURES]
    valid = [True] * len(BI_MEASURES)  # all BI_MEASURES are IMU- or stride-based
    y = np.arange(len(si))
    ax[1].axvspan(-5, 5, color=C["band"], lw=0)
    ax[1].barh(y, si, height=0.55, color=[(C["orange"] if v > 0 else C["blue"]) if ok else "#c8c6bf"
                                          for v, ok in zip(si, valid)])
    for yi, v in zip(y, si):
        ax[1].text(v + (0.6 if v >= 0 else -0.6), yi, f"{v:+.1f}", va="center", ha="left" if v >= 0 else "right")
    ax[1].axvline(0, color=C["ink"], lw=0.8)
    ax[1].set_yticks(y, [l.replace(" (% stride)", " %") for l in labels])
    lim = max(12, max(abs(v) for v in si) * 1.5)
    ax[1].set(xlim=(-lim, lim), xlabel="Symmetry index (%)", title="(b) Left vs right")
    ax[1].invert_yaxis()
    ax[1].grid(axis="y", visible=False)
    m, p = res["measures"], res["pressure_stance"]
    p_ok = all(v.get("valid", True) for v in p.values())
    save(day, fig, f"bilateral_{sess.key}",
         rf"Stride-level comparison of the left and right foot during session {sess.key} "
         rf"({res['paired_strides']} paired strides: each right stride with the left stride that begins inside it; "
         r"strides deviating more than 15\,\% from the local median were excluded as detection errors). (a) Stride, stance "
         r"and swing durations per foot. (b) Symmetry index $\mathrm{SI}=100\,(L-R)/\overline{LR}$ of the medians "
         r"(positive: larger on the left); the grey band marks $\pm5$\,\%. Stance and swing are bounded by IMU gait "
         r"events (heel-strike impact to IMU toe-off), defined identically on both feet and independent of the pressure "
         rf"sensors. Medians, left vs right: stride {m['stride_s']['L']:.3f} vs {m['stride_s']['R']:.3f}\,s, stance "
         rf"{m['stance_imu_s']['L']:.3f} vs {m['stance_imu_s']['R']:.3f}\,s ({m['stance_imu_pct']['L']:.1f} vs "
         rf"{m['stance_imu_pct']['R']:.1f}\,\% of stride), swing {m['swing_imu_s']['L']:.3f} vs "
         rf"{m['swing_imu_s']['R']:.3f}\,s, foot-tilt range {m['tilt_range_deg']['L']:.0f}° vs {m['tilt_range_deg']['R']:.0f}°. "
         rf"Pressure-based stance for comparison: {p['stance_pct']['L']:.1f} vs {p['stance_pct']['R']:.1f}\,\%"
         + (r" (right not valid: first-metatarsal sensor replaced by a different type)" if day.cfg.get("stance_invalid_sides")
            else r" (not valid: first-metatarsal sensor faulty)" if not p_ok else "") + ".")

    fig, ax = plt.subplots(2, 1, figsize=fig_size(3.8), sharex=True, constrained_layout=True)
    for d, c, ls, lab in ((L, C["orange"], "--", "Left"), (R, C["blue"], "-", "Right")):
        t = to_local(d.hs_ms)
        med = d.stride_s.groupby(t.dt.floor("1min").values).median()
        ax[0].plot(pd.to_datetime(med.index).tz_localize("UTC").tz_convert(TZ) if med.index.tz is None else med.index,
                   med.values, color=c, ls=ls, marker="o", ms=3.5, label=lab)
    ax[0].set(ylabel="Stride time (s)", title="(a) Stride time, per-minute median")
    ax[0].legend(loc="upper right", ncol=2)
    tp = to_local(pairs.hs_ms)
    ax[1].plot(tp, 100 * pairs.phase_imu, "o", ms=2, color=C["violet"], alpha=0.35, mew=0)
    minute = tp.dt.floor("1min").values
    pm = (100 * pairs.phase_imu).groupby(minute).median()
    pf = (100 * pairs.phase).groupby(minute).median()
    ax[1].plot(pf.index, pf.values, color=C["orange"], lw=1.4, ls="--", label="Pressure-based")
    ax[1].plot(pm.index, pm.values, color=C["ink"], lw=1.8, label="Impact-based")
    ax[1].axhline(50, color=C["ink2"], lw=1, ls=":")
    ax[1].legend(loc="lower left", ncol=2)
    ax[1].set(ylabel="Left heel strike\n(% right stride)", title="(b) Step phase", ylim=(30, 70), xlabel="Local time")
    time_axis(ax[1], minutes=5)
    save(day, fig, f"bilateral_time_{sess.key}",
         rf"Left and right foot over session {sess.key}. (a) Per-minute median stride time of each foot; the curves "
         rf"coincide, confirming that the two independently timed insoles agree (paired-stride correlation "
         rf"$r={res['stride_LR_corr']:.2f}$). (b) Timing of each left heel strike within the concurrent right stride "
         r"with heel strikes taken from the accelerometer impact (dots and solid line: per-minute median; overall "
         rf"{res['step_phase_median_pct']:.0f}\,\%) or from the pressure sensors (dashed; overall "
         rf"{res['step_phase_fsr_median_pct']:.0f}\,\%); 50\,\% is symmetric. The pressure-based estimate drifts because the "
         r"delay between pressure-detected heel strike and impact changed during the session on the left insole "
         rf"({', '.join(str(v) for v in res['fsr_minus_impact_ms_per_5min']['L'])}\,ms in successive 5-min blocks; right: "
         rf"{', '.join(str(v) for v in res['fsr_minus_impact_ms_per_5min']['R'])}\,ms). Clock drift is corrected; a constant "
         r"radio-latency difference of a few tens of milliseconds between the nodes cannot be excluded.")


# =========================================================================== metrics / latex
def daily_metrics(day, S):
    g = lambda *ks: _dig(S, ks)
    walk = S.get("primary_walk")
    m = {"day": day.n, "date": str(day.start.date()),
         "sleep_asleep_h": g("wearable", "sleep", "asleep_h"), "sleep_efficiency_pct": g("wearable", "sleep", "efficiency_pct"),
         "sleep_deep_pct": g("wearable", "sleep", "stage_pct_of_sleep", "deep"),
         "sleep_rem_pct": g("wearable", "sleep", "stage_pct_of_sleep", "rem"),
         "sleep_light_pct": g("wearable", "sleep", "stage_pct_of_sleep", "light"),
         "sleep_hr_mean": g("wearable", "sleep", "hr_sleep_mean"), "sleep_hr_min10": g("wearable", "sleep", "hr_sleep_lowest_10min"),
         "sleep_spo2_mean": g("wearable", "sleep", "spo2_sleep_mean"),
         "hr_awake_mean": g("wearable", "hr_awake", "mean"), "hr_awake_max": g("wearable", "hr_awake", "max"),
         "hr_min_over_120": g("wearable", "hr_awake", "minutes_over_120"),
         "steps_band": g("wearable", "steps_day_by_source", "gadgetbridge"),
         "steps_phone": g("wearable", "steps_day_by_source", "phone"),
         "steps_fitbit": g("wearable", "steps_day_by_source", "FitbitMobile"),
         "steps_googlefit": g("wearable", "steps_day_by_source", "fitness"),
         "hr_steps_rho": g("relations", "hr_steps", "spearman_rho"),
         "hr_steps_lag_min": g("relations", "hr_steps", "peak_lag_min"),
         "insole_band_bias": g("relations", "agreement", "bias"),
         "posture_monitored_min": g("posture", "monitored_min"),
         "posture_upright_pct": g("posture", "pct_upright_straight"),
         "posture_slouch_pct": g("posture", "pct_by_pose", "SLOUCH"),
         "posture_change_min": g("posture", "median_bout_min"),
         "indoor_co2_median": g("environment", "indoor", "co2_ppm", "median"),
         "indoor_pm25_median": g("environment", "indoor", "pm25", "median"),
         "indoor_temp_median": g("environment", "indoor", "temp_c", "median"),
         "indoor_rh_median": g("environment", "indoor", "rh_pct", "median"),
         "indoor_dba_median": g("environment", "indoor", "dba", "median"),
         "outdoor_pm25_median": g("environment", "outdoor_walk", "pm25", "median"),
         "outdoor_dba_median": g("environment", "outdoor_walk", "dba", "median"),
         "overnight_co2_median": g("environment", "overnight", "co2_ppm", "median"),
         "overnight_pm25_median": g("environment", "overnight", "pm25", "median"),
         "overnight_temp_median": g("environment", "overnight", "temp_c", "median"),
         "overnight_dba_median": g("environment", "overnight", "dba", "median"),
         "hydration_ml": None if g("hydration", "partial") else g("hydration", "total_ml"),
         "hydration_drinks": None if g("hydration", "partial") else g("hydration", "drinks"),
         "hydration_longest_gap_h": None if g("hydration", "partial") else g("hydration", "longest_gap_h")}
    if walk:
        m.update({"walk_cadence": g("gait", walk, "R", "cadence_steps_per_min"),
                  "walk_stride_s": g("gait", walk, "R", "stride_time_s_median"),
                  "walk_stride_cv_pct": g("gait", walk, "R", "stride_time_cv_pct"),
                  "walk_stance_pct": g("gait", walk, "R", "stance_imu_pct_median"),
                  "walk_stance_L_pct": g("gait", walk, "L", "stance_imu_pct_median"),
                  "walk_swing_s": g("gait", walk, "R", "swing_imu_s_median"),
                  "walk_swing_L_s": g("gait", walk, "L", "swing_imu_s_median"),
                  "walk_stance_fsr_pct": g("gait", walk, "R", "stance_pct_median"),
                  "walk_pushoff_pct": g("gait", walk, "R", "pushoff_pct_median"),
                  "walk_pushoff_L_pct": g("gait", walk, "L", "pushoff_pct_median"),
                  "walk_distance_m": g("gps", walk, "gps_distance_m"),
                  "walk_speed_mps": g("gps", walk, "median_moving_speed_mps"),
                  "walk_stride_length_m": g("gps", walk, "stride_length_m_median"),
                  "walk_hr_mean": g("wearable", "per_session", walk, "hr_mean_excl_lock"),
                  "walk_hr_lock_min": g("wearable", "per_session", walk, "hr_cadence_lock_min"),
                  "walk_walking_min": g("wearable", "per_session", walk, "walking_min")})
    bi = S.get("bilateral", {}).get(walk) or next(iter(S.get("bilateral", {}).values()), None)  # primary walk first
    if bi:
        m.update({f"bi_{c}_si_pct": bi["measures"][c]["si_pct"] for c, _ in BI_MEASURES})
        m.update({"bi_step_phase_pct": bi["step_phase_median_pct"], "bi_stance_L_pct": bi["measures"]["stance_imu_pct"]["L"],
                  "bi_stance_R_pct": bi["measures"]["stance_imu_pct"]["R"]})
    m.update({"lr_phase_pct": g("left_right", "phase_shift_pct"), "lr_tilt_rom_diff_deg": g("left_right", "tilt_rom_diff_deg"),
              "temp_offset_c": day.temp_offset})
    sh = (S.get("sensor_health") or {}).get(walk) or {}
    if walk and (sh.get("R Met1", 0) > 25 or "R" in day.cfg.get("stance_invalid_sides", [])):
        m["walk_stance_fsr_pct"] = None  # pressure toe-off is set by Met1; with it faulty, pressure stance is not valid
    if m.get("walk_hr_lock_min") and m.get("walk_walking_min") and m["walk_hr_lock_min"] > 0.5 * m["walk_walking_min"]:
        m["walk_hr_mean"] = None  # most of the walk is suspected cadence lock: walking HR not determinable
    pd.DataFrame([m]).to_csv(day.out / "daily_metrics.csv", index=False)
    return m


def _dig(d, ks):
    for k in ks:
        if not isinstance(d, dict) or k not in d:
            return None
        d = d[k]
    return d


METRIC_ROWS = [  # (group, label, key, unit, format)
    ("Sleep", "Time asleep", "sleep_asleep_h", "h", "{:.1f}"),
    ("Sleep", "Sleep efficiency", "sleep_efficiency_pct", r"\%", "{:.0f}"),
    ("Sleep", "Light / deep / REM", ("sleep_light_pct", "sleep_deep_pct", "sleep_rem_pct"), r"\%", "{:.0f}"),
    ("Sleep", "Mean HR asleep", "sleep_hr_mean", "bpm", "{:.0f}"),
    ("Sleep", r"Mean SpO$_2$ asleep", "sleep_spo2_mean", r"\%", "{:.1f}"),
    ("Activity", "Steps (band / phone)", ("steps_band", "steps_phone"), "", "{:,.0f}"),
    ("Activity", "Mean awake HR", "hr_awake_mean", "bpm", "{:.0f}"),
    ("Activity", "Minutes with HR $>$ 120\\,bpm", "hr_min_over_120", "min", "{:.0f}"),
    ("Activity", r"HR--steps Spearman $\rho$", "hr_steps_rho", "", "{:.2f}"),
    ("Activity", "HR lag behind steps", "hr_steps_lag_min", "min", "{:.0f}"),
    ("Gait (walk)", "Cadence", "walk_cadence", "steps/min", "{:.0f}"),
    ("Gait (walk)", "Stride time / CV", ("walk_stride_s", "walk_stride_cv_pct"), r"s / \%", ("{:.2f}", "{:.1f}")),
    ("Gait (walk)", "Stance, IMU (R / L)", ("walk_stance_pct", "walk_stance_L_pct"), r"\%", "{:.1f}"),
    ("Gait (walk)", "Swing, IMU (R / L)", ("walk_swing_s", "walk_swing_L_s"), "s", "{:.3f}"),
    ("Gait (walk)", "Stance, pressure (R)", "walk_stance_fsr_pct", r"\%", "{:.0f}"),
    ("Gait (walk)", "Push-off timing (R / L)", ("walk_pushoff_pct", "walk_pushoff_L_pct"), r"\%", "{:.1f}"),
    ("Gait (walk)", "Distance / speed", ("walk_distance_m", "walk_speed_mps"), "m / m/s", ("{:.0f}", "{:.2f}")),
    ("Gait (walk)", "Stride length", "walk_stride_length_m", "m", "{:.2f}"),
    ("Gait (walk)", "Insole $-$ band bias", "insole_band_bias", "steps/min", "{:+.1f}"),
    ("Posture", "Monitored time", "posture_monitored_min", "min", "{:.0f}"),
    ("Posture", "Upright / slouched", ("posture_upright_pct", "posture_slouch_pct"), r"\%", "{:.0f}"),
    ("Posture", "Median time between changes", "posture_change_min", "min", "{:.1f}"),
    ("Environment", r"Indoor CO$_2$ (median)", "indoor_co2_median", "ppm", "{:.0f}"),
    ("Environment", r"Indoor / outdoor PM$_{2.5}$", ("indoor_pm25_median", "outdoor_pm25_median"), r"$\mu$g/m$^3$", "{:.0f}"),
    ("Environment", "Indoor temp. / RH", ("indoor_temp_median", "indoor_rh_median"), r"°C / \%", ("{:.1f}", "{:.0f}")),
    ("Environment", "Indoor / outdoor sound", ("indoor_dba_median", "outdoor_dba_median"), "dBA", "{:.0f}"),
    ("Environment", r"Bedroom CO$_2$ / PM$_{2.5}$", ("overnight_co2_median", "overnight_pm25_median"), r"ppm / $\mu$g/m$^3$", "{:.0f}"),
    ("Environment", "Bedroom temp. / sound", ("overnight_temp_median", "overnight_dba_median"), "°C / dBA", ("{:.1f}", "{:.0f}")),
    ("Left/right", "Left lag behind right", "lr_phase_pct", r"\% of cycle", "{:.0f}"),
    ("Left/right", "Foot-tilt range L $-$ R", "lr_tilt_rom_diff_deg", "°", "{:+.1f}"),
    ("Left/right", "Stance / swing SI (IMU)", ("bi_stance_imu_s_si_pct", "bi_swing_imu_s_si_pct"), r"\%", "{:+.1f}"),
    ("Left/right", r"Stance \% (L / R, IMU)", ("bi_stance_L_pct", "bi_stance_R_pct"), r"\%", "{:.1f}"),
    ("Hydration", "Total intake (drinks)", ("hydration_ml", "hydration_drinks"), "mL", "{:.0f}"),
    ("Hydration", "Longest gap between drinks", "hydration_longest_gap_h", "h", "{:.1f}"),
]


def write_latex(day, metrics):
    for name, cap in day.figures:
        (day.tex / f"fig_{name}.tex").write_text(
            "\\begin{figure}[htbp]\n  \\centering\n"
            f"  \\includegraphics[width=\\textwidth]{{figures/{name}.pdf}}\n"
            f"  \\caption{{{cap}}}\n  \\label{{fig:{name}}}\n\\end{{figure}}\n", encoding="utf-8")
    (day.out / "figures.tex").write_text(
        "% Auto-generated. Requires \\usepackage{graphicx}; paths are relative to analysis_output/.\n"
        + "".join(f"\\input{{latex/fig_{n}}}\n" for n, _ in day.figures), encoding="utf-8")

    def fmt(key, f):
        keys = key if isinstance(key, tuple) else (key,)
        fs = f if isinstance(f, tuple) else (f,) * len(keys)
        vals = [metrics.get(k) for k in keys]
        vals = [None if isinstance(v, float) and np.isnan(v) else v for v in vals]
        if all(v is None for v in vals):
            return "--"
        return " / ".join("--" if v is None else ff.format(v) for v, ff in zip(vals, fs))

    rows, last = [], None
    for grp, label, key, unit, f in METRIC_ROWS:
        if last and grp != last:
            rows.append("\\midrule")
        rows.append(f"{grp if grp != last else ''} & {label} & {fmt(key, f)} & {unit} \\\\")
        last = grp
    (day.tex / "metrics_table.tex").write_text(
        "% Auto-generated. Requires \\usepackage{booktabs}.\n"
        "\\begin{table}[htbp]\n  \\centering\n  \\small\n"
        f"  \\caption{{Headline metrics of day~{day.n} ({day.start:%d %B %Y}).}}\n"
        f"  \\label{{tab:{day.prefix}_metrics}}\n"
        "  \\begin{tabular}{llrl}\n    \\toprule\n    Domain & Metric & Value & Unit \\\\\n    \\midrule\n    "
        + "\n    ".join(rows) + "\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n", encoding="utf-8")


# =========================================================================== main
def run(day_dir):
    day = Day(day_dir)
    S = {"day": day.n, "date": str(day.start.date()), "temp_offset_c": day.temp_offset,
         "sessions": [{"key": s.key, "label": s.label, "context": s.context, "folder": s.path.name,
                       "start": f"{s.start:%Y-%m-%d %H:%M:%S}", "end": f"{s.end:%Y-%m-%d %H:%M:%S}",
                       "disconnects": s.read("events").query("event == 'disconnected'").groupby("node").size().to_dict()}
                      for s in day.sessions]}

    # gait (right insole strides; the primary walk is the walking session with most strides)
    S["gait"], strides, rights = {}, {}, {}
    for sess in day.with_stream("gait"):
        S["gait"][sess.key], right = analyze_gait(day, sess)
        if right is not None and len(right[1]):
            strides[sess.key], rights[sess.key] = right[1], right
    walks = [s for s in day.sessions if s.context in WALK_CONTEXTS and s.key in strides]
    primary = max(walks, key=lambda s: len(strides[s.key])) if walks else (
        max((s for s in day.sessions if s.key in strides), key=lambda s: len(strides[s.key])) if strides else None)
    S["primary_walk"] = primary.key if primary else None
    if primary:
        plot_gait_pressure(day, primary, rights[primary.key])
        plot_gait_strides(day, primary, strides[primary.key], S["gait"][primary.key]["R"])
    if len(strides) > 1:
        plot_gait_compare(day, strides, S["gait"])

    # pressure-sensor health per gait session
    health = {sess.key: sensor_health(sess) for sess in day.with_stream("gait")}
    health = {k: h for k, h in health.items() if len(h)}
    if health:
        S["sensor_health"] = {k: {f"{sd} {c}": round(100 * float((g.status != "ok").mean()))
                                  for (sd, c), g in h.groupby(["side", "sensor"])} for k, h in health.items()}
        faulty = {k: h for k, h in health.items() if max(S["sensor_health"][k].values()) >= 10}
        if faulty:  # show only sessions in which some sensor had problems
            plot_sensor_health(day, faulty)

    # stride-level left/right where both insoles streamed fully
    S["bilateral"] = {}
    for sess in day.with_stream("gait"):
        f_l, f_r = day.out / f"strides_{sess.key}_L.csv", day.out / f"strides_{sess.key}_R.csv"
        if f_l.exists() and f_r.exists():
            Ls, Rs = pd.read_csv(f_l), pd.read_csv(f_r)
            if len(Ls) >= 100 and len(Rs) >= 100:
                res_b, bl, br, pairs = analyze_bilateral(day, sess, Ls, Rs, health.get(sess.key))
                if res_b["paired_strides"] >= 100:
                    S["bilateral"][sess.key] = res_b
                    plot_bilateral(day, sess, res_b, bl, br, pairs)
                else:  # too few clean pairs (e.g. a failing sensor splits strides on one foot)
                    S.setdefault("bilateral_skipped", {})[sess.key] = res_b["paired_strides"]

    # left vs right from each foot's own strides (valid even when the insoles' clocks are not aligned)
    if day.cfg.get("lr_profiles"):
        for sess in day.with_stream("gait"):
            if all((day.out / f"profiles_{sess.key}_{s}.npz").exists() for s in ("L", "R")):
                S.setdefault("lr_profiles", {})[sess.key] = plot_lr_profiles(day, sess)

    # left vs right insole (cycle-averaged; works with sparse left data)
    lr = {}
    for sess in day.with_stream("gait"):
        out = analyze_left_right(day, sess)
        if out is not None:
            lr[sess.key] = out
    if lr:
        S["left_right_sessions"] = {k: v[0] for k, v in lr.items()}
        best = max((k for k in lr if lr[k][1] is not None), key=lambda k: lr[k][0]["left_samples_in_steady_strides"],
                   default=None)
        if best:
            S["left_right"] = lr[best][0]
        plot_left_right(day, lr)

    # posture
    S["posture"], segs, windows = analyze_posture(day)
    if S["posture"]:
        plot_posture(day, S["posture"], segs, windows)

    # environment
    S["environment"] = {}
    env_sessions = day.with_stream("environment")
    indoor = [s for s in env_sessions if s.context == "indoor"]
    outdoor = [s for s in env_sessions if s.context == "outdoor_walk"]
    overnight = [s for s in env_sessions if s.context == "overnight"]
    e_in, e_out = load_env(day, indoor), load_env(day, outdoor)
    if e_in is not None:
        S["environment"]["indoor"] = env_stats(e_in)
        plot_env_indoor(day, e_in, S["environment"]["indoor"], [s.key for s in indoor])
    if e_out is not None:
        S["environment"]["outdoor_walk"] = env_stats(e_out)
    for sess in (s for s in env_sessions if s.context in WALK_CONTEXTS):
        e = load_env(day, [sess])
        S["environment"][f"walk_{sess.key}"] = env_stats(e)
        plot_env_outdoor(day, e, S["environment"][f"walk_{sess.key}"], sess)
    for sess in (s for s in env_sessions if s.context == "transport"):  # in-vehicle exposure
        e = load_env(day, [sess])
        S["environment"][f"transport_{sess.key}"] = env_stats(e)
        plot_env_outdoor(day, e, S["environment"][f"transport_{sess.key}"], sess, prefix="env_trip")

    # GPS
    S["gps"], gps_all = {}, []
    for sess in day.with_stream("gps"):
        S["gps"][sess.key], gps = analyze_gps(sess, strides.get(sess.key))
        if gps is None:
            continue
        gps_all.append(gps)
        if sess.has("environment"):
            plot_route(day, sess, gps, load_env(day, [sess]), S["gps"][sess.key])
    gps_all = pd.concat(gps_all) if gps_all else None

    # wearable
    w, n_dup = load_wearable(day)
    hr = w[(w.DataType == "HEART_RATE") & (w.src == "gadgetbridge")].sort_values("start")
    spo2 = w[w.DataType == "OXYGEN_SATURATION"].sort_values("start")
    in_day = (w.start >= day.start) & (w.start < day.end)
    steps_all = w[in_day & (w.DataType == "STEPS")]
    band_steps = steps_all[steps_all.src == "gadgetbridge"]
    sleep, stages, sleep_span = analyze_sleep(day, w, hr, spo2)
    hyd_s, hyd = analyze_hydration(day)
    S["bottle"], bottle = analyze_bottle(day, hyd)
    extra = bottle_extra_drinks(day, S["bottle"])
    if extra is not None:  # drinks seen in the bottle's own data stream join the log
        hyd_s, hyd = analyze_hydration(day, extra)
    S["hydration"] = hyd_s

    if overnight:
        e_on = load_env(day, overnight)
        S["environment"]["overnight"] = env_stats(e_on)
        for sess in overnight:
            plot_env_overnight(day, load_env(day, [sess]), S["environment"]["overnight"], sess, sleep_span)

    env_all = load_env(day, env_sessions)
    strides_left = {k: pd.read_csv(day.out / f"strides_{k}_L.csv") for k in strides
                    if (day.out / f"strides_{k}_L.csv").exists()}
    mt = minute_table(day, hr, band_steps, strides, env_all, gps_all, segs, stages, sleep_span, hyd, strides_left)

    awake_hr = mt.hr[mt.context.notna() & (mt.context != "sleep")]
    spo2_day = spo2[(spo2.start >= day.start) & (spo2.start < day.end)].Value
    S["wearable"] = {
        "duplicate_rows_removed": int(n_dup),
        "sources": "gadgetbridge=Xiaomi Smart Band 10, FitbitMobile, fitness=Google Fit, phone=Android",
        "sleep": sleep,
        "hr_awake": {"mean": round(awake_hr.mean(), 1), "min": float(awake_hr.min()), "max": float(awake_hr.max()),
                     "minutes_over_120": int((awake_hr > 120).sum())},
        "spo2_day": {"mean": round(spo2_day.mean(), 1), "min": float(spo2_day.min())} if len(spo2_day) else None,
        "steps_day_by_source": steps_all.groupby("src").Value.sum().astype(int).to_dict(),
        "per_session": {s.key: {"hr_mean": r2(mt.hr[s.start:s.end].mean()),
                                "hr_mean_excl_lock": r2(mt.hr[s.start:s.end][~mt.hr_cadence_lock[s.start:s.end]].mean()),
                                "hr_cadence_lock_min": int(mt.hr_cadence_lock[s.start:s.end].sum()),
                                "walking_min": int((mt.steps_insole[s.start:s.end] >= 80).sum()),
                                "steps_by_source": steps_all[(steps_all.start >= s.start) & (steps_all.start < s.end)]
                                .groupby("src").Value.sum().astype(int).to_dict()} for s in day.sessions},
        "data_end_local": f"{hr.start.max():%Y-%m-%d %H:%M}",
    }
    plot_wearable_day(day, mt, sleep_span)
    if sleep:
        plot_sleep(day, mt, stages, sleep_span, sleep)
    for sess in walks:
        plot_walk_steps_hr(day, mt, sess)
    if hyd is not None:
        plot_hydration(day, hyd, hyd_s)
    if bottle is not None:
        plot_bottle(day, S["bottle"], bottle)

    # relationships
    R = S["relations"] = {}
    R["hr_steps"], aw, bins, xc = analyze_hr_steps(mt)
    plot_hr_steps(day, aw, bins, xc, R["hr_steps"])
    R["hr_by_posture"] = {p: {"n_min": int(g.notna().sum()), "mean": r2(g.mean())}
                          for p, g in mt.groupby("posture").hr}
    R["hr_context"], lab, order = analyze_hr_context(mt)
    plot_hr_context(day, mt, lab, order, R["hr_context"])
    if strides:
        R["agreement"], m, mean, diff = analyze_agreement(mt, list(strides))
        plot_agreement(day, m, mean, diff, R["agreement"])
    if indoor:
        keys = [s.key for s in indoor]
        R["corr_indoor"] = plot_corr(
            day, mt[mt.session.isin(keys)][["co2_ppm", "pm25", "pm10", "temp_c", "rh_pct", "dba", "hr"]],
            "corr_indoor", rf"Correlations between indoor environment variables and heart rate during session(s) "
                           rf"{', '.join(keys)}.")
    if overnight and sleep_span:
        keys = [s.key for s in overnight]
        night = mt[mt.session.isin(keys) & (mt.context == "sleep")]
        R["corr_overnight"] = plot_corr(
            day, night[["co2_ppm", "pm25", "temp_c", "rh_pct", "dba", "hr"]],
            "corr_overnight", rf"Correlations between bedroom environment and heart rate during sleep "
                              rf"(session(s) {', '.join(keys)}, sleep minutes only).")
    if primary and primary.context in WALK_CONTEXTS:
        R["corr_walk"] = plot_corr(
            day, mt[mt.session == primary.key][["steps_insole", "stride_time_s", "stance_pct", "gps_speed_mps", "hr",
                                                "pm25", "temp_c", "rh_pct", "dba"]],
            "corr_walk", rf"Correlations between gait, speed, heart rate and environment during session "
                         rf"{primary.key} ({primary.label.lower()}).")

    # close-ups of events marked "zoom" in day_config (gait: IMU/pressure; env: 10-s air quality)
    for ev in (e for e in day.events if e.get("zoom")):
        if ev["zoom"] == "gait":
            sess = next((s for s in day.with_stream("gait") if s.start <= ev["start"] <= s.end), None)
            if sess:
                S.setdefault("event_zoom", {})[ev["label"]] = plot_event_gait(day, ev, sess)
        elif ev["zoom"] == "env":
            S.setdefault("event_zoom", {})[ev["label"]] = plot_event_env(day, ev)

    metrics = daily_metrics(day, S)
    write_latex(day, metrics)
    (day.out / "summary.json").write_text(json.dumps(S, indent=2, default=str))
    print(f"day {day.n}: {len(day.figures)} figures -> {day.fig}")
    return S, metrics


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else ".")
