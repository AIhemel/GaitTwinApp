"""ML task A: toe-off (end of stance) from the foot IMU alone.

Usage:  python ml_gait.py <subject_dir> [--rebuild]

Each stride runs from one heel-strike impact to the next (IMU events). Inputs are the stride's IMU curves resampled
to 100 points: foot tilt from flat, tilt rate, rotation speed and acceleration magnitude. The target is the
pressure-sensor toe-off as % of the stride, available only where that foot's pressure sensors were healthy.

Evaluations (all test sets are whole days or the other foot, never strides from the training days):
  E1  right-foot labels only, leave-one-day-out (days 1-3)
  E2  both feet, leave-one-day-out (all days)
  E3  cross-foot: train on one foot, test on the other (stand-in for a new wearer / insole placement)
Baseline: the hand-made rule (toe-off when the push-off rotation rate has fallen to half its peak).

Writes <subject_dir>/ml/A_gait/: strides.npz (cache), results.json, figures.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from sklearn.ensemble import HistGradientBoostingRegressor

import daily_analysis as da
from daily_analysis import C, fig_size
from compare_days import Days

N_PTS = 100
CHANNELS = ["tilt", "tilt_rate", "rot_speed", "acc"]


# =========================================================================== IMU-only signals
def imu_signals(d, fs):
    """Foot tilt relative to the foot's flat orientation, found from the IMU alone, plus rates and acceleration.

    Flat = median gravity direction over 'quiet' samples (acceleration within 0.4 m/s^2 of its resting value and
    rotation below 20 deg/s). The pipeline's tilt used the pressure sensors to find the flat position; a phone
    model must not depend on them.
    """
    x, y, z, w = (d[c].to_numpy(float) for c in ("Quat_I", "Quat_J", "Quat_K", "Quat_Real"))
    gs = np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], axis=1)
    gs /= np.linalg.norm(gs, axis=1, keepdims=True)
    acc = np.sqrt(d.Accel_X**2 + d.Accel_Y**2 + d.Accel_Z**2).to_numpy(float)
    dot = np.clip((gs[1:] * gs[:-1]).sum(axis=1), -1, 1)
    rot = np.concatenate([[0], np.degrees(np.arccos(dot))]) * fs  # deg/s, change of the gravity direction
    rot = da.lowpass(rot, fs)
    g0 = np.median(acc)
    # stillest moments: in walking-only recordings these are mid-stance, when the foot is flat on the ground
    score = rot / 20 + np.abs(acc - g0) / 0.4
    quiet = score <= max(2.0, np.percentile(score, 5))
    ref = np.median(gs[quiet], axis=0)
    ref /= np.linalg.norm(ref)
    tilt = da.lowpass(np.degrees(np.arccos(np.clip(gs @ ref, -1, 1))), fs)
    rate = np.gradient(tilt, d.t.to_numpy(float) / 1000)
    return {"tilt": tilt, "tilt_rate": rate, "rot_speed": rot, "acc": acc}, int(quiet.sum())


def rule_toe_off(t, tilt, rate, a, b):
    """Hand-made rule on raw samples: after the peak push-off rotation rate, the instant it falls to 50 %."""
    T = t[b] - t[a]
    m = np.where((t >= t[a] + 0.3 * T) & (t < t[a] + 0.9 * T))[0]
    if len(m) < 10:
        return np.nan
    pk = m[:np.argmax(tilt[m]) + 1]
    if len(pk) < 4:
        return np.nan
    i = pk[np.argmax(rate[pk])]
    top = rate[pk].max()
    while i < b and rate[i] > 0.5 * top:
        i += 1
    return t[i] if i < b else np.nan


# =========================================================================== dataset
def build(D):
    X, meta = [], []
    for n in D.n:
        day = da.Day(D.dirs[D.n.index(n)]) if False else None  # Day() would wipe the output folder; not needed
        for sess_cfg in D.summary[n]["sessions"]:
            key = sess_cfg["key"]
            for side in ("R", "L"):
                f = D.dirs[D.n.index(n)] / "analysis_output" / f"strides_{key}_{side}.csv"
                if not f.exists():
                    continue
                s_all = pd.read_csv(f)
                if len(s_all) < 50 or "to_fsr_ms" not in s_all:
                    continue
                keep = set(da.steady(s_all).index)
                sess = session_obj(D, n, key)
                d = da_gait(sess, side)
                if d is None:
                    continue
                fs = len(d) / max(1e-9, (d.t.iloc[-1] - d.t.iloc[0]) / 1000)
                sig, n_quiet = imu_signals(d, fs)
                t = d.t.to_numpy(float)
                ok_label = D.pressure_valid(n, key, side)
                imp = s_all.hs_imu_ms.to_numpy(float)
                for i in range(len(s_all) - 1):
                    if i not in keep or np.isnan(imp[i]) or np.isnan(imp[i + 1]):
                        continue
                    if s_all.bout.iloc[i] != s_all.bout.iloc[i + 1]:
                        continue
                    T = imp[i + 1] - imp[i]
                    if not 700 <= T <= 2000 or abs(T - 1000 * s_all.stride_s.iloc[i]) > 150:
                        continue
                    a, b = np.searchsorted(t, imp[i]), np.searchsorted(t, imp[i + 1])
                    if b - a < 60 or (np.diff(t[a:b]) > 50).any():  # needs dense samples, no gap
                        continue
                    grid = np.linspace(imp[i], imp[i + 1], N_PTS, endpoint=False)
                    X.append(np.stack([np.interp(grid, t[a:b + 1], sig[c][a:b + 1]) for c in CHANNELS]))
                    rule = rule_toe_off(t, sig["tilt"], sig["tilt_rate"], a, b)
                    meta.append({"day": n, "session": key, "side": side, "label_ok": ok_label, "T_ms": T,
                                 "impact_ms": imp[i],
                                 "y": 100 * (s_all.to_fsr_ms.iloc[i] - imp[i]) / T,
                                 "rule": 100 * (rule - imp[i]) / T,
                                 "rule_pipeline": 100 * (s_all.to_imu_ms.iloc[i] - imp[i]) / T})
                print(f"day {n} {key} {side}: {sum(1 for m in meta if m['day'] == n and m['session'] == key and m['side'] == side)} strides"
                      f" (labels {'yes' if ok_label else 'no'}, quiet samples {n_quiet})", flush=True)
    return np.array(X, dtype=np.float32), pd.DataFrame(meta)


def session_obj(D, n, key):
    """Session object without constructing da.Day (which would clear that day's output folders)."""
    base = D.dirs[D.n.index(n)]
    cfg = D.cfg[n]
    s = next(x for x in cfg["sessions"] if x["key"] == key)
    sm = next(x for x in D.summary[n]["sessions"] if x["key"] == key)
    start, end = (pd.Timestamp(sm[k]).tz_localize(da.TZ) for k in ("start", "end"))
    return da.Session(key, s["label"], s["context"], base / s["folder"], start, end,
                      tuple(s["streams"]) if s.get("streams") else None,
                      bool(s.get("start_local") or s.get("end_local")))


def da_gait(sess, side):
    return da.gait_timed(sess, side) if sess.has("gait") else None


# =========================================================================== features for the tree model
def features(X, meta):
    """Hand-made features: curves sampled every 5 % plus timing landmarks of the push-off."""
    tilt, rate, rot, acc = X[:, 0], X[:, 1], X[:, 2], X[:, 3]
    F = [X[:, c, ::5] for c in range(X.shape[1])]
    sl = slice(30, 90)
    pk = 30 + np.argmax(tilt[:, sl], axis=1)                       # peak plantarflexion (%)
    rmax = np.array([30 + np.argmax(rate[i, 30:max(pk[i], 31) + 1]) for i in range(len(X))])
    top = rate[np.arange(len(X)), rmax]
    land = [pk, rmax]
    for frac in (0.75, 0.5, 0.25):                                 # rate falls to this share of its peak
        land.append(np.array([next((j for j in range(rmax[i], 100) if rate[i, j] < frac * top[i]), 99)
                              for i in range(len(X))]))
    land.append(np.argmin(tilt[:, 10:50], axis=1) + 10)            # flattest point in early stance
    land.append(40 + np.argmax(acc[:, 40:90], axis=1))             # largest acceleration around push-off
    F.append(np.stack(land, axis=1))
    F.append(np.stack([tilt.max(1), top, rot.max(1), acc.max(1), meta.T_ms.to_numpy() / 1000], axis=1))
    return np.concatenate(F, axis=1)


class StrideCNN:
    """Small 1D CNN on the stride curves (4 x 100) plus stride duration -> toe-off (% of stride).

    Three convolution layers find local shapes (the push-off rotation, the tilt peak); the flattened feature map keeps
    *where* they occur, which is what the target is. About 30 k parameters, small enough for a phone.
    """

    def __init__(self, epochs=40, seed=0):
        import torch
        self.torch, self.epochs, self.seed = torch, epochs, seed
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"

    def _net(self):
        nn = self.torch.nn

        class Net(nn.Module):
            def __init__(self):
                super().__init__()
                self.conv = nn.Sequential(
                    nn.Conv1d(4, 16, 7, padding=3), nn.BatchNorm1d(16), nn.ReLU(),
                    nn.Conv1d(16, 32, 5, stride=2, padding=2), nn.BatchNorm1d(32), nn.ReLU(),
                    nn.Conv1d(32, 32, 5, stride=2, padding=2), nn.BatchNorm1d(32), nn.ReLU())
                self.head = nn.Sequential(nn.Linear(32 * 25 + 1, 32), nn.ReLU(), nn.Dropout(0.2), nn.Linear(32, 1))

            def forward(self, x, T):
                return self.head(self.torch_cat(self.conv(x).flatten(1), T)).squeeze(1)

        net = Net()
        net.torch_cat = lambda a, b: self.torch.cat([a, b], dim=1)
        return net

    def fit(self, X, T, y):
        torch = self.torch
        torch.manual_seed(self.seed)
        self.mu, self.sd = X.mean(axis=(0, 2), keepdims=True), X.std(axis=(0, 2), keepdims=True) + 1e-6
        self.ym, self.ys = y.mean(), y.std()
        Xt = torch.tensor((X - self.mu) / self.sd, dtype=torch.float32, device=self.dev)
        Tt = torch.tensor(T[:, None] / 1000, dtype=torch.float32, device=self.dev)
        yt = torch.tensor((y - self.ym) / self.ys, dtype=torch.float32, device=self.dev)
        self.net = self._net().to(self.dev)
        opt = torch.optim.AdamW(self.net.parameters(), lr=2e-3, weight_decay=1e-3)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, self.epochs)
        g = torch.Generator(device="cpu").manual_seed(self.seed)
        for _ in range(self.epochs):
            self.net.train()
            for idx in torch.randperm(len(yt), generator=g).split(256):
                idx = idx.to(self.dev)
                scale = 1 + 0.1 * torch.randn(len(idx), Xt.shape[1], 1, device=self.dev)  # amplitude jitter
                loss = torch.nn.functional.huber_loss(self.net(Xt[idx] * scale, Tt[idx]), yt[idx], delta=1.0)
                opt.zero_grad()
                loss.backward()
                opt.step()
            sched.step()
        return self

    def predict(self, X, T):
        torch = self.torch
        self.net.eval()
        with torch.no_grad():
            Xt = torch.tensor((X - self.mu) / self.sd, dtype=torch.float32, device=self.dev)
            Tt = torch.tensor(T[:, None] / 1000, dtype=torch.float32, device=self.dev)
            return self.net(Xt, Tt).cpu().numpy() * self.ys + self.ym

    def n_params(self):
        return int(sum(p.numel() for p in self.net.parameters()))


