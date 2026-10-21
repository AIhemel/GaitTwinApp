"""Cross-day comparison for the multi-day study.

Usage:  python compare_days.py <subject_dir> [last_day]

Reads <subject_dir>/day_N/analysis_output/{daily_metrics.csv, minute_table.csv, summary.json, strides_*.csv}
for every day up to last_day (default: all) and writes <subject_dir>/comparison/upto_day<N>/:
  figures/cmp<N>_*.pdf|png, latex/fig_*.tex, latex/comparison_table.tex, all_days_metrics.csv
A separate folder per N keeps each day's report pointing at the comparison it was written with.
"""
import json
import re
import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

import daily_analysis as da
from daily_analysis import C, fig_size

DAY_COLORS = [C["blue"], C["orange"], C["aqua"], C["yellow"], C["magenta"], C["green"], C["violet"], C["red"]]
DAY_HATCH = ["", "///", "..", "\\\\\\", "xx", "--", "++", "oo"]  # greyscale-print backup for the day colour


class Days:
    def __init__(self, subject_dir, last=None, clean=True):
        self.base = Path(subject_dir).resolve()
        num = lambda p: int(re.fullmatch(r"day[ _](\d+)_?", p.name, re.I).group(1))
        dirs = sorted((p for p in self.base.iterdir() if re.fullmatch(r"day[ _]\d+_?", p.name, re.I)
                       and (p / "analysis_output" / "daily_metrics.csv").exists()), key=num)
        if last:
            dirs = [d for d in dirs if num(d) <= last]
        self.dirs = dirs
        self.n = [num(d) for d in dirs]
        self.metrics = pd.concat([pd.read_csv(d / "analysis_output" / "daily_metrics.csv") for d in dirs],
                                 ignore_index=True)
        self.summary = {n: json.loads((d / "analysis_output" / "summary.json").read_text(encoding="utf-8-sig")) for n, d in zip(self.n, dirs)}
        self.cfg = {n: json.loads((d / "day_config.json").read_text(encoding="utf-8-sig")) for n, d in zip(self.n, dirs)}
        self.out = self.base / "comparison" / f"upto_day{max(self.n)}"
        for sub in ("figures", "latex"):
            if clean:
                shutil.rmtree(self.out / sub, ignore_errors=True)
            (self.out / sub).mkdir(parents=True, exist_ok=True)
        self.prefix = f"cmp{max(self.n)}"
        self.figures = []

    def minutes(self, n):
        d = self.dirs[self.n.index(n)]
        mt = pd.read_csv(d / "analysis_output" / "minute_table.csv", parse_dates=["minute"])
        mt["minute"] = pd.to_datetime(mt.minute, utc=True).dt.tz_convert(da.TZ)
        return mt.set_index("minute")

    def strides(self, n, key, side="R"):
        f = self.dirs[self.n.index(n)] / "analysis_output" / f"strides_{key}_{side}.csv"
        return pd.read_csv(f) if f.exists() else None

    def hydration(self, n):
        """Drinks of day n: the combined list written by the daily pipeline (bottle log + bottle-stream drinks)."""
        d = self.dirs[self.n.index(n)]
        for f in (d / "analysis_output" / "hydration_all.csv", d / self.cfg[n].get("hydration_file", "hydration_manual.csv")):
            if f.exists():
                h = pd.read_csv(f)
                return h.sort_values("local_time").reset_index(drop=True)
        return None

    def pressure_valid(self, n, key, side):
        """Pressure-based toe-off usable: all three sensors of that foot healthy (<10 % faulty minutes) and the
        original first-metatarsal sensor in place."""
        if side in self.cfg[n].get("stance_invalid_sides", []):
            return False
        h = (self.summary[n].get("sensor_health") or {}).get(key, {})
        return all(h.get(f"{side} {c}", 0) < 10 for c in ("Heel", "Met1", "Met5"))

    def label(self, n):
        return f"Day {n}"


def save(D, fig, name, caption):
    name = f"{D.prefix}_{name}"
    fig.savefig(D.out / "figures" / f"{name}.pdf")
    fig.savefig(D.out / "figures" / f"{name}.png", dpi=300)
    plt.close(fig)
    D.figures.append((name, caption))


