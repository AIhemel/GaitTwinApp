"""ML task C: activity (walking / still / vehicle) from the insoles, labels from independent sources.

Usage:  python ml_activity.py <subject_dir> [--rebuild]

Labels never come from the insoles themselves (that would be circular):
  walking  minute with >= 80 steps on the WRIST BAND
  still    minute with 0 band steps
  vehicle  participant notes / transport sessions (rickshaw, metro, vehicle)
  stairs, lift: participant notes, kept as case studies (too few to train)
Inputs: 10-s windows (5-s step) of each insole's IMU (+ optional pressure, + optional phone GPS speed).
Model: gradient boosting (handles a missing foot), then temporal smoothing (sticky Viterbi).
Evaluation: leave-one-day-out; per-class precision/recall, macro-F1, confusion matrix.
Writes <subject_dir>/ml/C_activity/.
"""
import json
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy.signal import find_peaks
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import confusion_matrix, f1_score, precision_recall_fscore_support

import daily_analysis as da
from daily_analysis import C, fig_size
from compare_days import Days
from ml_gait import imu_signals

FS = 50
WIN, STEP = 10, 5           # seconds
CLASSES = ["walking", "still", "vehicle"]
RAW_CH = ["acc", "tilt", "tilt_rate", "rot_speed"]
VEHICLE_WORDS = ("rickshaw", "metro", "vehicle", "train")


# =========================================================================== features
def foot_features(seg, load):
    acc, tilt, rate, rot = seg["acc"], seg["tilt"], seg["tilt_rate"], seg["rot_speed"]
    a0 = acc - acc.mean()
    f = {"acc_mean": acc.mean(), "acc_std": acc.std(), "acc_p95": np.percentile(acc, 95), "acc_max": acc.max(),
         "jerk_std": np.diff(acc).std(), "tilt_range": np.percentile(tilt, 95) - np.percentile(tilt, 5),
         "tilt_std": tilt.std(), "rate_std": rate.std(), "rot_mean": rot.mean(), "rot_p95": np.percentile(rot, 95)}
    spec = np.abs(np.fft.rfft(a0 * np.hanning(len(a0)))) ** 2
    fr = np.fft.rfftfreq(len(a0), 1 / FS)
    tot = spec[(fr > 0.3)].sum() + 1e-9
    f.update({"p_gait": spec[(fr >= 0.5) & (fr < 3)].sum() / tot, "p_mid": spec[(fr >= 3) & (fr < 8)].sum() / tot,
              "p_vib": spec[(fr >= 8)].sum() / tot})
    band = (fr >= 0.3) & (fr <= 3)
    f["f_dom"] = fr[band][np.argmax(spec[band])]
    ac = np.correlate(a0, a0, "full")[len(a0) - 1:] / (a0.var() * len(a0) + 1e-9)
    lag = np.arange(len(ac)) / FS
    m = (lag >= 0.7) & (lag <= 2.0)
    f["ac_peak"], f["ac_lag"] = ac[m].max(), lag[m][np.argmax(ac[m])]
    f["steps"] = len(find_peaks(acc, height=np.median(acc) + 14, distance=int(0.6 * FS))[0])
    if load is not None:
        f.update({"load_mean": load.mean(), "load_std": load.std(), "loaded_frac": (load > 0.3).mean()})
    return f


def bilateral_features(aR, aL):
    """Same-instant vs alternating motion of the two feet (cross-correlation of acceleration)."""
    a, b = aR - aR.mean(), aL - aL.mean()
    xc = np.correlate(a, b, "full") / (a.std() * b.std() * len(a) + 1e-9)
    lag = (np.arange(len(xc)) - (len(a) - 1)) / FS
    same = np.abs(xc[np.abs(lag) <= 0.15]).max()
    alt = np.abs(xc[(np.abs(lag) >= 0.3) & (np.abs(lag) <= 1.0)]).max()
    return {"bi_same": same, "bi_alt": alt, "bi_ratio": alt / (same + 1e-3)}


