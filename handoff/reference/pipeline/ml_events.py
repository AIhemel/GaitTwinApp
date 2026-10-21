"""ML task E: unusual events without training labels (anomaly / change detection).

Usage:  python ml_events.py <subject_dir>

1. Slip detection: every step in every walk (heel strikes from the IMU stream) is described by impact size, secondary
   peaks, rotation speed, tilt range and duration, each expressed relative to that walk's own typical step (robust
   z-score). An isolation forest scores how unusual each step is. Check: where does the participant's real slip rank,
   and how many false alarms per walking hour would a threshold that catches it give?
2. Exposure spikes: a fast rise of PM2.5 (x3 and +75 ug/m3) or CO2 (+400 ppm) above a trailing 10-minute median of
   the 10-s environment data, merged into episodes, each with a fingerprint (fine-particle share at the peak, CO2
   rise, temperature change). Checked against the participant's noted events.
Writes <subject_dir>/ml/E_events/ and ml/figures/E*.pdf.
"""
import json
import pickle
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from scipy.signal import find_peaks
from sklearn.ensemble import IsolationForest

import daily_analysis as da
from daily_analysis import C, fig_size
from compare_days import Days
from ml_gait import session_obj, CHANNELS
from ml_activity import save_fig

warnings.filterwarnings("ignore")
FS = 100
SLIP = {"day": 7, "side": "R", "time": "2026-10-14 19:21:02"}
STEP_FEATS = ["impact", "second_peak", "rot_max", "tilt_range", "duration", "jerk"]


# =========================================================================== 1. slips
def steps_of(seg):
    X = {c: seg["X"][i] for i, c in enumerate(CHANNELS)}
    acc = X["acc"]
    pk, _ = find_peaks(acc, height=np.median(acc) + 14, distance=int(0.6 * FS))
    rows = []
    for a, b in zip(pk[:-1], pk[1:]):
        dur = (b - a) / FS
        if not 0.4 <= dur <= 3.0:
            continue
        inner = acc[a + 8:b - 8] if b - a > 20 else acc[a:b]
        rows.append({"t": seg["t"][a], "impact": acc[a], "second_peak": inner.max() if len(inner) else np.nan,
                     "rot_max": X["rot_speed"][a:b].max(), "tilt_range": np.ptp(X["tilt"][a:b]), "duration": dur,
                     "jerk": np.abs(np.diff(acc[max(a - 5, 0):a + 6])).max()})
    s = pd.DataFrame(rows)
    if len(s) < 30:
        return None
    for f in STEP_FEATS:  # relative to this walk's typical step
        med = s[f].median()
        mad = 1.4826 * (s[f] - med).abs().median() + 1e-6
        s[f"z_{f}"] = (s[f] - med) / mad
    s["day"], s["session"], s["side"] = seg["day"], seg["session"], seg["side"]
    return s


def slip_analysis(root, D):
    data = pickle.loads((root / "A_gait" / "stream_segments.pkl").read_bytes())
    steps = [s for s in (steps_of(seg) for seg in data if seg["kind"] == "walk") if s is not None]
    S = pd.concat(steps, ignore_index=True)
    Z = S[[f"z_{f}" for f in STEP_FEATS]].clip(-30, 30).fillna(0)
    iso = IsolationForest(n_estimators=400, random_state=0).fit(Z)
    S["score"] = -iso.score_samples(Z)
    S["max_z"] = Z.abs().max(axis=1)
    S["time"] = pd.to_datetime(S.t, unit="ms", utc=True).dt.tz_convert(da.TZ)
    slip_t = pd.Timestamp(SLIP["time"], tz=da.TZ)
    cand = S[(S.day == SLIP["day"]) & (S.side == SLIP["side"]) & ((S.time - slip_t).abs() <= pd.Timedelta(seconds=1.5))]
    walk_h = S.duration.sum() / 3600
    res = {"steps": int(len(S)), "walking_hours": round(walk_h, 2)}
    if len(cand):
        i = cand.score.idxmax()
        for key in ("score", "max_z"):
            rank = int((S[key] > S.loc[i, key]).sum()) + 1
            res[f"slip_rank_{key}"] = rank
            res[f"slip_false_alarms_per_hour_{key}"] = round((rank - 1) / walk_h, 2)
        zi = S.z_impact
        res["slip_rank_z_impact"] = int((zi > zi[i]).sum()) + 1
        res["z_impact_next_highest"] = round(float(zi.drop(i).max()), 2)
        res["z_impact_steps_above_5"] = int((zi > 5).sum())
        res["slip_step"] = {k: (round(float(v), 2) if isinstance(v, (float, np.floating)) else str(v))
                            for k, v in S.loc[i, ["time", "impact", "second_peak", "rot_max", "tilt_range", "duration",
                                                  "z_impact", "z_jerk", "score", "max_z"]].items()}
    # what are the most unusual steps? match against noted events (+-30 s)
    ev = []
    for n in D.n:
        for e in D.cfg[n].get("events", []):
            at = lambda v: pd.Timestamp(v if len(v) > 8 else f"{D.cfg[n]['date']} {v}", tz=da.TZ)
            ev.append((n, at(e["start"]) - pd.Timedelta(seconds=30), at(e["end"]) + pd.Timedelta(seconds=30), e["label"]))
    top = S.sort_values("score", ascending=False).head(15)
    res["top_steps"] = [{"day": int(r.day), "time": f"{r.time:%H:%M:%S}", "side": r.side, "score": round(r.score, 3),
                         "impact": round(r.impact, 1), "duration": round(r.duration, 2),
                         "noted_event": next((l for n, a, b, l in ev if n == r.day and a <= r.time <= b), None)}
                        for r in top.itertuples()]
    S.to_pickle(root / "E_events" / "steps.pkl")
    return res, S


