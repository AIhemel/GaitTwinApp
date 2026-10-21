"""ML task B: "where am I?" from the environment node (bedroom / indoor / outdoor / vehicle).

Usage:  python ml_place.py <subject_dir> [--rebuild]

Labels come from the participant's session contexts and notes: overnight -> bedroom, indoor -> indoor, walks -> outdoor,
noted rides (rickshaw, metro train, vehicle) -> vehicle. Transport sessions outside the rides (stations, markets) and
gait tests are left unlabelled. Unit: 1-minute windows of the 10-s node data, with 5-minute trends.

Models: logistic regression, gradient boosting, and a small 1D CNN on the last 10 minutes of 10-s samples; each with
and without time of day, then sticky-Viterbi smoothing. Leave-one-day-out.
Writes <subject_dir>/ml/B_place/ (results, out-of-fold probabilities for the fusion) and ml/figures/B*.pdf.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.metrics import confusion_matrix, f1_score, precision_recall_fscore_support

import daily_analysis as da
from daily_analysis import C, fig_size
from compare_days import Days
from ml_gait import session_obj
from ml_activity import sticky_viterbi, save_fig, VEHICLE_WORDS

PLACES = ["bedroom", "indoor", "outdoor", "vehicle"]
VARS = ["co2_ppm", "pm1", "pm25", "pm10", "temp_c", "rh_pct", "dba"]
SEQ = 60  # 10 minutes of 10-s samples for the CNN


# =========================================================================== dataset
def build(D):
    rows, seqs = [], []
    for n in D.n:
        off = float(D.cfg[n].get("temp_offset_c", 0))
        at = lambda v: pd.Timestamp(v if len(v) > 8 else f"{D.cfg[n]['date']} {v}", tz=da.TZ)
        rides = [(at(e["start"]), at(e["end"])) for e in D.cfg[n].get("events", [])
                 if any(w in e["label"].lower() for w in VEHICLE_WORDS)]
        for sm in D.summary[n]["sessions"]:
            sess = session_obj(D, n, sm["key"])
            if not sess.has("environment"):
                continue
            e = sess.read("environment")
            if len(e) < 30:
                continue
            e = e.assign(t=da.to_local(e.utc_ms), temp_c=e.temp_c.astype(float) + off).sort_values("t")
            e = e.set_index("t")[VARS].astype(float)
            m = e.resample("1min").agg(["mean", "std"])
            m.columns = [f"{a}_{b}" for a, b in m.columns]
            m = m[e.resample("1min").size() >= 3]  # at least 30 s of data in the minute
            if len(m) < 3:
                continue
            for v in VARS:  # 5-minute context: level, spread and change
                s = m[f"{v}_mean"]
                m[f"{v}_m5"] = s.rolling(5, min_periods=2).mean()
                m[f"{v}_sd5"] = s.rolling(5, min_periods=2).std()
                m[f"{v}_d5"] = s - s.shift(5)
            m["pm1_pm10"] = m.pm1_mean / (m.pm10_mean + 1)
            m["pm25_pm10"] = m.pm25_mean / (m.pm10_mean + 1)
            h = m.index.hour + m.index.minute / 60
            m["hour_sin"], m["hour_cos"] = np.sin(2 * np.pi * h / 24), np.cos(2 * np.pi * h / 24)
            ctx = sm["context"]
            lab = {"overnight": "bedroom", "indoor": "indoor", "outdoor_walk": "outdoor", "walk": "outdoor"}.get(ctx)
            labels = []
            for t in m.index:
                mid = t + pd.Timedelta(seconds=30)
                if any(a <= mid <= b for a, b in rides):
                    labels.append("vehicle")
                elif ctx == "transport":
                    labels.append(None)
                else:
                    labels.append(lab)
            m["label"] = labels
            m["day"], m["session"], m["context"] = n, sm["key"], ctx
            # raw 10-s sequence ending at each minute, for the CNN
            e10 = e.resample("10s").mean().interpolate(limit=3)
            for t in m.index:
                w = e10.loc[t + pd.Timedelta(seconds=60) - pd.Timedelta(seconds=10 * SEQ):t + pd.Timedelta(seconds=50)]
                arr = np.full((len(VARS), SEQ), np.nan, np.float32)
                v = w.to_numpy(np.float32).T
                arr[:, SEQ - v.shape[1]:] = v[:, -SEQ:] if v.shape[1] else arr[:, :0]
                seqs.append(arr)
            rows.append(m.reset_index().rename(columns={"t": "minute"}))
        print(f"day {n}: {sum(len(r) for r in rows if r.day.iloc[0] == n)} minutes", flush=True)
    df = pd.concat(rows, ignore_index=True)
    return df, np.array(seqs)


def feature_cols(df, with_time):
    cols = [c for c in df.columns if any(c.startswith(v) for v in VARS) or c in ("pm1_pm10", "pm25_pm10")]
    return cols + (["hour_sin", "hour_cos"] if with_time else [])


# =========================================================================== models
class PlaceCNN:
    def __init__(self, epochs=40, seed=0, with_time=False):
        import torch
        self.torch, self.epochs, self.seed, self.with_time = torch, epochs, seed, with_time
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"

    def _prep(self, S, hours):
        x = (np.log1p(np.clip(S, 0, None)) - self.mu) / self.sd  # log scale: particles span 3 orders of magnitude
        x = np.nan_to_num(x, nan=0.0)
        if self.with_time:
            h = np.repeat(hours[:, None, None], S.shape[2], axis=2)
            x = np.concatenate([x, np.sin(2 * np.pi * h / 24), np.cos(2 * np.pi * h / 24)], axis=1)
        return x.astype(np.float32)

    def fit(self, S, hours, y):
        torch, nn = self.torch, self.torch.nn
        torch.manual_seed(self.seed)
        rng = np.random.default_rng(self.seed)
        L = np.log1p(np.clip(S, 0, None))
        self.mu = np.nanmean(L, axis=(0, 2), keepdims=True)
        self.sd = np.nanstd(L, axis=(0, 2), keepdims=True) + 1e-6
        X = torch.tensor(self._prep(S, hours), device=self.dev)
        yi = np.array([PLACES.index(v) for v in y])
        w = len(yi) / (len(PLACES) * np.bincount(yi, minlength=len(PLACES)).clip(1))
        yt = torch.tensor(yi, device=self.dev)
        cin = X.shape[1]
        self.net = nn.Sequential(nn.Conv1d(cin, 32, 5, padding=2), nn.BatchNorm1d(32), nn.ReLU(),
                                 nn.Conv1d(32, 32, 5, padding=4, dilation=2), nn.BatchNorm1d(32), nn.ReLU(),
                                 nn.Conv1d(32, 32, 5, padding=8, dilation=4), nn.BatchNorm1d(32), nn.ReLU(),
                                 nn.AdaptiveAvgPool1d(1), nn.Flatten(), nn.Dropout(0.3),
                                 nn.Linear(32, len(PLACES))).to(self.dev)
        opt = torch.optim.AdamW(self.net.parameters(), lr=2e-3, weight_decay=1e-3)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, self.epochs)
        lossf = nn.CrossEntropyLoss(weight=torch.tensor(w, dtype=torch.float32, device=self.dev))
        for _ in range(self.epochs):
            self.net.train()
            for idx in np.array_split(rng.permutation(len(yi)), max(1, len(yi) // 128)):
                loss = lossf(self.net(X[idx]), yt[idx])
                opt.zero_grad()
                loss.backward()
                opt.step()
            sched.step()
        return self

    def predict_proba(self, S, hours):
        torch = self.torch
        self.net.eval()
        with torch.no_grad():
            X = torch.tensor(self._prep(S, hours), device=self.dev)
            return torch.softmax(self.net(X), 1).cpu().numpy()

    def n_params(self):
        return int(sum(p.numel() for p in self.net.parameters()))


def make_model(kind):
    if kind == "gbm":
        return HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, class_weight="balanced",
                                              min_samples_leaf=20, random_state=0)
    return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                         LogisticRegression(max_iter=3000, class_weight="balanced", C=0.5))


def lodo(df, S, kind, with_time):
    lab = df.label.isin(PLACES).to_numpy()
    cols = feature_cols(df, with_time)
    proba = np.full((len(df), len(PLACES)), np.nan)
    hours = (df.minute.dt.hour + df.minute.dt.minute / 60).to_numpy()
    params = None
    for n in sorted(df.day.unique()):
        tr, te = lab & (df.day != n).to_numpy(), (df.day == n).to_numpy()
        if kind == "cnn":
            m = PlaceCNN(with_time=with_time).fit(S[tr], hours[tr], df.label[tr].to_numpy())
            p, order = m.predict_proba(S[te], hours[te]), list(range(len(PLACES)))
            params = m.n_params()
        else:
            m = make_model(kind).fit(df.loc[tr, cols], df.label[tr])
            p = m.predict_proba(df.loc[te, cols])
            classes = list(m.classes_)
            p = np.column_stack([p[:, classes.index(c)] if c in classes else np.zeros(len(p)) for c in PLACES])
        proba[te] = p
    return proba, params


def smooth(df, proba, stay=0.98):
    pred = np.full(len(df), None, object)
    for (n, s), g in df.groupby(["day", "session"]):
        idx = g.sort_values("minute").index.to_numpy()
        br = np.r_[0, np.where(np.diff(df.minute[idx]).astype("timedelta64[s]").astype(int) > 120)[0] + 1, len(idx)]
        for a, b in zip(br[:-1], br[1:]):
            pred[idx[a:b]] = [PLACES[i] for i in sticky_viterbi(proba[idx[a:b]], stay)]
    return pred


def report(df, pred):
    lab = df.label.isin(PLACES).to_numpy()
    y, p = df.label[lab].to_numpy(), pred[lab]
    P, R, F, N = precision_recall_fscore_support(y, p, labels=PLACES, zero_division=0)
    return {"macro_f1": round(float(f1_score(y, p, labels=PLACES, average="macro")), 3),
            "per_class": {c: {"precision": round(float(P[i]), 3), "recall": round(float(R[i]), 3),
                              "f1": round(float(F[i]), 3), "n": int(N[i])} for i, c in enumerate(PLACES)},
            "confusion": confusion_matrix(y, p, labels=PLACES).tolist()}


def importance(df, with_time=False, reps=5):
    """Permutation importance per variable group, on each held-out day (drop in macro-F1)."""
    rng = np.random.default_rng(0)
    cols = feature_cols(df, with_time)
    lab = df.label.isin(PLACES).to_numpy()
    groups = {v: [c for c in cols if c.startswith(v + "_")] for v in VARS}
    groups["PM ratios"] = ["pm1_pm10", "pm25_pm10"]
    drops = {g: [] for g in groups}
    for n in sorted(df[lab].day.unique()):
        tr, te = lab & (df.day != n).to_numpy(), lab & (df.day == n).to_numpy()
        m = make_model("gbm").fit(df.loc[tr, cols], df.label[tr])
        Xte = df.loc[te, cols].copy()
        base = f1_score(df.label[te], m.predict(Xte), labels=PLACES, average="macro")
        for g, gc in groups.items():
            d = []
            for _ in range(reps):
                Xp = Xte.copy()
                perm = rng.permutation(len(Xp))
                Xp[gc] = Xp[gc].to_numpy()[perm]
                d.append(base - f1_score(df.label[te], m.predict(Xp), labels=PLACES, average="macro"))
            drops[g].append(np.mean(d) * te.sum())
    tot = lab.sum()
    return {g: round(float(np.sum(v) / tot), 3) for g, v in drops.items()}


# =========================================================================== figures
def plot(res, df, figdir):
    from ml_activity import confusion_panel
    import ml_activity
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.1), layout="constrained")
    for a, key, title in ((ax[0], "logreg_notime_smoothed", "(a) Air only"), (ax[1], "logreg_time_smoothed", "(b) Air + time")):
        cm = np.array(res[key]["confusion"], float)
        rec = cm / cm.sum(1, keepdims=True).clip(1)
        a.imshow(rec, cmap="Blues", vmin=0, vmax=1)
        for i in range(len(PLACES)):
            for j in range(len(PLACES)):
                a.text(j, i, f"{rec[i, j]:.2f}", ha="center", va="center", fontsize=9,
                       color="white" if rec[i, j] > 0.6 else C["ink"])
        a.set_xticks(range(len(PLACES)), [p[:4].capitalize() for p in PLACES], fontsize=9.5)
        a.set_yticks(range(len(PLACES)), [p.capitalize() for p in PLACES], fontsize=9.5)
        a.set(xlabel="Predicted", title=f"{title}, F1 {res[key]['macro_f1']:.2f}")
        a.grid(False)
    ax[0].set_ylabel("True")
    save_fig(fig, figdir, "B1_confusion")
    # B2: model comparison + importance
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.0), layout="constrained", gridspec_kw={"width_ratios": [1.1, 1]})
    models = [("Logistic", "logreg"), ("Gradient\nboosting", "gbm"), ("CNN", "cnn")]
    x = np.arange(len(models))
    for k, (suffix, c, lab) in enumerate((("notime", C["blue"], "Air only"), ("time", C["orange"], "Air + time"))):
        ax[0].bar(x + (k - 0.5) * 0.36, [res[f"{m}_{suffix}_smoothed"]["macro_f1"] for _, m in models], 0.34,
                  color=c, hatch="" if k == 0 else "///", edgecolor="white", label=lab)
    ax[0].set_xticks(x, [m for m, _ in models])
    ax[0].set(ylabel="Macro-F1 (smoothed)", ylim=(0, 1), title="(a) Models")
    ax[0].legend(loc="upper right", fontsize=9)
    ax[0].grid(axis="x", visible=False)
    imp = pd.Series(res["importance_notime"]).sort_values()
    names = {"co2_ppm": "CO$_2$", "pm1": "PM$_1$", "pm25": "PM$_{2.5}$", "pm10": "PM$_{10}$", "temp_c": "Temperature",
             "rh_pct": "Humidity", "dba": "Sound", "PM ratios": "PM ratios"}
    ax[1].barh(range(len(imp)), imp.values, color=C["ink2"])
    ax[1].set_yticks(range(len(imp)), [names[i] for i in imp.index])
    ax[1].set(xlabel="F1 drop when shuffled", title="(b) What the model uses")
    ax[1].grid(axis="y", visible=False)
    save_fig(fig, figdir, "B2_models_importance")


def run(subject_dir, rebuild=False):
    D = Days(subject_dir, clean=False)
    out = Path(subject_dir).resolve() / "ml" / "B_place"
    out.mkdir(parents=True, exist_ok=True)
    if (out / "minutes.pkl").exists() and not rebuild:
        df, S = pd.read_pickle(out / "minutes.pkl"), np.load(out / "sequences.npy")
    else:
        df, S = build(D)
        df.to_pickle(out / "minutes.pkl")
        np.save(out / "sequences.npy", S)
    res = {"minutes": int(len(df)), "labels": {str(k): int(v) for k, v in df.label.value_counts(dropna=False).items()},
           "labels_by_day": df[df.label.notna()].groupby(["day", "label"]).size().unstack(fill_value=0).to_dict()}
    print(res["labels"])
    oof = {}
    for kind in ("logreg", "gbm", "cnn"):
        for wt in (False, True):
            proba, params = lodo(df, S, kind, wt)
            for sm in (False, True):
                pred = smooth(df, proba) if sm else np.array([PLACES[i] for i in np.argmax(proba, 1)], object)
                r = report(df, pred)
                key = f"{kind}_{'time' if wt else 'notime'}{'_smoothed' if sm else ''}"
                res[key] = r
                print(f"{key:26s} macro-F1 {r['macro_f1']:.3f}  " + "  ".join(
                    f"{c}: P {v['precision']:.2f} R {v['recall']:.2f}" for c, v in r["per_class"].items()), flush=True)
            oof[f"{kind}_{'time' if wt else 'notime'}"] = proba
            if kind == "cnn":
                res["cnn_params"] = params
    res["importance_notime"] = importance(df, False)
    print("importance", res["importance_notime"])
    out_df = df[["minute", "day", "session", "context", "label"]].copy()
    for k, p in oof.items():
        for i, c in enumerate(PLACES):
            out_df[f"{k}_p_{c}"] = p[:, i]
    out_df.to_pickle(out / "oof_predictions.pkl")
    (out / "results.json").write_text(json.dumps(res, indent=1, default=str))
    plot(res, df, Path(subject_dir).resolve() / "ml" / "figures")
    return res


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "..", "--rebuild" in sys.argv)