def day_boxes(ax, groups, positions, colors, hatches, width=0.6):
    bp = ax.boxplot(groups, positions=positions, widths=width, showfliers=False, patch_artist=True,
                    medianprops={"color": C["ink"], "lw": 1.5})
    for p, c, h in zip(bp["boxes"], colors, hatches):
        p.set(facecolor=c, alpha=0.75, hatch=h, edgecolor=C["ink2"])
    return bp


def day_legend(D, ax_or_fig, **kw):
    handles = [plt.Rectangle((0, 0), 1, 1, facecolor=DAY_COLORS[i], hatch=DAY_HATCH[i], edgecolor=C["ink2"], alpha=0.75)
               for i in range(len(D.n))]
    fig = ax_or_fig if hasattr(ax_or_fig, "savefig") else ax_or_fig.figure
    kw.pop("loc", None)
    fig.legend(handles, [D.label(n) for n in D.n], ncol=min(len(D.n), 4), loc="outside upper center", **kw)


# =========================================================================== figures
def plot_hr_profile(D):
    fig, ax = plt.subplots(figsize=fig_size(3.2), layout="constrained")
    for i, n in enumerate(D.n):
        mt = D.minutes(n)
        h = mt.hr.groupby(mt.index.hour).median()
        ax.plot(h.index + 0.5, h.values, color=DAY_COLORS[i], marker="os^D"[i % 4], ms=4.5,
                ls=["-", "--", ":", "-."][i % 4], label=D.label(n))
    ax.set(xlabel="Hour of day", ylabel="Median HR (bpm)", xlim=(0, 24), xticks=range(0, 25, 3))
    h, l = ax.get_legend_handles_labels()
    fig.legend(h, l, loc="outside upper center", ncol=min(len(D.n), 4))
    save(D, fig, "hr_profile",
         r"Hour-by-hour median heart rate (wrist band) on each day. Hours without band data are not drawn.")


def plot_hr_context(D):
    ctx = {}
    for n in D.n:
        mt = D.minutes(n)
        _, lab, _ = da.analyze_hr_context(mt)
        ctx[n] = (mt.hr, lab)
    order = ["Sleep: deep", "Sleep: light", "Sleep: REM", "Indoor sitting", "Other awake", "Transport", "Gait tests",
             "Walking"]
    order = [o for o in order if any(((lab == o) & hr.notna()).sum() >= 3 for hr, lab in ctx.values())]
    k = len(D.n)
    fig, ax = plt.subplots(figsize=fig_size(3.8), layout="constrained")
    w = 0.8 / k
    for i, n in enumerate(D.n):
        hr, lab = ctx[n]
        groups = [hr[lab == o].dropna().values for o in order]
        pos = [j + (i - (k - 1) / 2) * w for j in range(len(order))]
        keep = [(g, p) for g, p in zip(groups, pos) if len(g) >= 3]
        if keep:
            day_boxes(ax, [g for g, _ in keep], [p for _, p in keep], [DAY_COLORS[i]] * len(keep),
                      [DAY_HATCH[i]] * len(keep), width=w * 0.9)
    ax.set_xticks(range(len(order)), [o.replace("Sleep: ", "Sleep\n").replace(" ", "\n") for o in order])
    ax.tick_params(axis="x", labelsize=9.5)
    ax.set(ylabel="Heart rate (bpm)", xlim=(-0.6, len(order) - 0.4))
    ax.grid(axis="x", visible=False)
    day_legend(D, fig)
    save(D, fig, "hr_context",
         r"Heart rate by context on each day (boxes: inter-quartile range and median; whiskers 1.5\,IQR). "
         r"Contexts are defined in the same way every day: sleep stages from the wrist band, sensor sessions from "
         r"the session log, and all other awake minutes.")


