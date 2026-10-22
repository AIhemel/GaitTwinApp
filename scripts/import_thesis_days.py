"""Turn thesis-pipeline days into the app's daily files, so the app knows your "usual" from day one.

The app learns personal baselines (src/health/baselines.ts) from Downloads/GaitTwin/daily/<date>/ on the
phone. Days analysed by the Python pipeline (handoff/reference/pipeline/daily_analysis.py) already have
everything needed in <day_dir>/analysis_output/: minute_table.csv and strides_<session>_<side>.csv.
This converts them to the app's layout:

    <out>/daily/<YYYY-MM-DD>/minute_summary.csv   app column layout (MINUTE_HEADER in daySummary.ts)
    <out>/daily/<YYYY-MM-DD>/strides_R.csv, strides_L.csv   app column order (STRIDE_COLS in engine.ts)
    <out>/daily/<YYYY-MM-DD>/daily_summary.json   day totals the baselines use, marked "imported"

Then push them into the app's own folder and restart the app; at start-up it copies each day into
Downloads/GaitTwin/daily/ (as its own files: Android doesn't let the app read files in Downloads that
another source created) and never replaces a day it recorded itself:

    adb push <out>/daily/. /sdcard/Android/data/com.gaittwinapp/files/import/daily/
    adb shell am force-stop com.gaittwinapp      (then open the app)

Import only the phone owner's days: baselines are personal. The app learns from the last 14 days by
default; to keep older thesis days in your usual, raise "Learn from the last" in Alerts & reminders.

Usage (run each day's pipeline first; pandas is the only dependency):
    python scripts/import_thesis_days.py --out import_out G:/.../Hemel/day_1 G:/.../Hemel/day_2 ...
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Must match the app (checked by __tests__/importThesisDays.test.tsx).
MINUTE_HEADER = ("minute,hr,steps_band,steps_insole,stride_time_s,stance_pct,co2_ppm,temp_c,rh_pct,pm25,pm10,dba,"
                 "gps_speed_mps,posture,sleep_stage,water_ml,hr_cadence_lock,event,context")
STRIDE_COLS = ("hs_ms,stride_s,stance_pct,stance_s,swing_s,stance_imu_pct,stance_imu_s,swing_imu_s,pushoff_pct,"
               "tilt_range_deg,pitch_range_deg,peak_acc_ms2,heel_share,met1_share,met5_share,hs_imu_ms,to_imu_ms,"
               "to_fsr_ms,bout")
UPRIGHT = ("STRAIGHT", "UPRIGHT")  # the pipeline already relabels Hemel's LEAN_FORWARD as UPRIGHT


def app_context(ctx, label):
    """Pipeline session context -> the app's minute context (which sets the place for baselines)."""
    if ctx == "sleep":
        return "sleep"
    if ctx in ("walk", "outdoor_walk", "gait_test"):
        return "walk"
    if ctx == "transport":  # a vehicle: the app's toggles are rickshaw or metro/bus
        return "metro_bus" if any(w in label.lower() for w in ("metro", "bus", "train")) else "rickshaw"
    return ctx if isinstance(ctx, str) else ""  # indoor, awake, '' (indoor counts as indoors in the app)


def fmt(v, digits=None):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return ""
    if isinstance(v, (bool, np.bool_)):
        return "1" if v else "0"
    if isinstance(v, (int, np.integer)):
        return str(int(v))
    if isinstance(v, (float, np.floating)):
        return str(round(float(v), digits)) if digits is not None else repr(float(v))
    return str(v).replace(",", " ")