# =========================================================================== dataset
def folder_spans(D, n):
    """Each recording folder with insole data and its time span (from the day's sessions)."""
    spans = {}
    for sc, sm in zip(D.cfg[n]["sessions"], D.summary[n]["sessions"]):
        folder = D.dirs[D.n.index(n)] / sc["folder"]
        if not (folder / "gait.csv").exists():
            continue
        a, b = (pd.Timestamp(sm[k]).tz_localize(da.TZ) for k in ("start", "end"))
        lo, hi = spans.get(folder, (a, b))
        spans[folder] = (min(lo, a), max(hi, b))
    return spans


def side_windows(d):
    dt = np.diff(d.t.to_numpy(float))
    fs = len(d) / max(1e-9, (d.t.iloc[-1] - d.t.iloc[0] - dt[dt > 200].sum()) / 1000)  # rate over streamed time
    if fs < 40:
        return {}
    sig, _ = imu_signals(d, fs)
    F = d[["Heel_FSR", "Met1_FSR", "Met5_FSR"]].to_numpy(float)
    load = (F / (np.percentile(F, 95, axis=0) + 1)).mean(axis=1)
    sig["load"] = load
    t = d.t.to_numpy(float)
    out = {}
    w0 = np.ceil(t[0] / (STEP * 1000)) * STEP * 1000
    for ws in np.arange(w0, t[-1] - WIN * 1000, STEP * 1000):
        a, b = np.searchsorted(t, ws), np.searchsorted(t, ws + WIN * 1000)
        if b - a < 0.8 * WIN * fs or (np.diff(t[a:b]) > 200).any():
            continue
        grid = np.arange(ws, ws + WIN * 1000, 1000 / FS)
        seg = {k: np.interp(grid, t[a:b], v[a:b]) for k, v in sig.items()}
        out[int(ws)] = seg
    return out


def build(D):
    rows, raw, present = [], [], []
    for n in D.n:
        mt = D.minutes(n)
        ev = [(pd.Timestamp(e["start"] if len(e["start"]) > 8 else f"{D.cfg[n]['date']} {e['start']}", tz=da.TZ),
               pd.Timestamp(e["end"] if len(e["end"]) > 8 else f"{D.cfg[n]['date']} {e['end']}", tz=da.TZ),
               e["label"].lower()) for e in D.cfg[n].get("events", [])]
        for folder, (t0, t1) in folder_spans(D, n).items():
            sess = da.Session("all", "all", "all", folder, t0, t1, None, True)
            wins = {}
            for side in ("R", "L"):
                try:
                    d = da.gait_timed(sess, side)
                except Exception:
                    d = None
                if d is not None and len(d) > 2000:
                    wins[side] = side_windows(d)
            for ws in sorted(set().union(*[set(w) for w in wins.values()]) if wins else []):
                r = {"day": n, "folder": folder.name, "ws": ws}
                for side, w in wins.items():
                    if ws in w:
                        for k, v in foot_features(w[ws], w[ws]["load"]).items():
                            r[f"{side}_{k}"] = v
                if all(ws in wins.get(s, {}) for s in ("R", "L")):
                    r.update(bilateral_features(wins["R"][ws]["acc"], wins["L"][ws]["acc"]))
                mid = pd.Timestamp(ws + WIN * 500, unit="ms", tz="UTC").tz_convert(da.TZ)
                minute = mid.floor("1min")
                row = mt.loc[minute] if minute in mt.index else None
                r["gps_speed"] = row.gps_speed_mps if row is not None else np.nan
                r["band_steps"] = row.steps_band if row is not None else np.nan
                ctx = row.context if row is not None else None
                lab = None
                hit = [l for a, b, l in ev if a <= mid <= b]
                # vehicle only while actually riding (noted rides); a transport session also contains station walking
                if any(any(v in l for v in VEHICLE_WORDS) for l in hit):
                    lab = "vehicle"
                elif any("stairs" in l for l in hit):
                    lab = "stairs"
                elif any("lift" in l for l in hit):
                    lab = "lift"
                elif row is not None and row.steps_band >= 80:
                    lab = "walking"
                elif row is not None and row.steps_band == 0 and not np.isnan(row.hr):
                    lab = "still"
                r["label"] = lab
                r["context"] = ctx
                rows.append(r)
                # raw 10-s window for the CNN: 4 IMU channels per foot (zeros + flag when a foot is missing)
                arr = np.zeros((len(RAW_CH) * 2, WIN * FS), np.float16)
                pres = np.zeros(2, bool)
                for j, side in enumerate(("R", "L")):
                    if ws in wins.get(side, {}):
                        arr[j * len(RAW_CH):(j + 1) * len(RAW_CH)] = np.stack([wins[side][ws][c] for c in RAW_CH])
                        pres[j] = True
                raw.append(arr)
                present.append(pres)
            print(f"day {n} {folder.name}: {len(wins)} insole(s), {sum(1 for x in rows if x['day'] == n and x['folder'] == folder.name)} windows",
                  flush=True)
    return pd.DataFrame(rows), np.array(raw), np.array(present)


