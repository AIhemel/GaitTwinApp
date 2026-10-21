"""Digital-twin context layer: fusion of place (B, environment node) and activity (C, insoles) per minute.

Usage:  python ml_fusion.py <subject_dir>

Twin states: bedroom, indoor-still, outdoor-walking, vehicle. Labels from the participant's sessions and notes plus the
wrist band's step count (independent of both input sensors):
  bedroom          overnight session
  indoor-still     indoor session and 0 band steps in the minute
  outdoor-walking  walk session and >= 80 band steps
  vehicle          noted ride
Inputs per minute: out-of-fold place probabilities (B), out-of-fold activity probabilities averaged over the minute's
windows (C; missing when no insole streamed) and phone GPS speed. All B and C probabilities were produced by models
that never saw the minute's day, so the stacked model is also tested leave-one-day-out.
Writes <subject_dir>/ml/fusion/ and ml/figures/F*.pdf.
"""
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import f1_score, precision_recall_fscore_support, confusion_matrix

import daily_analysis as da
from daily_analysis import C, fig_size
from compare_days import Days
from ml_activity import sticky_viterbi, save_fig, CLASSES, WIN
from ml_place import PLACES

warnings.filterwarnings("ignore")
STATES = ["bedroom", "indoor-still", "outdoor-walking", "vehicle"]
B_KEY = "logreg_notime"   # best place model without time of day


def build(D, root):
    B = pd.read_pickle(root / "B_place" / "oof_predictions.pkl")
    Cw = pd.read_pickle(root / "C_activity" / "oof_predictions.pkl")
    Cw["minute"] = pd.to_datetime(Cw.ws + WIN * 500, unit="ms", utc=True).dt.tz_convert(da.TZ).dt.floor("1min")
    Cm = Cw.groupby(["day", "minute"])[[f"gbm_p_{c}" for c in CLASSES]].mean().reset_index()
    rows = []
    for n in D.n:
        mt = D.minutes(n).reset_index()
        mt["day"] = n
        rows.append(mt[["minute", "day", "steps_band", "gps_speed_mps", "hr", "pm25", "co2_ppm", "steps_insole",
                        "context", "session"]])
    M = pd.concat(rows)
    df = B.merge(Cm, on=["day", "minute"], how="left").merge(M, on=["day", "minute"], how="left",
                                                               suffixes=("", "_mt"))
    lab = []
    for r in df.itertuples():
        if r.label == "vehicle":
            lab.append("vehicle")
        elif r.label == "bedroom":
            lab.append("bedroom")
        elif r.label == "indoor" and r.steps_band == 0:
            lab.append("indoor-still")
        elif r.label == "outdoor" and r.steps_band >= 80:
            lab.append("outdoor-walking")
        else:
            lab.append(None)
    df["state"] = lab
    return df.sort_values(["day", "minute"]).reset_index(drop=True)


def features(df, use_b=True, use_c=True, use_gps=True):
    X = pd.DataFrame(index=df.index)
    if use_b:
        for c in PLACES:
            X[f"b_{c}"] = df[f"{B_KEY}_p_{c}"]
    if use_c:
        for c in CLASSES:
            X[f"c_{c}"] = df[f"gbm_p_{c}"].fillna(0)
        X["c_missing"] = df["gbm_p_walking"].isna().astype(float)
    if use_gps:
        X["gps"] = df.gps_speed_mps.fillna(0).clip(0, 20)
        X["gps_missing"] = df.gps_speed_mps.isna().astype(float)
    return X


def lodo(df, X):
    lab = df.state.isin(STATES).to_numpy()
    proba = np.full((len(df), len(STATES)), np.nan)
    for n in sorted(df.day.unique()):
        tr, te = lab & (df.day != n).to_numpy(), (df.day == n).to_numpy()
        m = make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000, class_weight="balanced", C=0.5))
        m.fit(X[tr], df.state[tr])
        p = m.predict_proba(X[te])
        cl = list(m.classes_)
        proba[te] = np.column_stack([p[:, cl.index(s)] if s in cl else np.zeros(len(p)) for s in STATES])
    return proba