def plot_sleep(D):
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.1), layout="constrained",
                           gridspec_kw={"width_ratios": [1, 1.4]})
    stages = [("deep", C["violet"], "Deep"), ("light", C["blue"], "Light"), ("rem", C["aqua"], "REM"),
              ("awake", C["orange"], "Awake")]
    x = np.arange(len(D.n))
    bottom = np.zeros(len(D.n))
    for key, c, lab in stages:
        v = np.array([(D.summary[n]["wearable"]["sleep"] or {}).get("stage_min", {}).get(key, 0) / 60 for n in D.n])
        ax[0].bar(x, v, bottom=bottom, color=c, width=0.6, edgecolor="white", lw=1, label=lab)
        bottom += v
    for xi, b in zip(x, bottom):
        ax[0].text(xi, b, f"{b:.1f}", ha="center", va="bottom", fontsize=10 if len(D.n) <= 4 else 9)
    ax[0].set_xticks(x, [D.label(n) if len(D.n) <= 3 else f"D{n}" for n in D.n])
    ax[0].set(ylabel="Hours", title="(a) Sleep stages", ylim=(0, max(bottom) * 1.18))
    ax[0].grid(axis="x", visible=False)
    h, l = ax[0].get_legend_handles_labels()
    fig.legend(h, l, loc="outside upper center", ncol=4)
    for i, n in enumerate(D.n):
        sl = D.summary[n]["wearable"]["sleep"]
        if not sl:
            continue
        b, w = (pd.Timestamp(f"2000-01-01 {sl[k]}") for k in ("bed_local", "wake_local"))
        bh, wh = b.hour + b.minute / 60, w.hour + w.minute / 60
        ax[1].barh(i, wh - bh, left=bh, height=0.5, color=C["band"], edgecolor=C["ink2"])  # neutral: stage colours are in use
        ax[1].text(bh - 0.2, i, sl["bed_local"], ha="right", va="center")
        ax[1].text(wh + 0.2, i, sl["wake_local"], ha="left", va="center")
    ax[1].set_yticks(range(len(D.n)), [D.label(n) for n in D.n])
    ax[1].set(xlabel="Hour of day", title="(b) Sleep window", xlim=(-1, 13), xticks=range(0, 13, 3))
    ax[1].invert_yaxis()
    ax[1].grid(axis="y", visible=False)
    save(D, fig, "sleep",
         r"Sleep on the night before each day (wrist band): (a) time in each stage and total; (b) sleep onset "
         r"and wake time.")


def plot_gait(D):
    data = []
    for n in D.n:
        key = D.summary[n].get("primary_walk")
        s = D.strides(n, key) if key else None
        if s is not None and len(s):
            # steady walking only: bouts of >= 10 strides, first/last 2 strides dropped
            s = s.groupby("bout").filter(lambda g: len(g) >= 10)
            s = s.groupby("bout", group_keys=False).apply(lambda g: g.iloc[2:-2])
            data.append((n, key, s))
    if not data:
        return
    fig, ax = plt.subplots(1, 3, figsize=fig_size(2.9), constrained_layout=True)
    pos = range(len(data))
    for j, (col, ylab, title, f) in enumerate((("stride_s", "Stride time (s)", "(a) Stride time", 1),
                                               ("stride_s", "Cadence (steps/min)", "(b) Cadence", None),
                                               ("stance_imu_pct", "Stance (% stride)", "(c) Stance (IMU)", 1))):
        groups = [(120 / s[col]).values if f is None else s[col].dropna().values for _, _, s in data]
        idx = [D.n.index(n) for n, _, _ in data]
        day_boxes(ax[j], groups, list(pos), [DAY_COLORS[i] for i in idx], [DAY_HATCH[i] for i in idx])
        ax[j].set_xticks(list(pos), [f"D{n}\n({k})" for n, k, _ in data])
        ax[j].set(ylabel=ylab, title=title)
        ax[j].grid(axis="x", visible=False)
    desc = "; ".join(rf"day~{n}: session {k}, {len(s)} steady strides" for n, k, s in data)
    save(D, fig, "gait",
         r"Right-foot gait during the main walk of each day (steady walking only: bouts of at least 10 strides "
         rf"without their first and last two strides; {desc}). Cadence is 120 divided by stride time. Stance is "
         r"measured from IMU gait events (heel-strike impact to IMU toe-off), which stay valid after the right "
         r"first-metatarsal pressure sensor was replaced (day~5 onwards).")