# =========================================================================== model
def sticky_viterbi(P, stay=0.97):
    """Most likely class sequence given per-window probabilities and a 'sticky' transition matrix."""
    k = P.shape[1]
    A = np.full((k, k), (1 - stay) / (k - 1))
    np.fill_diagonal(A, stay)
    logA, logP = np.log(A), np.log(np.clip(P, 1e-6, 1))
    dp, bp = logP[0].copy(), np.zeros((len(P), k), int)
    for i in range(1, len(P)):
        cand = dp[:, None] + logA
        bp[i] = cand.argmax(0)
        dp = cand.max(0) + logP[i]
    path = [int(dp.argmax())]
    for i in range(len(P) - 1, 0, -1):
        path.append(bp[i][path[-1]])
    return np.array(path[::-1])


def feature_cols(df, group):
    imu = [c for c in df if c[:2] in ("R_", "L_") and not any(x in c for x in ("load", "loaded"))]
    sets = {"both": imu + ["bi_same", "bi_alt", "bi_ratio"],
            "right": [c for c in imu if c.startswith("R_")],
            "left": [c for c in imu if c.startswith("L_")],
            "both+fsr": [c for c in df if c[:2] in ("R_", "L_")] + ["bi_same", "bi_alt", "bi_ratio"],
            "both+gps": imu + ["bi_same", "bi_alt", "bi_ratio", "gps_speed"]}
    return sets[group]


def lodo(df, cols, smooth=True):
    lab = df.label.isin(CLASSES).to_numpy()
    pred = np.full(len(df), None, object)
    proba = np.full((len(df), len(CLASSES)), np.nan)
    for n in sorted(df.day.unique()):
        tr = lab & (df.day != n).to_numpy()
        te = (df.day == n).to_numpy()
        m = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, class_weight="balanced",
                                           min_samples_leaf=20, random_state=0)
        m.fit(df.loc[tr, cols], df.label[tr])
        p = m.predict_proba(df.loc[te, cols])
        order = [list(m.classes_).index(c) for c in CLASSES]
        proba[te] = p[:, order]
    if smooth:
        for (n, f), g in df.groupby(["day", "folder"]):
            idx = g.sort_values("ws").index.to_numpy()
            # windows more than 10 s apart start a new sequence
            br = np.r_[0, np.where(np.diff(df.ws[idx].to_numpy()) > 10_000)[0] + 1, len(idx)]
            for a, b in zip(br[:-1], br[1:]):
                pred[idx[a:b]] = [CLASSES[i] for i in sticky_viterbi(proba[idx[a:b]])]
    else:
        pred = np.array([CLASSES[i] for i in np.nanargmax(proba, axis=1)], object)
    return pred, proba


