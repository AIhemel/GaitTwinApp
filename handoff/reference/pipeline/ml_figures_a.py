"""Thesis figures for ML task A (gait) and the phone-deployment check of all models.

Usage:  python ml_figures_a.py <subject_dir>
Writes ml/figures/A1_toeoff.pdf, A2_heelstrike.pdf and ml/deploy.json.
"""
import json
import pickle
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

import daily_analysis as da
from daily_analysis import C, fig_size
from ml_activity import save_fig
from ml_heelstrike import HeelStrikeTCN, detect_tcn, detect_peaks, CHANNELS, FS

warnings.filterwarnings("ignore")


def fig_toeoff(root, figdir):
    res = json.loads((root / "A_gait" / "results.json").read_text())
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.9), layout="constrained", gridspec_kw={"width_ratios": [1.6, 1]})
    y0, ticks, labels = 0, [], []
    for s, c, mk in (("R", C["blue"], "o"), ("L", C["orange"], "^")):
        p = res[f"E2_pooled_{s}"]
        for j, k in enumerate(p["rule"]["group_offsets_ms"]):
            y = y0 + j
            ax[0].plot(p["rule"]["group_offsets_ms"][k], y, mk, color=c, ms=6)
            ax[0].plot(p["gbm"]["group_offsets_ms"][k], y, mk, mfc="white", mec=c, ms=6, mew=1.3)
            ax[0].plot(p["cnn"]["group_offsets_ms"][k], y, "x", color=C["ink"], ms=5, mew=1.2)
            ticks.append(y)
            labels.append(f"D{k[0]}-{k[1:-1]} {'right' if k[-1] == 'R' else 'left'}")
        y0 += len(p["rule"]["group_offsets_ms"]) + 1
    ax[0].axvline(0, color=C["ink"], lw=0.8)
    ax[0].set_yticks(ticks, labels, fontsize=8.5)
    ax[0].invert_yaxis()
    ax[0].set(xlabel="Mean toe-off error per session (ms)", title="(a) Session offsets")
    ax[0].grid(axis="y", visible=False)
    methods = ("rule", "gbm", "cnn")
    x = np.arange(3)
    for k, (s, c) in enumerate((("R", C["blue"]), ("L", C["orange"]))):
        p = res[f"E2_pooled_{s}"]
        ax[1].bar(x + (k - 0.5) * 0.36, [p[m]["within_group_sd_ms"] for m in methods], 0.34, color=c,
                  hatch="" if s == "R" else "///", edgecolor="white", label="Right foot" if s == "R" else "Left foot")
    ax[1].set_xticks(x, ["Rule", "Boosting", "CNN"])
    ax[1].set(ylabel="Scatter within a session (ms)", title="(b) Stride to stride", ylim=(0, 75))
    ax[1].legend(loc="upper left", fontsize=9)
    ax[1].grid(axis="x", visible=False)
    h = [plt.Line2D([], [], marker="o", ls="", color=C["ink2"], label="Rule"),
         plt.Line2D([], [], marker="o", ls="", mfc="white", mec=C["ink2"], label="Gradient boosting"),
         plt.Line2D([], [], marker="x", ls="", color=C["ink"], label="CNN")]
    fig.legend(handles=h, loc="outside upper center", ncol=3, fontsize=9.5)
    save_fig(fig, figdir, "A1_toeoff")