def plot_toeoff(D):
    """Validation of the IMU toe-off against the pressure toe-off, and stance from both methods per session."""
    rows, ref, rep = [], [], []
    for n in D.n:
        for key in (D.summary[n].get("gait") or {}):
            for side in ("R", "L"):
                s = D.strides(n, key, side)
                if s is None or "to_imu_ms" not in s or len(s) < 100:
                    continue
                s = da.steady(s).dropna(subset=["to_imu_ms", "stance_imu_pct"])
                if len(s) < 100:
                    continue
                ok = D.pressure_valid(n, key, side)
                rows.append({"n": n, "key": key, "side": side, "ok": ok, "imu": s.stance_imu_pct.median(),
                             "fsr": s.stance_pct.median(), "strides": len(s)})
                if side == "R":
                    d = s.assign(diff=s.to_imu_ms - s.to_fsr_ms, day=n, key=key)
                    (ref if ok else rep if side in D.cfg[n].get("stance_invalid_sides", []) else []).append(d)
    if not rows or not ref:
        return
    r = pd.DataFrame(rows)
    ref, rep = pd.concat(ref), (pd.concat(rep) if rep else None)
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.3), layout="constrained", gridspec_kw={"width_ratios": [1.6, 1]})
    sess = r.drop_duplicates(["n", "key"])[["n", "key"]].apply(tuple, axis=1).tolist()
    x = {s: i for i, s in enumerate(sess)}
    for side, c, mk in (("R", C["blue"], "o"), ("L", C["orange"], "^")):
        q = r[r.side == side]
        xs = [x[(a, b)] + (0.1 if side == "L" else -0.1) for a, b in zip(q.n, q.key)]
        ax[0].plot(xs, q.imu, mk, color=c, ms=6, label=f"{'Right' if side == 'R' else 'Left'}, IMU")
        ax[0].scatter(xs, q.fsr, s=36, marker=mk, facecolors="none",
                      edgecolors=[c if ok else C["red"] for ok in q.ok], lw=1.2,
                      label=f"{'Right' if side == 'R' else 'Left'}, pressure")
    bad = [x[(a, b)] for a, b in r[(r.side == "R") & ~r.ok][["n", "key"]].itertuples(index=False)]
    for b in bad:
        ax[0].axvspan(b - 0.45, b + 0.45, color=C["band"], lw=0, zorder=0)
    ax[0].set_xticks(range(len(sess)), [f"D{a}\n{b}" for a, b in sess])
    ax[0].tick_params(axis="x", labelsize=9)
    ax[0].set(ylabel="Stance (% of stride)", title="(a) Stance per session", xlim=(-0.6, len(sess) - 0.4))
    ax[0].grid(axis="x", visible=False)
    bins = np.arange(-200, 201, 10)
    ax[1].hist(ref["diff"].clip(-200, 200), bins=bins, color=C["blue"], alpha=0.8, density=True,
               label="Right, original sensors")
    if rep is not None:
        ax[1].hist(rep["diff"].clip(-200, 200), bins=bins, histtype="step", color=C["red"], lw=1.6, density=True,
                   label="Right, Met1 replaced")
    ax[1].axvline(0, color=C["ink"], lw=0.8)
    ax[1].set(xlabel="IMU − pressure toe-off (ms)", ylabel="Density", title="(b) Toe-off timing", yticks=[])
    h0, l0 = ax[0].get_legend_handles_labels()
    h1, l1 = ax[1].get_legend_handles_labels()
    fig.legend(h0 + h1, l0 + l1, loc="outside upper center", ncol=3, fontsize=9)
    st = ref.assign(st_fsr_hs=100 * (ref.to_imu_ms - ref.hs_ms) / (1000 * ref.stride_s))
    res = {"ref_sessions": [f"D{a}-{b}" for a, b in ref[["day", "key"]].drop_duplicates().itertuples(index=False)],
           "ref_strides": int(len(ref)), "ref_bias_ms": round(float(ref["diff"].median())),
           "ref_mean_ms": round(float(ref["diff"].mean())), "ref_sd_ms": round(float(ref["diff"].std())),
           "ref_iqr_ms": [round(float(ref["diff"].quantile(q))) for q in (.25, .75)],
           "ref_stance_r": round(float(np.corrcoef(st.st_fsr_hs, ref.stance_pct)[0, 1]), 2),
           "ref_session_bias_ms": {f"D{a}-{b}": round(float(g["diff"].median())) for (a, b), g in ref.groupby(["day", "key"])}}
    if rep is not None:
        res.update({"rep_strides": int(len(rep)), "rep_bias_ms": round(float(rep["diff"].median())),
                    "rep_session_bias_ms": {f"D{a}-{b}": round(float(g["diff"].median()))
                                            for (a, b), g in rep.groupby(["day", "key"])}})
    res["sessions"] = r.round(2).to_dict("records")
    (D.out / "toeoff_validation.json").write_text(json.dumps(res, indent=1, default=str))
    rep_txt = (rf" After the right first-metatarsal sensor was replaced (red outline, {res['rep_strides']} strides) the "
               rf"pressure toe-off came {res['rep_bias_ms']}\,ms earlier than the IMU toe-off, so the pressure-based "
               r"right stance was too short (red open circles in a), while the IMU stance was unchanged." if rep is not None else "")
    save(D, fig, "toeoff",
         r"IMU-based toe-off and stance. (a) Median stance of steady strides in every gait session with at least 100 "
         r"steady strides, from IMU gait events (filled: heel-strike impact to the instant the push-off rotation rate "
         r"of the foot has fallen to half its peak) and from the pressure sensors (open; red where the right "
         r"first-metatarsal sensor was faulty or replaced, grey background). (b) Per-stride difference between the IMU "
         rf"and pressure toe-off on the right foot with original, healthy sensors ({', '.join(res['ref_sessions'])}; "
         rf"{res['ref_strides']} strides): median {res['ref_bias_ms']:+d}\,ms, SD {res['ref_sd_ms']}\,ms, inter-quartile "
         rf"range {res['ref_iqr_ms'][0]} to {res['ref_iqr_ms'][1]}\,ms.{rep_txt}")