def report(df, pred):
    lab = df.label.isin(CLASSES).to_numpy()
    y, p = df.label[lab].to_numpy(), pred[lab]
    P, R, F, N = precision_recall_fscore_support(y, p, labels=CLASSES, zero_division=0)
    return {"macro_f1": round(float(f1_score(y, p, labels=CLASSES, average="macro")), 3),
            "per_class": {c: {"precision": round(float(P[i]), 3), "recall": round(float(R[i]), 3),
                              "f1": round(float(F[i]), 3), "n": int(N[i])} for i, c in enumerate(CLASSES)},
            "confusion": confusion_matrix(y, p, labels=CLASSES).tolist()}


class ActivityCNN:
    """1D CNN on raw 10-s windows of both feet (8 IMU channels + 2 'foot present' flags) -> activity class.

    Foot dropout during training (one foot blanked in 20 % of windows) teaches it to cope with a missing insole.
    """

    def __init__(self, epochs=30, seed=0):
        import torch
        self.torch, self.epochs, self.seed = torch, epochs, seed
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"

    def _net(self):
        nn = self.torch.nn
        return nn.Sequential(
            nn.Conv1d(10, 32, 9, stride=2, padding=4), nn.BatchNorm1d(32), nn.ReLU(),
            nn.Conv1d(32, 48, 7, stride=2, padding=3), nn.BatchNorm1d(48), nn.ReLU(),
            nn.Conv1d(48, 64, 5, stride=2, padding=2), nn.BatchNorm1d(64), nn.ReLU(),
            nn.Conv1d(64, 64, 5, stride=2, padding=2), nn.BatchNorm1d(64), nn.ReLU(),
            nn.AdaptiveAvgPool1d(1), nn.Flatten(), nn.Dropout(0.3), nn.Linear(64, len(CLASSES)))

    def _prep(self, raw, pres):
        x = (raw.astype(np.float32) - self.mu) / self.sd
        for j in range(2):
            x[~pres[:, j], j * len(RAW_CH):(j + 1) * len(RAW_CH)] = 0
        flags = np.repeat(pres[:, :, None].astype(np.float32), x.shape[2], axis=2)
        return np.concatenate([x, flags], axis=1)

    def fit(self, raw, pres, y):
        torch = self.torch
        torch.manual_seed(self.seed)
        rng = np.random.default_rng(self.seed)
        m = np.repeat(pres, len(RAW_CH), axis=1)
        r32 = raw.astype(np.float32)
        self.mu = np.array([r32[:, c][m[:, c]].mean() if m[:, c].any() else 0.0 for c in range(raw.shape[1])],
                           np.float32)[None, :, None]
        self.sd = np.array([r32[:, c][m[:, c]].std() + 1e-6 if m[:, c].any() else 1.0 for c in range(raw.shape[1])],
                           np.float32)[None, :, None]
        X = self._prep(raw, pres)
        yi = np.array([CLASSES.index(v) for v in y])
        w = len(yi) / (len(CLASSES) * np.bincount(yi, minlength=len(CLASSES)).clip(1))
        Xt = torch.tensor(X, device=self.dev)
        yt = torch.tensor(yi, device=self.dev)
        self.net = self._net().to(self.dev)
        opt = torch.optim.AdamW(self.net.parameters(), lr=2e-3, weight_decay=1e-3)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, self.epochs)
        lossf = torch.nn.CrossEntropyLoss(weight=torch.tensor(w, dtype=torch.float32, device=self.dev))
        nch = len(RAW_CH)
        for _ in range(self.epochs):
            self.net.train()
            for idx in np.array_split(rng.permutation(len(yi)), max(1, len(yi) // 128)):
                xb = Xt[idx].clone()
                both = (xb[:, 2 * nch, 0] > 0) & (xb[:, 2 * nch + 1, 0] > 0)
                drop = torch.tensor(rng.random(len(idx)) < 0.2, device=self.dev) & both
                side = torch.tensor(rng.integers(0, 2, len(idx)), device=self.dev)
                for j in range(2):
                    sel = drop & (side == j)
                    xb[sel, j * nch:(j + 1) * nch] = 0
                    xb[sel, 2 * nch + j] = 0
                xb[:, :2 * nch] *= 1 + 0.1 * torch.randn(len(idx), 2 * nch, 1, device=self.dev)
                loss = lossf(self.net(xb), yt[idx])
                opt.zero_grad()
                loss.backward()
                opt.step()
            sched.step()
        return self

    def predict_proba(self, raw, pres):
        torch = self.torch
        self.net.eval()
        out = []
        with torch.no_grad():
            X = self._prep(raw, pres)
            for i in range(0, len(X), 1024):
                out.append(torch.softmax(self.net(torch.tensor(X[i:i + 1024], device=self.dev)), 1).cpu().numpy())
        return np.concatenate(out)

    def n_params(self):
        return int(sum(p.numel() for p in self.net.parameters()))


def smooth_probs(df, proba):
    pred = np.full(len(df), None, object)
    for (n, f), g in df.groupby(["day", "folder"]):
        idx = g.sort_values("ws").index.to_numpy()
        br = np.r_[0, np.where(np.diff(df.ws[idx].to_numpy()) > 10_000)[0] + 1, len(idx)]
        for a, b in zip(br[:-1], br[1:]):
            pred[idx[a:b]] = [CLASSES[i] for i in sticky_viterbi(proba[idx[a:b]])]
    return pred


def lodo_cnn(df, raw, present, keep_feet=("R", "L")):
    lab = df.label.isin(CLASSES).to_numpy()
    pres = present.copy()
    if keep_feet != ("R", "L"):
        pres[:, 0] &= "R" in keep_feet
        pres[:, 1] &= "L" in keep_feet
    has = pres.any(axis=1)
    proba = np.full((len(df), len(CLASSES)), np.nan)
    params = None
    for n in sorted(df.day.unique()):
        tr = lab & has & (df.day != n).to_numpy()
        te = has & (df.day == n).to_numpy()
        if not te.any():
            continue
        m = ActivityCNN().fit(raw[tr], pres[tr], df.label[tr].to_numpy())
        proba[te] = m.predict_proba(raw[te], pres[te])
        params = m.n_params()
    return proba, params


def report_from_proba(df, proba, smooth):
    ok = ~np.isnan(proba).any(axis=1)
    d2 = df[ok].reset_index(drop=True)
    pred = smooth_probs(d2, proba[ok]) if smooth else np.array([CLASSES[i] for i in proba[ok].argmax(1)], object)
    return report(d2, pred), pred, ok


def run(subject_dir, rebuild=False):
    D = Days(subject_dir, clean=False)
    out = Path(subject_dir).resolve() / "ml" / "C_activity"
    out.mkdir(parents=True, exist_ok=True)
    cache = out / "windows.pkl"
    if cache.exists() and (out / "raw_windows.npz").exists() and not rebuild:
        df = pd.read_pickle(cache)
        z = np.load(out / "raw_windows.npz")
        raw, present = z["raw"], z["present"]
    else:
        df, raw, present = build(D)
        df.to_pickle(cache)
        np.savez(out / "raw_windows.npz", raw=raw, present=present)
    df = df.reset_index(drop=True)
    res = {"windows": int(len(df)), "labels": {str(k): int(v) for k, v in df.label.value_counts(dropna=False).items()},
           "labels_by_day": df[df.label.notna()].groupby(["day", "label"]).size().unstack(fill_value=0).to_dict()}
    print(res["labels"])
    oof = {}
    for group in ("both", "right", "left", "both+fsr", "both+gps"):
        cols = feature_cols(df, group)
        for smooth in (False, True):
            pred, proba = lodo(df, cols, smooth)
            r = report(df, pred)
            res[f"gbm_{group}{'_smoothed' if smooth else ''}"] = r
            print(f"GBM {group:9s} {'smoothed' if smooth else 'raw     '} macro-F1 {r['macro_f1']:.3f}", flush=True)
            if group == "both" and not smooth:
                oof["gbm"] = proba
    for feet, name in ((("R", "L"), "both"), (("R",), "right"), (("L",), "left")):
        proba, params = lodo_cnn(df, raw, present, feet)
        for smooth in (False, True):
            r, pred, ok = report_from_proba(df, proba, smooth)
            res[f"cnn_{name}{'_smoothed' if smooth else ''}"] = r
            print(f"CNN {name:9s} {'smoothed' if smooth else 'raw     '} macro-F1 {r['macro_f1']:.3f}", flush=True)
        if name == "both":
            oof["cnn"] = proba
            res["cnn_params"] = params
    # case studies with the smoothed GBM (both feet)
    pred_g = smooth_probs(df, oof["gbm"])
    cs = {}
    for c in ("stairs", "lift"):
        g = df[df.label == c]
        cs[c] = {"windows": int(len(g)), "predicted": pd.Series(pred_g[g.index]).value_counts().to_dict(),
                 "mean_proba": {k: round(float(oof["gbm"][g.index, i].mean()), 2) for i, k in enumerate(CLASSES)}}
    res["case_studies"] = cs
    # vehicle detection by ride
    rides = ride_names(D, df)
    res["vehicle_by_ride"] = {r: {"windows": int((rides == r).sum()),
                                  "gbm_detected": int(((rides == r) & (pred_g == "vehicle")).sum())}
                              for r in sorted(set(rides) - {None})}
    out_df = df.assign(ride=rides, pred_gbm=pred_g, **{f"gbm_p_{c}": oof["gbm"][:, i] for i, c in enumerate(CLASSES)},
                       **{f"cnn_p_{c}": oof["cnn"][:, i] for i, c in enumerate(CLASSES)})
    out_df.to_pickle(out / "oof_predictions.pkl")
    (out / "results.json").write_text(json.dumps(res, indent=1, default=str))
    plot_activity(res, out_df, Path(subject_dir).resolve() / "ml" / "figures")
    return res


def ride_names(D, df):
    names = np.full(len(df), None, object)
    mid = pd.to_datetime(df.ws + WIN * 500, unit="ms", utc=True).dt.tz_convert(da.TZ)
    for n in D.n:
        for e in D.cfg[n].get("events", []):
            if not any(v in e["label"].lower() for v in VEHICLE_WORDS):
                continue
            at = lambda v: pd.Timestamp(v if len(v) > 8 else f"{D.cfg[n]['date']} {v}", tz=da.TZ)
            sel = (df.day == n).to_numpy() & (mid >= at(e["start"])).to_numpy() & (mid <= at(e["end"])).to_numpy()
            names[sel] = f"D{n} {e['label']}"
    return names


# =========================================================================== figures
def save_fig(fig, figdir, name):
    figdir.mkdir(parents=True, exist_ok=True)
    fig.savefig(figdir / f"{name}.pdf")
    fig.savefig(figdir / f"{name}.png", dpi=200)
    plt.close(fig)


def confusion_panel(ax, cm, title):
    cm = np.array(cm, float)
    rec = cm / cm.sum(1, keepdims=True).clip(1)
    ax.imshow(rec, cmap="Blues", vmin=0, vmax=1)
    for i in range(len(cm)):
        for j in range(len(cm)):
            ax.text(j, i, f"{rec[i, j]:.2f}\n({int(cm[i, j])})", ha="center", va="center", fontsize=8.5,
                    color="white" if rec[i, j] > 0.6 else C["ink"])
    ax.set_xticks(range(len(CLASSES)), [c.capitalize() for c in CLASSES], fontsize=9.5)
    ax.set_yticks(range(len(CLASSES)), [c.capitalize() for c in CLASSES], fontsize=9.5)
    ax.set(xlabel="Predicted", ylabel="True", title=title)
    ax.grid(False)


def plot_activity(res, df, figdir):
    # C1: confusion matrices, gradient boosting vs CNN (both feet, smoothed)
    fig, ax = plt.subplots(1, 2, figsize=fig_size(2.9), layout="constrained")
    confusion_panel(ax[0], res["gbm_both_smoothed"]["confusion"],
                    f"(a) Gradient boosting, F1 {res['gbm_both_smoothed']['macro_f1']:.2f}")
    confusion_panel(ax[1], res["cnn_both_smoothed"]["confusion"],
                    f"(b) CNN, F1 {res['cnn_both_smoothed']['macro_f1']:.2f}")
    ax[1].set_ylabel("")
    save_fig(fig, figdir, "C1_confusion")
    # C2: ablation of inputs (macro-F1, raw vs smoothed)
    rows = [("Both feet", "gbm_both"), ("Right only", "gbm_right"), ("Left only", "gbm_left"),
            ("Both + pressure", "gbm_both+fsr"), ("Both + GPS", "gbm_both+gps"),
            ("CNN both", "cnn_both"), ("CNN right", "cnn_right"), ("CNN left", "cnn_left")]
    fig, ax = plt.subplots(figsize=fig_size(3.0), layout="constrained")
    y = np.arange(len(rows))
    ax.barh(y - 0.18, [res[k]["macro_f1"] for _, k in rows], 0.34, color=C["band"], edgecolor=C["ink2"], label="Per window")
    ax.barh(y + 0.18, [res[k + "_smoothed"]["macro_f1"] for _, k in rows], 0.34, color=C["blue"], label="Smoothed")
    for yi, (_, k) in zip(y, rows):
        ax.text(res[k + "_smoothed"]["macro_f1"] + 0.01, yi + 0.18, f"{res[k + '_smoothed']['macro_f1']:.2f}",
                va="center", fontsize=9)
    ax.set_yticks(y, [r for r, _ in rows])
    ax.invert_yaxis()
    ax.set(xlabel="Macro-F1 (leave-one-day-out)", xlim=(0.4, 1.0))
    ax.legend(loc="lower right", fontsize=9)
    ax.grid(axis="y", visible=False)
    save_fig(fig, figdir, "C2_inputs")
    # C3: vehicle detection by ride, with what the feet felt
    vb = res["vehicle_by_ride"]
    rides = list(vb)
    fig, ax = plt.subplots(1, 2, figsize=fig_size(2.6), layout="constrained", sharey=True)
    y = np.arange(len(rides))
    ax[0].barh(y, [100 * vb[r]["gbm_detected"] / vb[r]["windows"] for r in rides], color=C["orange"])
    ax[0].set(xlabel="Windows detected as vehicle (%)", xlim=(0, 100), title="(a) Detection")
    ax[0].set_yticks(y, [r.replace("metro train", "metro") for r in rides], fontsize=9.5)
    ax[0].invert_yaxis()
    vib = [df[df.ride == r][["R_acc_std", "L_acc_std"]].median(axis=1).median() for r in rides]
    still = df[df.label == "still"][["R_acc_std", "L_acc_std"]].median(axis=1).median()
    ax[1].barh(y, vib, color=C["ink2"])
    ax[1].axvline(still, color=C["blue"], ls="--", lw=1.2)
    ax[1].text(still + 0.05, -0.45, "sitting still", color=C["blue"], fontsize=9, va="center")
    ax[1].set(xlabel="Foot vibration (acc. SD, m/s²)", title="(b) What the feet felt")
    for a in ax:
        a.grid(axis="y", visible=False)
    save_fig(fig, figdir, "C3_vehicles")


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "..", "--rebuild" in sys.argv)