def gbm():
    return HistGradientBoostingRegressor(max_iter=400, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=40,
                                         l2_regularization=1.0, random_state=0)


# =========================================================================== evaluation
def err_stats(pred, y, T, groups=None):
    """Error in ms. With groups (e.g. day-session-side), also split it into the offset of each group (accuracy) and
    the stride-to-stride scatter around that offset (precision)."""
    e = (np.asarray(pred, float) - np.asarray(y, float)) / 100 * np.asarray(T, float)  # ms
    ok = ~np.isnan(e)
    out = {"n": int(ok.sum()), "bias_ms": round(float(e[ok].mean()), 1), "sd_ms": round(float(e[ok].std()), 1),
           "mae_ms": round(float(np.abs(e[ok]).mean()), 1), "median_abs_ms": round(float(np.median(np.abs(e[ok]))), 1),
           "p95_abs_ms": round(float(np.percentile(np.abs(e[ok]), 95)), 1)}
    if groups is not None:
        g = pd.Series(e[ok]).groupby(np.asarray(groups)[ok])
        out["group_offsets_ms"] = {k: round(float(v), 1) for k, v in g.mean().items()}
        out["within_group_sd_ms"] = round(float((pd.Series(e[ok]) - g.transform("mean").values).std()), 1)
    return out