def plot_environment(D):
    rows = [("indoor", "Indoor"), ("outdoor_walk", "Outdoor\nwalk"), ("transport", "Vehicle"),
            ("overnight", "Bedroom\n(night)")]
    cols = [("pm25", r"PM$_{2.5}$ (µg/m³)"), ("temp_c", "Temp. (°C)"), ("dba", "Sound (dBA)"), ("co2_ppm", "CO$_2$ (ppm)")]
    fig, axes = plt.subplots(2, 2, figsize=fig_size(4.2), layout="constrained")
    present = [(ctx, lab) for ctx, lab in rows
               if any(any(k == ctx or k.startswith(ctx + "_") for k in D.summary[n].get("environment", {})) for n in D.n)]
    k = len(D.n)
    w = 0.8 / k
    for ax, (col, ylab), letter in zip(axes.ravel(), cols, "abcd"):
        for i, n in enumerate(D.n):
            mt = D.minutes(n)
            ctx_of = {s["key"]: s["context"] for s in D.summary[n]["sessions"]}
            ctx = mt.session.map(ctx_of)
            for j, (c, _) in enumerate(present):
                v = mt.loc[ctx == c, col].dropna()
                if col == "co2_ppm" and c == "outdoor_walk":
                    v = v[v >= 400]  # implausible outdoor CO2 readings excluded
                if len(v) >= 5:
                    day_boxes(ax, [v.values], [j + (i - (k - 1) / 2) * w], [DAY_COLORS[i]], [DAY_HATCH[i]], width=w * 0.9)
        if col in da.ENV_REFS:
            ax.axhline(da.ENV_REFS[col][0], color=C["red"], lw=1, ls="--")
        ax.set_xticks(range(len(present)), [lab for _, lab in present])
        ax.tick_params(axis="x", labelsize=9.5)
        ax.set(ylabel=ylab, xlim=(-0.6, len(present) - 0.4))
        ax.set_title(f"({letter})", loc="left", x=-0.02)
        ax.grid(axis="x", visible=False)
    day_legend(D, fig)
    offs = sorted({D.cfg[n].get("temp_offset_c", 0) for n in D.n})
    note = rf" Temperatures include a {offs[0]:+.0f}\,°C self-heating correction." if offs != [0] else ""
    save(D, fig, "environment",
         r"Environment-node readings (1-min means) by setting and day: (a) PM$_{2.5}$, (b) temperature, (c) sound "
         r"level and (d) CO$_2$; outdoor CO$_2$ readings below 400\,ppm are excluded as implausible. Dashed lines: "
         r"WHO PM$_{2.5}$ 24-h guideline, 70\,dBA, 1000\,ppm. A setting is missing on days without that "
         r"recording." + note)


