"""Expected outputs of the thesis Python pipeline, for checking the app's TypeScript port.

Runs the reference functions from handoff/reference/pipeline/daily_analysis.py on handoff/sample_data/
and writes __tests__/fixtures/: trimmed inputs (gzipped CSV) plus the pipeline's outputs (JSON).
Re-run after changing the reference pipeline or the sample data:

    ../../gait_env/bin/python scripts/make_health_fixtures.py
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.signal import butter, filtfilt

APP = Path(__file__).resolve().parents[1]
HANDOFF = APP / "handoff"
OUT = APP / "__tests__" / "fixtures"
sys.path.insert(0, str(HANDOFF / "reference" / "pipeline"))
import daily_analysis as da  # noqa: E402

OUT.mkdir(parents=True, exist_ok=True)
GAIT_COLS = ["utc_ms", "Pitch", "Quat_I", "Quat_J", "Quat_K", "Quat_Real", "Heel_FSR", "Met1_FSR", "Met5_FSR",
             "Accel_X", "Accel_Y", "Accel_Z"]


def clean(o):
    """JSON-safe: numpy scalars -> python, NaN -> None."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, np.ndarray)):
        return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if np.isnan(o) else float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    return o


def write_json(name, obj):
    (OUT / name).write_text(json.dumps(clean(obj), indent=1))


def write_csv_gz(name, df):
    with gzip.open(OUT / name, "wt") as f:
        df.to_csv(f, index=False)


# ------------------------------------------------------------------ signal building blocks
rng = np.random.default_rng(7)
x = np.sin(np.arange(600) / 9.0) * 100 + rng.normal(0, 15, 600)
fs = 112.4
b, a = butter(2, 6.0 / (fs / 2))
t_nonuni = np.cumsum(rng.uniform(6, 14, 200))
y_nonuni = np.sin(t_nonuni / 100.0)
sub = pd.Series(x[::11])
write_json("signal_expected.json", {
    "x": x, "fs": fs, "butter_b": b, "butter_a": a, "filtfilt": filtfilt(b, a, x),
    "rolling_q05_w101": pd.Series(x).rolling(101, center=True, min_periods=25).quantile(0.05).bfill().ffill().to_numpy(),
    "rolling_q95_w20_sub": sub.rolling(20, center=True, min_periods=5).quantile(0.95).bfill().ffill().to_numpy(),
    "sub": sub.to_numpy(),
    "t_nonuni": t_nonuni, "y_nonuni": y_nonuni, "gradient_nonuni": np.gradient(y_nonuni, t_nonuni / 1000),
    "percentile_95": float(np.percentile(x, 95)), "percentile_5": float(np.percentile(x, 5)),
})


# ------------------------------------------------------------------ gait (detect_strides + analyze_gait's gate)
def ref_side(d, normalize=False, min_rate=80, max_gap=0.10):
    """analyze_gait() for one foot, minus the per-connection retiming (the app's utc_ms is used as is)."""
    d = d.sort_values("utc_ms").drop_duplicates("utc_ms").reset_index(drop=True)
    t = d.utc_ms.to_numpy(float)
    dur = (t[-1] - t[0]) / 1000
    dt = np.diff(t)
    fs = len(d) / max(1e-9, dur - dt[dt > 200].sum() / 1000)
    gap_frac = dt[dt > 200].sum() / 1000 / dur
    info = {"samples": len(d), "rate_hz": fs, "gap_frac": gap_frac}
    if fs < min_rate or gap_frac > max_gap:
        info["gated"] = True
        return info, []
    s, load, contact = da.detect_strides(d, fs, normalize=normalize)
    if len(s):
        gap_ends = t[1:][dt > 200]
        span = [((gap_ends > h) & (gap_ends <= h + 1000 * st)).any() for h, st in zip(s.hs_ms, s.stride_s)]
        s = s[~np.array(span)].reset_index(drop=True)
    info["gated"] = False
    info["heel_strikes"] = int(np.sum(np.diff(contact.astype(int)) == 1))
    info["load_head"] = load[:50]
    info["steady_count"] = int(len(da.steady(s))) if len(s) else 0
    keep = ["hs_ms", "stride_s", "stance_pct", "stance_imu_pct", "swing_imu_s", "pushoff_pct", "tilt_range_deg",
            "peak_acc_ms2", "pitch_range_deg", "heel_share", "met1_share", "met5_share", "hs_imu_ms", "to_imu_ms", "bout"]
    return info, s[keep].to_dict("records")