def fig_heelstrike(root, figdir):
    res = json.loads((root / "A_gait" / "heelstrike_results.json").read_text())
    data = pickle.loads((root / "A_gait" / "stream_segments.pkl").read_bytes())
    test_day = 5
    m = HeelStrikeTCN().fit([s for s in data if s["day"] != test_day])
    seg = max((s for s in data if s["day"] == test_day and s["kind"] == "walk" and s["side"] == "R"),
              key=lambda s: len(s["impacts"]))
    p = m.prob(seg)
    det_t, det_p = detect_tcn(m, seg), detect_peaks(seg, 14)
    # an 8-s stretch in the middle of the walk that contains a soft step
    acc = seg["X"][CHANNELS.index("acc")]
    imp = seg["impacts"]
    k = np.searchsorted(seg["t"], imp)
    soft = np.where(acc[k] < 25)[0]
    centre = imp[len(imp) // 2]  # a typical stretch in the middle of the walk
    sel = (seg["t"] >= centre - 4000) & (seg["t"] <= centre + 4000)
    tt = (seg["t"][sel] - centre) / 1000
    fig = plt.figure(figsize=fig_size(4.2), layout="constrained")
    gs = fig.add_gridspec(2, 2, height_ratios=[1.15, 1])
    a0 = fig.add_subplot(gs[0, :])
    a0.plot(tt, acc[sel], color=C["ink2"], lw=0.9, label="Acceleration (m/s²)")
    a1 = a0.twinx()
    a1.plot(tt, p[sel], color=C["blue"], lw=1.5, label="TCN heel-strike probability")
    a1.set_ylim(0, 1.6)
    a1.set_ylabel("Probability", color=C["blue"])
    a1.grid(False)
    for x in imp[(imp >= centre - 4000) & (imp <= centre + 4000)]:
        a0.axvline((x - centre) / 1000, color=C["green"], lw=1, ls=":")
    for x in det_t[(det_t >= centre - 4000) & (det_t <= centre + 4000)]:
        a1.plot((x - centre) / 1000, 1.05, "v", color=C["blue"], ms=6)
    for x in det_p[(det_p >= centre - 4000) & (det_p <= centre + 4000)]:
        a1.plot((x - centre) / 1000, 1.25, "v", color=C["orange"], ms=6)
    a0.set(xlabel="Time (s)", ylabel="Acceleration (m/s²)", title="(a) Right foot, unseen day 5")
    h = [plt.Line2D([], [], color=C["ink2"], label="Acceleration"), plt.Line2D([], [], color=C["blue"], label="TCN probability"),
         plt.Line2D([], [], color=C["green"], ls=":", label="Labelled impact"),
         plt.Line2D([], [], marker="v", ls="", color=C["blue"], label="TCN detection"),
         plt.Line2D([], [], marker="v", ls="", color=C["orange"], label="Peak detector")]
    a0.legend(handles=h, loc="upper left", fontsize=8, ncol=3)
    a0.set_ylim(0, acc[sel].max() * 1.45)
    b = fig.add_subplot(gs[1, 0])
    pb = res["lodo_pooled_bilateral"]
    mets = ("precision", "recall", "f1")
    x = np.arange(3)
    b.bar(x - 0.18, [pb["tcn"][k] for k in mets], 0.34, color=C["blue"], label="TCN")
    b.bar(x + 0.18, [pb["peak"][k] for k in mets], 0.34, color=C["orange"], hatch="///", edgecolor="white", label="Peak detector")
    b.set_xticks(x, ["Precision", "Recall", "F1"])
    b.set(ylim=(0.8, 1.04), title="(b) Unseen days, pooled")
    b.legend(loc="upper center", fontsize=8.5, ncol=2)
    b.grid(axis="x", visible=False)
    c = fig.add_subplot(gs[1, 1])
    pv = res["lodo_pooled"]
    c.bar(x[:2] - 0.18, [pv["tcn"]["vehicle_false_per_min"], pv["peak"]["vehicle_false_per_min"]], 0.34,
          color=C["band"], edgecolor=C["ink2"], label="One foot")
    c.bar(x[:2] + 0.18, [pb["tcn"]["vehicle_false_per_min"], pb["peak"]["vehicle_false_per_min"]], 0.34,
          color=C["red"], label="Two-foot check")
    c.set_xticks(x[:2], ["TCN", "Peak det."])
    c.set(ylabel="False steps per min", title="(c) In vehicles")
    c.legend(loc="upper right", fontsize=8.5)
    c.grid(axis="x", visible=False)
    save_fig(fig, figdir, "A2_heelstrike")
    return m


def deploy(root, tcn):
    """Size and CPU speed of each model, as a stand-in for a phone (batch of one, single thread)."""
    import torch
    from ml_gait import StrideCNN
    from ml_activity import ActivityCNN
    from ml_place import PlaceCNN
    torch.set_num_threads(1)
    out = {}

    def bench(net, x, reps=200):
        net = net.cpu().eval()
        with torch.no_grad():
            for _ in range(10):
                net(*x) if isinstance(x, tuple) else net(x)
            t0 = time.perf_counter()
            for _ in range(reps):
                net(*x) if isinstance(x, tuple) else net(x)
        return round(1000 * (time.perf_counter() - t0) / reps, 3)

    n_tcn = sum(p.numel() for p in tcn.net.parameters())
    out["heel-strike TCN"] = {"params": n_tcn, "kB_float32": round(4 * n_tcn / 1024, 1), "kB_int8": round(n_tcn / 1024, 1),
                              "input": "4 x 1000 (10 s at 100 Hz)",
                              "ms_per_call": bench(tcn.net, torch.zeros(1, 4, 1000))}
    sc = StrideCNN()
    net = sc._net()
    n = sum(p.numel() for p in net.parameters())
    out["toe-off CNN"] = {"params": n, "kB_float32": round(4 * n / 1024, 1), "kB_int8": round(n / 1024, 1),
                          "input": "4 x 100 (one stride)", "ms_per_call": bench(net, (torch.zeros(1, 4, 100), torch.zeros(1, 1)))}
    ac = ActivityCNN()
    net = ac._net()
    n = sum(p.numel() for p in net.parameters())
    out["activity CNN"] = {"params": n, "kB_float32": round(4 * n / 1024, 1), "kB_int8": round(n / 1024, 1),
                           "input": "10 x 500 (10 s at 50 Hz)", "ms_per_call": bench(net, torch.zeros(1, 10, 500))}
    # tree and linear models: size of the fitted model on all labelled data
    import pickle as pk
    from sklearn.ensemble import HistGradientBoostingClassifier
    dfc = pd.read_pickle(root / "C_activity" / "windows.pkl")
    from ml_activity import feature_cols, CLASSES
    cols = feature_cols(dfc, "both")
    lab = dfc.label.isin(CLASSES)
    g = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, class_weight="balanced",
                                       min_samples_leaf=20, random_state=0).fit(dfc.loc[lab, cols], dfc.label[lab])
    xrow = dfc.loc[lab, cols].iloc[:1]
    t0 = time.perf_counter()
    for _ in range(50):
        g.predict_proba(xrow)
    out["activity gradient boosting"] = {"kB": round(len(pk.dumps(g)) / 1024, 1), "features": len(cols),
                                         "ms_per_call": round(1000 * (time.perf_counter() - t0) / 50, 3)}
    from ml_place import make_model, feature_cols as pcols, PLACES
    dfp = pd.read_pickle(root / "B_place" / "minutes.pkl")
    lab = dfp.label.isin(PLACES)
    cols = pcols(dfp, False)
    lr = make_model("logreg").fit(dfp.loc[lab, cols], dfp.label[lab])
    xrow = dfp.loc[lab, cols].iloc[:1]
    t0 = time.perf_counter()
    for _ in range(50):
        lr.predict_proba(xrow)
    out["place logistic regression"] = {"kB": round(len(pk.dumps(lr)) / 1024, 1), "features": len(cols),
                                        "ms_per_call": round(1000 * (time.perf_counter() - t0) / 50, 3)}
    (root / "deploy.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


def run(subject_dir):
    root = Path(subject_dir).resolve() / "ml"
    figdir = root / "figures"
    fig_toeoff(root, figdir)
    tcn = fig_heelstrike(root, figdir)
    deploy(root, tcn)


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "..")