def smooth(df, proba, stay=0.98):
    pred = np.full(len(df), None, object)
    for (n, s), g in df.groupby(["day", "session"]):
        idx = g.sort_values("minute").index.to_numpy()
        gaps = np.diff(df.minute[idx].astype("int64")) / 6e10
        br = np.r_[0, np.where(gaps > 2)[0] + 1, len(idx)]
        for a, b in zip(br[:-1], br[1:]):
            pred[idx[a:b]] = [STATES[i] for i in sticky_viterbi(proba[idx[a:b]], stay)]
    return pred


def report(df, pred, mask=None):
    lab = df.state.isin(STATES).to_numpy() & (mask if mask is not None else True)
    y, p = df.state[lab].to_numpy(), pred[lab]
    P, R, F, N = precision_recall_fscore_support(y, p, labels=STATES, zero_division=0)
    return {"macro_f1": round(float(f1_score(y, p, labels=STATES, average="macro", zero_division=0)), 3),
            "per_class": {c: {"precision": round(float(P[i]), 3), "recall": round(float(R[i]), 3),
                              "f1": round(float(F[i]), 3), "n": int(N[i])} for i, c in enumerate(STATES)},
            "confusion": confusion_matrix(y, p, labels=STATES).tolist()}


def place_only_pred(df):
    """B alone mapped onto the twin states (bedroom, indoor -> indoor-still, outdoor -> outdoor-walking, vehicle)."""
    P = df[[f"{B_KEY}_p_{c}" for c in PLACES]].to_numpy()
    return smooth(df, P)


def activity_only_pred(df):
    """C alone: walking -> outdoor-walking, still -> indoor-still, vehicle -> vehicle; no insole -> bedroom."""
    P = df[[f"gbm_p_{c}" for c in CLASSES]].to_numpy()
    out = np.full((len(df), len(STATES)), 0.0)
    has = ~np.isnan(P).any(axis=1)
    out[has, STATES.index("outdoor-walking")] = P[has, 0]
    out[has, STATES.index("indoor-still")] = P[has, 1]
    out[has, STATES.index("vehicle")] = P[has, 2]
    out[~has, STATES.index("bedroom")] = 1.0
    return smooth(df, out + 1e-3)


STATE_PARTS = {"bedroom": ("bedroom", "still"), "indoor-still": ("indoor", "still"),
               "outdoor-walking": ("outdoor", "walking"), "vehicle": ("vehicle", "vehicle")}


def product_pred(df):
    """Product of experts: P(state) ~ P_place(place of state) x P_activity(activity of state).

    Treats the air (B) and the feet (C) as independent witnesses; needs no training of its own. Without insole data
    the activity factor is uninformative and the place model decides alone."""
    PB = {c: df[f"{B_KEY}_p_{c}"].to_numpy() for c in PLACES}
    PC = {c: df[f"gbm_p_{c}"].to_numpy() for c in CLASSES}
    out = np.zeros((len(df), len(STATES)))
    for j, s in enumerate(STATES):
        place, act = STATE_PARTS[s]
        pc = np.where(np.isnan(PC[act]), 1.0, PC[act])
        out[:, j] = PB[place] * (0.05 + pc)  # small floor: one confident witness cannot fully veto the other
    out /= out.sum(1, keepdims=True)
    return smooth(df, out)


def run(subject_dir):
    D = Days(subject_dir, clean=False)
    root = Path(subject_dir).resolve() / "ml"
    out = root / "fusion"
    out.mkdir(parents=True, exist_ok=True)
    df = build(D, root)
    res = {"minutes": int(len(df)), "states": {str(k): int(v) for k, v in df.state.value_counts(dropna=False).items()}}
    both = df.gbm_p_walking.notna().to_numpy()
    res["minutes_with_insoles"] = int(both.sum())
    preds = {"place only (B)": place_only_pred(df), "activity only (C)": activity_only_pred(df)}
    for name, kw in (("fused B+C", {}), ("fused B+C+GPS", {}),):
        X = features(df, use_gps=name.endswith("GPS"))
        preds[name] = smooth(df, lodo(df, X))
    preds["fused (product)"] = product_pred(df)
    for name, p in preds.items():
        res[name] = {"all": report(df, p), "with_insoles": report(df, p, both)}
        r = res[name]["all"]
        print(f"{name:20s} macro-F1 {r['macro_f1']:.3f} (with insoles {res[name]['with_insoles']['macro_f1']:.3f})  " +
              "  ".join(f"{c}: P {v['precision']:.2f} R {v['recall']:.2f}" for c, v in r["per_class"].items()))
    best = max(("fused B+C+GPS", "fused (product)"), key=lambda k: res[k]["all"]["macro_f1"])
    res["best"] = best
    df["pred"] = preds[best]
    df.to_pickle(out / "twin_minutes.pkl")
    (out / "results.json").write_text(json.dumps(res, indent=1, default=str))
    plot(res, df, preds, root / "figures", D)
    return res