# =========================================================================== 2. exposure spikes
def spike_analysis(D):
    episodes = []
    noted = []
    for n in D.n:
        off = float(D.cfg[n].get("temp_offset_c", 0))
        at = lambda v: pd.Timestamp(v if len(v) > 8 else f"{D.cfg[n]['date']} {v}", tz=da.TZ)
        for e in D.cfg[n].get("events", []):
            noted.append({"day": n, "start": at(e["start"]), "end": at(e["end"]), "label": e["label"]})
        for sm in D.summary[n]["sessions"]:
            sess = session_obj(D, n, sm["key"])
            if not sess.has("environment"):
                continue
            e = sess.read("environment")
            if len(e) < 60:
                continue
            e = e.assign(t=da.to_local(e.utc_ms), temp_c=e.temp_c.astype(float) + off).sort_values("t").set_index("t")
            e = e[["pm1", "pm25", "pm10", "co2_ppm", "temp_c", "dba"]].astype(float)
            base_pm = e.pm25.rolling("10min", min_periods=6).median().shift(1)
            base_co2 = e.co2_ppm.rolling("10min", min_periods=6).median().shift(1)
            flag_pm = (e.pm25 > np.maximum(3 * base_pm, base_pm + 75))
            flag_co2 = (e.co2_ppm > base_co2 + 400)
            flag = (flag_pm | flag_co2).fillna(False).to_numpy()
            t = e.index
            i = 0
            while i < len(flag):
                if not flag[i]:
                    i += 1
                    continue
                j = i
                while j + 1 < len(flag) and (flag[j + 1] or (j + 2 < len(flag) and flag[j + 2]
                                                              and (t[j + 2] - t[j]).total_seconds() <= 60)):
                    j += 1
                seg = e.iloc[i:j + 1]
                if len(seg) >= 2:
                    k = seg.pm25.idxmax()
                    episodes.append({
                        "day": n, "session": sm["key"], "context": sm["context"], "start": t[i], "end": t[j],
                        "duration_s": (t[j] - t[i]).total_seconds() + 10,
                        "pm25_base": float(base_pm.iloc[i]), "pm25_peak": float(seg.pm25.max()),
                        "pm1_share": float(e.pm1[k] / max(e.pm10[k], 1)),
                        "co2_base": float(base_co2.iloc[i]), "co2_rise": float(seg.co2_ppm.max() - base_co2.iloc[i]),
                        "temp_change": float(e.temp_c.iloc[min(j + 6, len(e) - 1)] - e.temp_c.iloc[max(i - 1, 0)]),
                        "trigger": "PM" if flag_pm.iloc[i:j + 1].any() and not flag_co2.iloc[i:j + 1].any()
                        else "CO2" if not flag_pm.iloc[i:j + 1].any() else "PM+CO2"})
                i = j + 1
    E = pd.DataFrame(episodes)
    for r in E.itertuples():
        hit = [x["label"] for x in noted if x["day"] == r.day and x["start"] - pd.Timedelta(minutes=2) <= r.end
               and x["end"] + pd.Timedelta(minutes=2) >= r.start]
        E.loc[r.Index, "noted"] = "; ".join(hit) if hit else None
    exposure_words = ("dinner", "market", "smoke", "soldering", "metro train", "metro station")
    targets = [x for x in noted if any(w in x["label"].lower() for w in exposure_words)]
    found = []
    for x in targets:
        m = E[(E.day == x["day"]) & (E.start <= x["end"] + pd.Timedelta(minutes=2)) &
              (E.end >= x["start"] - pd.Timedelta(minutes=2))]
        found.append({"day": x["day"], "event": x["label"], "detected": bool(len(m)),
                      "peak_pm25": float(m.pm25_peak.max()) if len(m) else None,
                      "co2_rise": float(m.co2_rise.max()) if len(m) else None})
    return E, found