def import_day(day_dir: Path, out: Path):
    if not (day_dir / "day_config.json").exists():
        print(f"  {day_dir}: no day_config.json — not a pipeline day folder; skipped")
        return None
    cfg = json.loads((day_dir / "day_config.json").read_text(encoding="utf-8-sig"))
    date = cfg["date"]
    res = day_dir / "analysis_output"
    mt_path = res / "minute_table.csv"
    if not mt_path.exists():
        print(f"  {day_dir.name}: no analysis_output/minute_table.csv — run the pipeline for this day first; skipped")
        return None
    target = out / "daily" / date
    old = target / "daily_summary.json"
    if old.exists() and not json.loads(old.read_text()).get("imported"):
        print(f"  {date}: already has a day recorded by the app; not overwritten")
        return None
    target.mkdir(parents=True, exist_ok=True)
    labels = {s["key"]: s.get("label", "") for s in cfg.get("sessions", [])}

    # ---- minute table
    mt = pd.read_csv(mt_path)
    t = pd.to_datetime(mt.minute, utc=True, format="ISO8601")
    mt["minute"] = t.dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    mt["context"] = [app_context(c, labels.get(s, "")) for c, s in zip(mt.context, mt.session)]
    lock = mt.hr_cadence_lock.astype(str).str.lower().isin(["true", "1"])
    mt["hr_cadence_lock"] = lock.map({True: "1", False: "0"})
    cols = MINUTE_HEADER.split(",")
    rows = [",".join(fmt(r[c], 3 if c != "minute" else None) for c in cols) for _, r in mt[cols].iterrows()]
    (target / "minute_summary.csv").write_text(MINUTE_HEADER + "\n" + "\n".join(rows) + "\n", encoding="utf-8")

    # ---- strides (every gait session of the day, per foot)
    counts = {}
    for side in ("R", "L"):
        parts = [pd.read_csv(p) for p in sorted(res.glob(f"strides_*_{side}.csv"))]
        s = pd.concat(parts, ignore_index=True).sort_values("hs_ms") if parts else pd.DataFrame(columns=STRIDE_COLS.split(","))
        s = s.reindex(columns=STRIDE_COLS.split(","))
        (target / f"strides_{side}.csv").write_text(
            STRIDE_COLS + "\n" + "".join(",".join(fmt(v, 4) for v in row) + "\n" for row in s.itertuples(index=False)),
            encoding="utf-8")
        counts[side] = len(s)

    # ---- day totals, computed from the minute table the same way the app does
    hr_ok = mt.hr.notna() & ~lock
    awake = mt.hr[hr_ok & (mt.context != "sleep")]
    asleep = mt.hr[hr_ok & (mt.context == "sleep")]
    pose = mt.posture.dropna()
    summary = {
        "date": date, "imported": True, "source": f"thesis pipeline ({day_dir.name})",
        "gait": {"stepsBand": float(mt.steps_band.sum()) if mt.steps_band.notna().any() else None,
                 "stepsInsole": float(mt.steps_insole.sum()) if mt.steps_insole.notna().any() else 0,
                 "strides": counts},
        "heart": {"awakeMeanHr": float(awake.mean()) if len(awake) else None,
                  "sleepMeanHr": float(asleep.mean()) if len(asleep) else None},
        "hydration": {"totalMl": float(mt.water_ml.sum()) if mt.water_ml.notna().any() else None},
        "posture": {"uprightPct": float(100 * pose.isin(UPRIGHT).mean()) if len(pose) else None},
    }
    (target / "daily_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"  {date}: {len(mt)} minutes, strides R {counts['R']} / L {counts['L']}, "
          f"HR awake {summary['heart']['awakeMeanHr'] or '-'}, asleep {summary['heart']['sleepMeanHr'] or '-'}")
    return date


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True, type=Path, help="output folder (gets a daily/ subfolder)")
    ap.add_argument("days", nargs="+", type=Path, help="pipeline day folders (with day_config.json)")
    a = ap.parse_args(argv)
    print(f"Importing {len(a.days)} day(s) into {a.out / 'daily'}")
    done = [d for d in (import_day(p, a.out) for p in a.days) if d]
    print(f"{len(done)} day(s) written. Now:\n"
          f"  adb push {a.out / 'daily'}/. /sdcard/Android/data/com.gaittwinapp/files/import/daily/\n"
          f"  adb shell am force-stop com.gaittwinapp   (then open the app)")
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