gait_expected = {}
hemel = pd.read_csv(HANDOFF / "sample_data/hemel_day7_morning/gait.csv")
for side in ("R", "L"):
    d = hemel[hemel.side == side][GAIT_COLS]
    write_csv_gz(f"gait_hemel_{side}.csv.gz", d)
    info, strides = ref_side(d)
    gait_expected[f"hemel_{side}"] = {"info": info, "strides": strides}

spriha = pd.read_csv(HANDOFF / "sample_data/spriha_day3_walk/gait_60s.csv")
for side in ("R", "L"):
    d = spriha[spriha.side == side][GAIT_COLS]
    write_csv_gz(f"gait_spriha_{side}.csv.gz", d)
    info, strides = ref_side(d)
    gait_expected[f"spriha_{side}"] = {"info": info, "strides": strides}
write_json("gait_expected.json", gait_expected)


# ------------------------------------------------------------------ bottle (bottle_plateaus + analyze_bottle's events)
h = pd.read_csv(HANDOFF / "sample_data/hemel_day7_morning/hydration.csv")
write_csv_gz("hydration_hemel.csv.gz", h)
hh = h[h.offline == 0].copy()
hh["t"] = pd.to_datetime(hh.utc_ms.fillna(hh.rx_ms), unit="ms", utc=True)
hh = hh.sort_values("t").reset_index(drop=True)
hh["Cap_mL"] = hh.Cap_mL.where(~(hh.Cap_mL >= 499.5))
pl = da.bottle_plateaus(hh.t, hh.Fused_mL)
pl = [p for p in pl if not (hh[(hh.t >= p["t0"]) & (hh.t <= p["t1"])].Weight_g.median() < 2 and p["level"] > 5)]
events = []
for p, q in zip(pl[:-1], pl[1:]):
    dlev = q["level"] - p["level"]
    if abs(dlev) < 8:
        continue
    between = hh[(hh.t > p["t1"]) & (hh.t < q["t0"])]
    tev = q["t0"] if dlev > 0 else p["t1"]
    events.append({"t_ms": tev.value // 10**6, "before_ml": p["level"], "after_ml": q["level"], "change_ml": dlev,
                   "kind": "added" if dlev > 0 else "removed",
                   "lifted": bool(len(between) and between.Weight_g.min() < 2 and min(p["level"], q["level"]) > 5)})
ms = lambda ts: ts.value // 10**6  # noqa: E731
write_json("bottle_expected.json", {
    "plateaus": [{"t0_ms": ms(p["t0"]), "t1_ms": ms(p["t1"]), "level": p["level"], "n": p["n"]} for p in pl],
    "events": events,
})


# ------------------------------------------------------------------ posture (posture_segments)
p = pd.read_csv(HANDOFF / "sample_data/hemel_day7_morning/posture.csv")
ev = pd.read_csv(HANDOFF / "sample_data/hemel_day7_morning/events.csv")
live = p[p.replayed == 0].copy()
live["onset_ms"] = live.utc_ms - 10_000
session_start = ev.loc[ev.event == "session_start", "rx_ms"].iloc[0]
session_stop = ev.loc[ev.event == "session_stop", "rx_ms"].iloc[-1]
conn, windows = None, []
for _, r in ev[ev.node == "POSTURE"].iterrows():
    if r.event in ("status_at_start_connected", "connected"):
        conn = r.rx_ms if r.event == "connected" else session_start
    elif r.event == "disconnected" and conn is not None:
        windows.append((conn, r.rx_ms))
        conn = None
if conn is not None:
    windows.append((conn, session_stop))
segs = []
for w0, w1 in windows:
    inside = live[(live.onset_ms >= w0 - 15_000) & (live.onset_ms < w1)].sort_values("onset_ms")
    for i, r in enumerate(inside.itertuples()):
        end = inside.onset_ms.iloc[i + 1] if i + 1 < len(inside) else w1
        segs.append({"pose": r.pose_name, "start": max(r.onset_ms, w0), "end": end})
write_json("posture_expected.json", {"windows": windows, "segments": segs})
print("fixtures written to", OUT)
for k, v in gait_expected.items():
    print(f"  {k}: rate {v['info']['rate_hz']:.1f} Hz, gated={v['info']['gated']}, strides={len(v['strides'])}")
print(f"  bottle: {len(pl)} plateaus, {len(events)} events; posture: {len(segs)} segments")