# =========================================================================== figures
def plot(res, S, E, figdir):
    # E1: slip
    fig, ax = plt.subplots(2, 1, figsize=fig_size(3.6), layout="constrained", gridspec_kw={"height_ratios": [1.3, 1]})
    w = S[(S.day == 7) & (S.side == "R") & (S.session == "N")].sort_values("time")
    ax[0].plot(w.time, w.z_impact, ".", color=C["ink2"], ms=3)
    slip_t = pd.Timestamp(SLIP["time"], tz=da.TZ)
    near = w.iloc[(w.time - slip_t).abs().argsort()[:1]]
    ax[0].plot(near.time, near.z_impact, "o", ms=9, mfc="none", mec=C["red"], mew=2)
    ax[0].annotate("slip", (near.time.iloc[0], near.z_impact.iloc[0]), xytext=(8, -2), textcoords="offset points",
                   color=C["red"], fontsize=10)
    ax[0].set(ylabel="Impact (robust z)", title="(a) Every right-foot step of the day-7 evening walk")
    ax[0].xaxis.set_major_locator(mdates.MinuteLocator(byminute=range(0, 60, 5), tz=da.TZ))
    ax[0].xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=da.TZ))
    z = S.z_impact.clip(-10, 10)
    ax[1].hist(z, bins=np.linspace(-6, 7, 66), color=C["band"], edgecolor=C["ink2"], lw=0.3)
    ax[1].set_yscale("log")
    sz = float(res["slip"]["slip_step"]["z_impact"])
    ax[1].axvline(sz, color=C["red"], lw=1.5)
    ax[1].text(sz - 0.1, ax[1].get_ylim()[1] * 0.5, f"slip: rank {res['slip']['slip_rank_z_impact']} of "
               f"{res['slip']['steps']:,} ", color=C["red"], fontsize=9.5, va="top", ha="right")
    ax[1].set(xlabel="Impact relative to the walk's typical step (robust z)", ylabel="Steps (all days)",
              title="(b) All steps of the study")
    save_fig(fig, figdir, "E1_slip")
    # E2: exposure fingerprints
    fig, ax = plt.subplots(figsize=fig_size(3.3), layout="constrained")
    cats = {"soldering": C["violet"], "smoke": C["red"], "market": C["orange"], "dinner": C["yellow"],
            "metro": C["blue"]}
    for r in E.itertuples():
        noted = r.noted if isinstance(r.noted, str) else ""
        lab = noted.lower()
        col = next((c for k, c in cats.items() if k in lab), C["ink2"])
        ax.scatter(r.pm1_share, max(r.co2_rise, 1), s=15 + 60 * np.log10(max(r.pm25_peak, 10)) ** 2 / 4,
                   color=col, alpha=0.8 if noted else 0.35, edgecolor="white", lw=0.5)
    ax.set_yscale("symlog", linthresh=50)
    ax.set(xlabel="Fine-particle share at the peak (PM$_1$/PM$_{10}$)", ylabel="CO$_2$ rise (ppm)",
           xlim=(0, 1.05))
    handles = [plt.Line2D([], [], marker="o", ls="", color=c, label=k.capitalize()) for k, c in cats.items()]
    handles.append(plt.Line2D([], [], marker="o", ls="", color=C["ink2"], alpha=0.35, label="Not noted"))
    ax.legend(handles=handles, loc="lower right", fontsize=9, ncol=2)
    save_fig(fig, figdir, "E2_exposure_fingerprints")


def run(subject_dir):
    D = Days(subject_dir, clean=False)
    root = Path(subject_dir).resolve() / "ml"
    (root / "E_events").mkdir(parents=True, exist_ok=True)
    res = {}
    res["slip"], S = slip_analysis(root, D)
    print(json.dumps({k: v for k, v in res["slip"].items() if k != "top_steps"}, indent=1, default=str))
    for t in res["slip"]["top_steps"]:
        print("  top step", t)
    E, found = spike_analysis(D)
    E.to_csv(root / "E_events" / "exposure_episodes.csv", index=False)
    res["exposure"] = {"episodes": int(len(E)), "noted_events": found,
                       "episodes_by_day": E.groupby("day").size().to_dict(),
                       "noted_episodes": int(E.noted.notna().sum()),
                       "by_trigger": E.trigger.value_counts().to_dict(),
                       "by_context": E.groupby("context").size().to_dict()}
    print(json.dumps(res["exposure"], indent=1, default=str))
    (root / "E_events" / "results.json").write_text(json.dumps(res, indent=1, default=str))
    plot(res, S, E, root / "figures")
    return res


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "..")