def evaluate(F, meta, train_mask, test_mask, name, X=None):
    m = gbm().fit(F[train_mask], meta.y[train_mask])
    p = m.predict(F[test_mask])
    te = meta[test_mask]
    grp = (te.day.astype(str) + te.session + te.side).to_numpy()
    r = {"name": name, "n_train": int(train_mask.sum()),
         "gbm": err_stats(p, te.y.to_numpy(), te.T_ms.to_numpy(), grp),
         "rule": err_stats(te.rule.to_numpy(), te.y.to_numpy(), te.T_ms.to_numpy(), grp)}
    pc = None
    if X is not None:
        cnn = StrideCNN().fit(X[train_mask], meta.T_ms[train_mask].to_numpy(), meta.y[train_mask].to_numpy())
        pc = cnn.predict(X[test_mask], te.T_ms.to_numpy())
        r["cnn"] = err_stats(pc, te.y.to_numpy(), te.T_ms.to_numpy(), grp)
        r["cnn_params"] = cnn.n_params()
    return r, (p, pc)


def plot_offsets(res, out):
    """Where the error comes from: per-session offsets (accuracy) vs within-session scatter (precision)."""
    (out / "figures").mkdir(exist_ok=True)
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.3), layout="constrained", gridspec_kw={"width_ratios": [1.7, 1]})
    y0 = 0
    ticks, labels = [], []
    for s, c, mk in (("R", C["blue"], "o"), ("L", C["orange"], "^")):
        p = res[f"E2_pooled_{s}"]
        keys = list(p["rule"]["group_offsets_ms"])
        for j, k in enumerate(keys):
            y = y0 + j
            ax[0].plot(p["rule"]["group_offsets_ms"][k], y, mk, color=c, ms=6)
            ax[0].plot(p["gbm"]["group_offsets_ms"][k], y, mk, mfc="white", mec=c, ms=6, mew=1.4)
            if "cnn" in p:
                ax[0].plot(p["cnn"]["group_offsets_ms"][k], y, "x", color=C["ink"], ms=6, mew=1.4)
            ticks.append(y)
            labels.append(f"D{k[0]}-{k[1:-1]} {k[-1]}")
        y0 += len(keys) + 1
    ax[0].axvline(0, color=C["ink"], lw=0.8)
    ax[0].set_yticks(ticks, labels, fontsize=8.5)
    ax[0].invert_yaxis()
    ax[0].set(xlabel="Mean error per session (ms)", title="(a) Session offsets")
    ax[0].grid(axis="y", visible=False)
    h = [plt.Line2D([], [], marker="o", ls="", color=C["ink2"], label="Rule"),
         plt.Line2D([], [], marker="o", ls="", mfc="white", mec=C["ink2"], label="Gradient boosting"),
         plt.Line2D([], [], marker="x", ls="", color=C["ink"], label="CNN")]
    ax[0].legend(handles=h, loc="lower left", fontsize=9, bbox_to_anchor=(0, -0.42), ncol=3, frameon=False)
    methods = [m for m in ("rule", "gbm", "cnn") if m in res["E2_pooled_R"]]
    x = np.arange(len(methods))
    for k, (s, c) in enumerate((("R", C["blue"]), ("L", C["orange"]))):
        p = res[f"E2_pooled_{s}"]
        ax[1].bar(x + (k - 0.5) * 0.36, [p[m]["within_group_sd_ms"] for m in methods], 0.34,
                  color=c, hatch="" if s == "R" else "///", edgecolor="white", label="Right" if s == "R" else "Left")
    ax[1].set_xticks(x, [{"rule": "Rule", "gbm": "Boost.", "cnn": "CNN"}[m] for m in methods])
    ax[1].set_ylim(0, 75)
    ax[1].set(ylabel="Scatter within session (ms)", title="(b) Stride-to-stride")
    ax[1].legend(loc="upper left", fontsize=9)
    ax[1].grid(axis="x", visible=False)
    fig.savefig(out / "figures" / "A_offsets.png", dpi=200)
    fig.savefig(out / "figures" / "A_offsets.pdf")
    plt.close(fig)