def plot(res, df, preds, figdir, D):
    # F1: per-state F1 for each source
    names = list(preds)
    fig, ax = plt.subplots(figsize=fig_size(2.9), layout="constrained")
    x = np.arange(len(STATES))
    cols = [C["ink2"], C["aqua"], C["orange"], C["blue"], C["violet"]]
    w = 0.8 / len(names)
    for k, nm in enumerate(names):
        v = [res[nm]["all"]["per_class"][s]["f1"] for s in STATES]
        ax.bar(x + (k - (len(names) - 1) / 2) * w, v, w * 0.95, color=cols[k], label=f"{nm} ({res[nm]['all']['macro_f1']:.2f})")
    ax.set_xticks(x, [s.replace("-", "-\n") for s in STATES])
    ax.set(ylabel="F1 (leave-one-day-out)", ylim=(0, 1.05))
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.32), ncol=2, fontsize=9, frameon=False)
    ax.grid(axis="x", visible=False)
    save_fig(fig, figdir, "F1_fusion")
    # F2: the digital twin of day 6
    plot_twin_day(df, 6, figdir, D)


def plot_twin_day(df, n, figdir, D):
    d = df[df.day == n].sort_values("minute")
    mt = D.minutes(n)
    fig = plt.figure(figsize=fig_size(4.2), layout="constrained")
    gs = fig.add_gridspec(5, 1, height_ratios=[0.55, 0.55, 1, 1, 1])
    ax = [fig.add_subplot(gs[0])]
    ax += [fig.add_subplot(gs[i], sharex=ax[0]) for i in range(1, 5)]
    scol = {"bedroom": C["violet"], "indoor-still": C["aqua"], "outdoor-walking": C["orange"], "vehicle": C["red"]}
    for row, col, title in ((0, "state", "Truth (notes + band)"), (1, "pred", "Twin estimate")):
        for s, c in scol.items():
            sel = d[d[col] == s]
            ax[row].bar(sel.minute, 1, width=1 / 1440, color=c, align="edge", lw=0)
        ax[row].set_yticks([])
        ax[row].set_ylabel(title, rotation=0, ha="right", va="center", fontsize=9)
        ax[row].set_ylim(0, 1)
        ax[row].grid(False)
    handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in scol.values()]
    fig.legend(handles, [s.replace("-", " ") for s in scol], loc="outside upper center", ncol=4, fontsize=9)
    t = mt.index
    ax[2].plot(t, mt.steps_insole.where(mt.steps_insole > 0), color=C["blue"], lw=1, label="Insole steps")
    ax[2].plot(t, mt.steps_band.where(mt.steps_band > 0), color=C["ink2"], lw=0.8, ls=":", label="Band steps")
    ax[2].set(ylabel="Steps/min")
    ax[2].legend(loc="upper left", fontsize=8.5, ncol=2)
    ax[3].plot(t, mt.co2_ppm, color=C["ink"], lw=1)
    ax[3].set_ylabel("CO$_2$ (ppm)")
    a2 = ax[3].twinx()
    a2.plot(t, mt.pm25, color=C["orange"], lw=0.9)
    a2.set_ylabel("PM$_{2.5}$", color=C["orange"])
    a2.set_yscale("log")
    a2.grid(False)
    ax[4].plot(t, mt.hr, color=C["red"], lw=0.8)
    ax[4].set(ylabel="HR (bpm)", xlabel="Local time")
    lo = d.minute.min().floor("h")
    ax[4].set_xlim(lo, d.minute.max().ceil("h"))
    ax[4].xaxis.set_major_locator(mdates.HourLocator(interval=3, tz=da.TZ))
    ax[4].xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=da.TZ))
    for a in ax[:4]:
        a.tick_params(axis="x", labelbottom=False)
    save_fig(fig, figdir, f"F2_twin_day{n}")


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "..")