def plot_hydration(D):
    fig, ax = plt.subplots(figsize=fig_size(2.9), constrained_layout=True)
    stream_days = []
    for i, n in enumerate(D.n):
        h = D.hydration(n)
        if h is None:
            continue
        if "note" in h and h.note.astype(str).str.contains("stream").any():
            stream_days.append(n)
        t = pd.to_datetime(h.local_time)
        hrs = t.dt.hour + t.dt.minute / 60
        x = np.concatenate([[8], hrs, [24]])
        y = np.concatenate([[0], h.volume_ml.cumsum(), [h.volume_ml.sum()]])
        ax.step(x, y, where="post", color=DAY_COLORS[i], ls=["-", "--", ":", "-."][i % 4], lw=1.8, label=D.label(n))
        ax.plot(hrs, h.volume_ml.cumsum(), "os^D"[i % 4], color=DAY_COLORS[i], ms=5)
    ax.axhspan(2000, 2500, color=C["aqua"], alpha=0.15, lw=0)
    ax.set(xlabel="Hour of day", ylabel="Cumulative intake (mL)", xlim=(8, 24), xticks=range(8, 25, 2), ylim=(0, 2700))
    ax.legend(loc="upper left", ncol=2 if len(D.n) > 4 else 1)
    save(D, fig, "hydration",
         r"Cumulative fluid intake from the smart-bottle log on each day"
         + (rf" (plus drinks detected in the bottle's data stream on day~{', '.join(map(str, stream_days))})"
            if stream_days else "") + r". The shaded band is the EFSA adequate "
         r"intake for total water (2.0--2.5\,L/day including food).")


def plot_left_right(D):
    rows = []
    for n in D.n:
        for key, r in (D.summary[n].get("left_right_sessions") or {}).items():
            if r.get("phase_shift_pct") is not None:
                rows.append((n, key, r))
    if not rows:
        return
    fig, ax = plt.subplots(1, 2, figsize=fig_size(1.4 + 0.3 * len(rows)), layout="constrained")
    y = np.arange(len(rows))
    for j, (n, key, r) in enumerate(rows):
        i = D.n.index(n)
        lo, hi = r["phase_shift_ci95_pct"]
        ax[0].errorbar(r["phase_shift_pct"], j, xerr=[[r["phase_shift_pct"] - lo], [hi - r["phase_shift_pct"]]],
                       fmt="os^D"[i % 4], color=DAY_COLORS[i], ms=7, capsize=4, lw=1.5)
        ax[1].barh(j - 0.17, r["tilt_rom_deg"]["R"], height=0.32, color=C["ink2"], alpha=0.35, label="Right" if j == 0 else None)
        ax[1].barh(j + 0.17, r["tilt_rom_deg"]["L"], height=0.32, color=DAY_COLORS[i], hatch="///", edgecolor="white",
                   label="Left" if j == 0 else None)
    labels = [f"D{n}-{k}" for n, k, _ in rows]
    ax[0].axvline(50, color=C["ink"], lw=1, ls="--")
    ax[0].set_yticks(y, labels)
    ax[0].set(xlabel="Left lag (% of cycle)", title="(a) Step timing", xlim=(40, 60))
    ax[1].set_yticks(y, labels)
    ax[1].set(xlabel="Foot-tilt range (°)", title="(b) Foot tilt")
    h, l = ax[1].get_legend_handles_labels()
    fig.legend(h, l, loc="outside upper right", ncol=2)
    for a in ax:
        a.invert_yaxis()
        a.grid(axis="y", visible=False)
    save(D, fig, "left_right",
         r"Left/right comparison in every session where the left insole delivered enough data (labels: day and "
         r"session). (a) Lag of the left heel-strike impact behind the right one, as a percentage of the gait cycle, "
         r"with bootstrap 95\,\% confidence intervals; 50\,\% (dashed) is perfectly symmetric step timing. (b) Range "
         r"of foot tilt over the cycle for each foot. Sessions where the left and right acceleration curves did not "
         r"match in shape are omitted.")