def run(subject_dir, rebuild=False):
    D = Days(subject_dir, clean=False)
    out = Path(subject_dir).resolve() / "ml" / "A_gait"
    out.mkdir(parents=True, exist_ok=True)
    cache = out / "strides.npz"
    if cache.exists() and not rebuild:
        z = np.load(cache, allow_pickle=True)
        X, meta = z["X"], pd.DataFrame(json.loads(str(z["meta"])))
    else:
        X, meta = build(D)
        np.savez_compressed(cache, X=X, meta=meta.to_json(orient="records"))
    ok = meta.label_ok.to_numpy() & meta.y.between(40, 85).to_numpy() & meta.rule.notna().to_numpy()
    F = features(X, meta)
    R, Lf = (meta.side == "R").to_numpy(), (meta.side == "L").to_numpy()
    res = {"strides_total": int(len(meta)), "strides_labelled": int(ok.sum()),
           "labelled_by_side": {s: int((ok & (meta.side == s)).sum()) for s in ("R", "L")},
           "labelled_days": sorted(int(v) for v in meta[ok].day.unique()), "E1": [], "E2": [], "E3": []}
    preds = {"gbm": np.full(len(meta), np.nan), "cnn": np.full(len(meta), np.nan)}
    for n in sorted(meta[ok & R].day.unique()):                       # E1
        te = ok & R & (meta.day == n).to_numpy()
        r, _ = evaluate(F, meta, ok & R & ~te, te, f"test day {n}", X)
        res["E1"].append(r)
    for n in sorted(meta[ok].day.unique()):                           # E2
        te = ok & (meta.day == n).to_numpy()
        r, (p, pc) = evaluate(F, meta, ok & ~te, te, f"test day {n}", X)
        preds["gbm"][te], preds["cnn"][te] = p, pc
        res["E2"].append(r)
    for tr, te, name in ((Lf, R, "train left, test right"), (R, Lf, "train right, test left")):   # E3
        r, _ = evaluate(F, meta, ok & tr, ok & te, name, X)
        res["E3"].append(r)
    # pooled E2 summary per foot
    grp = (meta.day.astype(str) + meta.session + meta.side).to_numpy()
    for s, sm in (("R", R), ("L", Lf)):
        sub = ok & sm
        y, T = meta.y[sub].to_numpy(), meta.T_ms[sub].to_numpy()
        res[f"E2_pooled_{s}"] = {"rule": err_stats(meta.rule[sub].to_numpy(), y, T, grp[sub]),
                                 "gbm": err_stats(preds["gbm"][sub], y, T, grp[sub]),
                                 "cnn": err_stats(preds["cnn"][sub], y, T, grp[sub])}
    meta.assign(gbm_E2=preds["gbm"], cnn_E2=preds["cnn"]).to_csv(out / "strides_meta.csv", index=False)
    plot_offsets(res, out)
    (out / "results.json").write_text(json.dumps(res, indent=1, default=str))
    print(json.dumps({k: v for k, v in res.items() if k in ("strides_total", "strides_labelled", "labelled_by_side")}))
    for s in ("R", "L"):
        for m in ("rule", "gbm", "cnn"):
            e = res[f"E2_pooled_{s}"][m]
            print(f"E2 pooled {s} {m:5s} MAE {e['mae_ms']:6.1f}  SD {e['sd_ms']:6.1f}  bias {e['bias_ms']:6.1f}  "
                  f"within-session SD {e['within_group_sd_ms']:6.1f}")
    for k in ("E1", "E2", "E3"):
        for r in res[k]:
            print(k, f"{r['name']:24s}", "n", r["gbm"]["n"],
                  " | ".join(f"{m} MAE {r[m]['mae_ms']:.1f} bias {r[m]['bias_ms']:.1f} wSD {r[m]['within_group_sd_ms']:.1f}"
                             for m in ("rule", "gbm", "cnn")))
    return res


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "..", "--rebuild" in sys.argv)