# =========================================================================== table
TABLE_ROWS = [  # (label, key, format, unit)
    ("Time asleep", "sleep_asleep_h", "{:.1f}", "h"),
    ("Deep / REM sleep", ("sleep_deep_pct", "sleep_rem_pct"), "{:.0f}", r"\%"),
    ("Mean HR asleep", "sleep_hr_mean", "{:.0f}", "bpm"),
    ("Mean awake HR", "hr_awake_mean", "{:.0f}", "bpm"),
    ("HR $>$ 120\\,bpm", "hr_min_over_120", "{:.0f}", "min"),
    ("Steps (band)", "steps_band", "{:,.0f}", ""),
    ("Steps (phone)", "steps_phone", "{:,.0f}", ""),
    (r"HR--steps $\rho$", "hr_steps_rho", "{:.2f}", ""),
    ("Walk cadence", "walk_cadence", "{:.0f}", "steps/min"),
    ("Stride time / CV", ("walk_stride_s", "walk_stride_cv_pct"), ("{:.2f}", "{:.1f}"), r"s, \%"),
    ("Stance R/L", ("walk_stance_pct", "walk_stance_L_pct"), "{:.0f}", r"\%"),
    ("Swing R/L", ("walk_swing_s", "walk_swing_L_s"), "{:.2f}", "s"),
    ("Push-off timing R/L", ("walk_pushoff_pct", "walk_pushoff_L_pct"), "{:.0f}", r"\%"),
    ("Upright sitting", "posture_upright_pct", "{:.0f}", r"\%"),
    ("Walk distance", "walk_distance_m", "{:,.0f}", "m"),
    ("Walk speed / stride", ("walk_speed_mps", "walk_stride_length_m"), "{:.2f}", "m/s, m"),
    ("Walk mean HR$^\\dagger$", "walk_hr_mean", "{:.0f}", "bpm"),
    ("HR-lock min.$^\\dagger$", ("walk_hr_lock_min", "walk_walking_min"), "{:.0f}", ""),
    ("Left lag", "lr_phase_pct", "{:.1f}", r"\% cycle"),
    (r"Indoor PM$_{2.5}$", "indoor_pm25_median", "{:.0f}", r"$\mu$g/m$^3$"),
    ("Indoor temperature", "indoor_temp_median", "{:.1f}", "°C"),
    ("Indoor sound", "indoor_dba_median", "{:.0f}", "dBA"),
    (r"Outdoor PM$_{2.5}$", "outdoor_pm25_median", "{:.0f}", r"$\mu$g/m$^3$"),
    (r"Bedroom PM$_{2.5}$", "overnight_pm25_median", "{:.0f}", r"$\mu$g/m$^3$"),
    ("Fluid intake", "hydration_ml", "{:,.0f}", "mL"),
    ("Longest drink gap", "hydration_longest_gap_h", "{:.1f}", "h"),
]


# with many days the "a / b" cells no longer fit A4: such rows are then split into one row per value
SPLIT_LABELS = {
    ("sleep_deep_pct", "sleep_rem_pct"): ("Deep sleep", "REM sleep"),
    ("walk_stride_s", "walk_stride_cv_pct"): ("Stride time", "Stride-time CV"),
    ("walk_stance_pct", "walk_stance_L_pct"): ("Stance R", "Stance L"),
    ("walk_swing_s", "walk_swing_L_s"): ("Swing R", "Swing L"),
    ("walk_pushoff_pct", "walk_pushoff_L_pct"): ("Push-off timing R", "Push-off timing L"),
    ("walk_speed_mps", "walk_stride_length_m"): ("Walk speed", "Stride length"),
    ("walk_hr_lock_min", "walk_walking_min"): ("HR-lock min.$^\\dagger$", "Walking min."),
}


def SPLIT_ROWS(D):
    return len(D.n) >= 6


def SHOW_CHANGE(D):
    return 1 < len(D.n) < 5  # with many days the change column no longer fits A4


def write_table(D):
    m = D.metrics.set_index("day")

    def cell(n, key, f):
        keys = key if isinstance(key, tuple) else (key,)
        fs = f if isinstance(f, tuple) else (f,) * len(keys)
        vals = [m.loc[n].get(k) if k in m.columns else None for k in keys]
        if all(v is None or pd.isna(v) for v in vals):
            return "--"
        return " / ".join("--" if v is None or pd.isna(v) else ff.format(v) for v, ff in zip(vals, fs))

    def change(key):
        if isinstance(key, tuple) or len(D.n) < 2 or key not in m.columns:
            return ""
        a, b = m.loc[D.n[-2]].get(key), m.loc[D.n[-1]].get(key)
        if pd.isna(a) or pd.isna(b):
            return "--"
        return f"{b - a:+,.1f}" if abs(b - a) < 100 else f"{b - a:+,.0f}"

    cols = "l" + "r" * len(D.n) + ("r" if SHOW_CHANGE(D) else "")
    head = " & ".join(["Metric"] + [D.label(n) for n in D.n] +
                      (["Change"] if SHOW_CHANGE(D) else []))
    rows = []
    items = []
    for label, key, f, unit in TABLE_ROWS:
        if SPLIT_ROWS(D) and isinstance(key, tuple) and key in SPLIT_LABELS:
            units = unit.split(", ") if ", " in unit else [unit] * len(key)
            fs = f if isinstance(f, tuple) else (f,) * len(key)
            items += list(zip(SPLIT_LABELS[key], key, fs, units))
        else:
            items.append((label, key, f, unit))
    for label, key, f, unit in items:
        name = f"{label} ({unit})" if unit else label  # unit in the label keeps the table narrow
        cells = [name] + [cell(n, key, f) for n in D.n] + ([change(key)] if SHOW_CHANGE(D) else [])
        rows.append(" & ".join(cells) + r" \\")
    (D.out / "latex" / "comparison_table.tex").write_text(
        "% Auto-generated by compare_days.py. Requires \\usepackage{booktabs}.\n"
        "\\begin{table}[htbp]\n  \\centering\n  " + ("\\small" if len(D.n) <= 2 else "\\footnotesize" if len(D.n) <= 4 else "\\scriptsize") + "\n"
        f"  \\caption{{Headline metrics across days 1--{max(D.n)} (medians for environment values; left lag: left heel strike as \\% of the right gait cycle; $^\\dagger$walking heart rate excludes minutes of suspected optical cadence lock, i.e.\\ heart rate within 6\\,bpm of step rate for $\\geq$2 consecutive minutes; stance and swing from IMU gait events; HR-lock min.: flagged / walking minutes)"
        + (f"; change = day~{D.n[-1]} minus day~{D.n[-2]}" if SHOW_CHANGE(D) else "") +
        f".}}\n  \\label{{tab:{D.prefix}_metrics}}\n  \\setlength{{\\tabcolsep}}{{{4 if len(D.n) <= 2 else 3 if len(D.n) < 8 else 2}pt}}\n"
        f"  \\begin{{tabular}}{{{cols}}}\n    \\toprule\n    {head} \\\\\n    \\midrule\n    "
        + "\n    ".join(rows) + "\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n", encoding="utf-8")


def run(subject_dir, last=None):
    D = Days(subject_dir, last)
    D.metrics.to_csv(D.out / "all_days_metrics.csv", index=False)
    for f in (plot_hr_profile, plot_hr_context, plot_sleep, plot_gait, plot_toeoff, plot_environment, plot_hydration,
              plot_left_right):
        f(D)
    write_table(D)
    for name, cap in D.figures:
        (D.out / "latex" / f"fig_{name}.tex").write_text(
            "\\begin{figure}[htbp]\n  \\centering\n"
            f"  \\includegraphics[width=\\textwidth]{{figures/{name}.pdf}}\n"
            f"  \\caption{{{cap}}}\n  \\label{{fig:{name}}}\n\\end{{figure}}\n", encoding="utf-8")
    print(f"comparison of days {D.n}: {len(D.figures)} figures -> {D.out}")
    return D


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "..", int(sys.argv[2]) if len(sys.argv) > 2 else None)
