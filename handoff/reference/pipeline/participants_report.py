"""Figures and numbers for the two-participant comparison report.

Usage:  python participants_report.py <data_root>     (data_root holds Hemel/, spriha/, participants/)
Writes <data_root>/participants/figures/C*.pdf|png, latex/fig_C*.tex and participants_report.json.
Run after compare_days.py, relationships.py and walk_hydration.py for both participants.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy.stats import rankdata, spearmanr

import compare_days as cd
from compare_participants import PEOPLE, save
from daily_analysis import C, fig_size
from relationships import subset

G = 9.81
# body size given by the participants (2026-10-21); leg length taken as 0.53 x height (hip height)
BODY = {"Hemel": {"height_m": 1.7145, "mass_kg": 77, "sex": "M", "folder": "Hemel", "last": 8},
        "Spriha": {"height_m": 1.4732, "mass_kg": 68, "sex": "F", "folder": "spriha", "last": None}}
# EFSA adequate intake of total water, of which about 80 % is expected from drinks
EFSA_DRINKS_L = {"M": 2.0, "F": 1.6}


def latest_comparison(root, folder):
    dirs = sorted((root / folder / "comparison").glob("upto_day*"), key=lambda p: int(p.name[8:]))
    return dirs[-1]


def per_day(root):
    rows = []
    for p, b in BODY.items():
        m = pd.read_csv(latest_comparison(root, b["folder"]) / "all_days_metrics.csv")
        rows.append(m.assign(person=p))
    return pd.concat(rows, ignore_index=True)


def fig_days(m, res):
    """Each dot is one day; bars are the per-person means."""
    panels = [("sleep_hr_mean", "HR asleep (bpm)"), ("hr_awake_mean", "HR awake (bpm)"),
              ("hydration_ml", "Water (L/day)"), ("walk_cadence", "Cadence (steps/min)"),
              ("overnight_pm25_median", "Bedroom PM$_{2.5}$"),
              ("overnight_dba_median", "Bedroom dBA")]
    fig, axes = plt.subplots(2, 3, figsize=fig_size(4.2), layout="constrained")
    rng = np.random.default_rng(1)
    for i, (ax, (col, lab)) in enumerate(zip(axes.ravel(), panels)):
        for k, (p, c) in enumerate(PEOPLE.items()):
            v = m[m.person == p][col].dropna().to_numpy(float)
            if col == "hydration_ml":
                v = v / 1000
            ax.scatter(k + rng.uniform(-0.12, 0.12, len(v)), v, s=22, color=c, alpha=0.85, zorder=3,
                       edgecolor="white", lw=0.5)
            if len(v):
                ax.hlines(v.mean(), k - 0.28, k + 0.28, color=C["ink"], lw=1.6, zorder=4)
            res.setdefault(col, {})[p] = {"mean": round(float(v.mean()), 2) if len(v) else None,
                                          "sd": round(float(v.std(ddof=1)), 2) if len(v) > 1 else None,
                                          "n_days": int(len(v))}
        if col == "hydration_ml":
            for k, p in enumerate(PEOPLE):
                ax.hlines(EFSA_DRINKS_L[BODY[p]["sex"]], k - 0.4, k + 0.4, color=C["aqua"], ls="--", lw=1.1)
        ax.set_xticks([0, 1], list(PEOPLE))
        ax.set_xlim(-0.6, 1.6)
        ax.set_title(f"({'abcdef'[i]}) {lab}", loc="left", fontsize=10)
        ax.grid(axis="x", visible=False)
    save(OUT, fig, "C1_days",
         r"Day-level measures of the two participants: each dot is one day, the black bar is the mean over days. "
         r"(a) Mean heart rate asleep, (b) mean heart rate awake, (c) fluid from the smart-bottle log (dashed: about "
         r"80\,\% of the EFSA adequate total water intake, i.e.\ 2.0\,L for men and 1.6\,L for women), (d) walking "
         r"cadence, (e) bedroom PM$_{2.5}$ and (f) bedroom sound level (medians of the overnight recording; PM$_{2.5}$ in $\mu$g/m$^3$).", FIGS)


def gait_frame(root):
    rows = []
    for p, b in BODY.items():
        base = root / b["folder"]
        D = cd.Days(base, b["last"], clean=False)
        for n in D.n:
            S = D.summary[n]
            ctx = {s["key"]: s["context"] for s in S["sessions"]}
            for f in (D.dirs[D.n.index(n)] / "analysis_output").glob("strides_*_*.csv"):
                key = f.stem.split("_")[1]
                if ctx.get(key) not in ("outdoor_walk", "walk"):
                    continue
                s = pd.read_csv(f)
                s = cd.da.steady(s) if len(s) >= 20 else s.iloc[0:0]
                if len(s) < 20:
                    continue
                rows.append(pd.DataFrame({"person": p, "stride_s": s.stride_s}))
    g = pd.concat(rows, ignore_index=True)
    g["leg_m"] = g.person.map({p: 0.53 * b["height_m"] for p, b in BODY.items()})
    g["stride_hat"] = g.stride_s / np.sqrt(g.leg_m / G)
    g["cadence"] = 120 / g.stride_s
    return g


def fig_gait(g, res):
    fig, ax = plt.subplots(1, 2, figsize=fig_size(2.8), layout="constrained")
    for j, (col, lab) in enumerate((("stride_s", "Stride time (s)"),
                                    ("stride_hat", "Stride time / $\\sqrt{L/g}$"))):
        for k, (p, c) in enumerate(PEOPLE.items()):
            v = g[g.person == p][col].dropna()
            bp = ax[j].boxplot([v], positions=[k], widths=0.55, showfliers=False, patch_artist=True,
                               medianprops={"color": C["ink"], "lw": 1.5})
            bp["boxes"][0].set(facecolor=c, alpha=0.75, edgecolor=C["ink2"])
        ax[j].set_xticks([0, 1], list(PEOPLE))
        ax[j].set_title(f"({'ab'[j]}) {lab}", loc="left", fontsize=10)
        ax[j].grid(axis="x", visible=False)
    for p in PEOPLE:
        v = g[g.person == p]
        res[p] = {"strides": int(len(v)), "leg_m": round(float(v.leg_m.iloc[0]), 3),
                  "stride_s_median": round(float(v.stride_s.median()), 3),
                  "cadence_median": round(float(v.cadence.median()), 1),
                  "stride_hat_median": round(float(v.stride_hat.median()), 3)}
    h, s = res["Hemel"], res["Spriha"]
    res["stride_diff_pct"] = round(100 * (s["stride_s_median"] / h["stride_s_median"] - 1), 1)
    res["stride_hat_diff_pct"] = round(100 * (s["stride_hat_median"] / h["stride_hat_median"] - 1), 1)
    res["stride_ratio_predicted_by_legs_pct"] = round(100 * (np.sqrt(s["leg_m"] / h["leg_m"]) - 1), 1)
    save(OUT, fig, "C2_gait_size",
         rf"Stride time of all steady strides (Hemel {h['strides']:,}, Spriha {s['strides']:,}). (a) As measured: "
         rf"Spriha's strides are {abs(res['stride_diff_pct']):.0f}\,\% shorter in time. (b) Divided by "
         r"$\sqrt{L/g}$, the natural time scale of a pendulum-like leg of length $L$ (taken as 0.53 of body height; "
         rf"$g$ = 9.81\,m/s$^2$). After this scaling the difference is {abs(res['stride_hat_diff_pct']):.1f}\,\%.", FIGS)


def corr_rows(root):
    rows = []
    for p, b in BODY.items():
        r = pd.read_csv(latest_comparison(root, b["folder"]) / "relationships.csv")
        rows.append(r[r.series == "level"].assign(person=p))
    return pd.concat(rows, ignore_index=True)


def fig_corr(R, res):
    pairs = [("HR vs steps (awake)", "HR vs steps, awake"), ("HR vs sound (sleep)", "HR vs sound, asleep"),
             ("HR vs temperature (sleep)", "HR vs temperature, asleep"), ("HR vs PM$_{2.5}$ (sleep)",
             "HR vs PM$_{2.5}$, asleep"), ("HR vs CO$_2$ (sleep)", "HR vs CO$_2$, asleep"),
             ("PM$_{10}$ vs PM$_{2.5}$ (all)", "PM$_{10}$ vs PM$_{2.5}$"), ("RH vs temperature (all)",
             "RH vs temperature")]
    fig, ax = plt.subplots(figsize=fig_size(3.3), layout="constrained")
    for i, (key, lab) in enumerate(pairs):
        for k, (p, c) in enumerate(PEOPLE.items()):
            row = R[(R.person == p) & (R.pair == key)]
            if not len(row):
                continue
            row = row.iloc[0]
            y = i + (k - 0.5) * 0.32
            ax.plot([row.ci_low, row.ci_high], [y, y], color=c, lw=2)
            ax.plot(row.r_pooled, y, "D", color=c, ms=6, mec="white", label=p if i == 0 else None)
            res.setdefault(lab, {})[p] = {"r": round(float(row.r_pooled), 2), "ci": [round(float(row.ci_low), 2),
                                          round(float(row.ci_high), 2)], "n_min": int(row.n_min), "days": int(row.days),
                                          "slope": round(float(row.slope), 3), "unit": row.unit}
    ax.axvline(0, color=C["ink2"], lw=0.8)
    ax.set_yticks(range(len(pairs)), [l for _, l in pairs])
    ax.invert_yaxis()
    ax.set(xlabel="Within-day correlation $r$ (95 % CI)", xlim=(-1, 1.06))
    ax.grid(axis="y", visible=False)
    ax.legend(loc="upper left", frameon=False)
    save(OUT, fig, "C3_correlations",
         r"The relationships measured for both participants: pooled within-day Pearson $r$ (each variable centred on "
         r"its own day mean) with 95\,\% CI from a 10-minute block bootstrap (Hemel days 1--8, Spriha days 1--4; "
         r"sleep pairs: nights with both band sleep and the bedroom node).", FIGS)


def hr_steps_frame(root):
    rows = []
    for p, b in BODY.items():
        D = cd.Days(root / b["folder"], b["last"], clean=False)
        for n in D.n:
            ctx = {s["key"]: s["context"] for s in D.summary[n]["sessions"]}
            d = subset(D.minutes(n), ctx, "awake")[["steps_band", "hr"]].dropna()
            rows.append(d.assign(person=p, day=n))
    return pd.concat(rows, ignore_index=True)


def fig_hr_steps(h, R, res):
    bins = [-0.5, 0.5, 30, 60, 90, 300]
    labels = ["0", "1–30", "31–60", "61–90", ">90"]
    h["bin"] = pd.cut(h.steps_band, bins, labels=labels)
    fig, ax = plt.subplots(1, 2, figsize=fig_size(2.9), layout="constrained", gridspec_kw={"width_ratios": [1.5, 1]})
    for k, (p, c) in enumerate(PEOPLE.items()):
        d = h[h.person == p]
        # centre on each day's mean so the curves show the within-day effect, then add back the person's mean
        d = d.assign(hrc=d.hr - d.groupby("day").hr.transform("mean") + d.hr.mean())
        q = d.groupby("bin", observed=False).hrc.quantile([0.25, 0.5, 0.75]).unstack()
        cnt = d.groupby("bin", observed=False).size()
        ok = cnt >= 10
        x = np.arange(len(labels)) + (k - 0.5) * 0.18
        ax[0].errorbar(x[ok], q[0.5][ok], yerr=[q[0.5][ok] - q[0.25][ok], q[0.75][ok] - q[0.5][ok]], fmt="o-",
                       color=c, capsize=3, lw=1.4, ms=5, label=p)
        res[p] = {"median_by_bin": {l: round(float(v), 1) for l, v, o in zip(labels, q[0.5], ok) if o},
                  "n_by_bin": {l: int(v) for l, v in cnt.items()}}
        row = R[(R.person == p) & (R.pair == "HR vs steps (awake)")].iloc[0]
        days = sorted(int(c_[7:]) for c_ in row.index if c_.startswith("rho_day") and pd.notna(row[c_]))
        rho = [row[f"rho_day{n}"] for n in days]
        ax[1].scatter(np.full(len(rho), k) + np.linspace(-0.15, 0.15, len(rho)), rho, color=c, s=24, zorder=3,
                      edgecolor="white", lw=0.5)
        res[p]["rho_by_day"] = {int(n): round(float(v), 2) for n, v in zip(days, rho)}
    ax[0].set_xticks(range(len(labels)), labels)
    ax[0].set(xlabel="Band steps in the minute", ylabel="Heart rate (bpm)")
    ax[0].set_title("(a)", loc="left", fontsize=10)
    ax[0].legend(frameon=False, loc="upper left")
    ax[0].grid(axis="x", visible=False)
    ax[1].axhline(0, color=C["ink2"], lw=0.8)
    ax[1].set_xticks([0, 1], list(PEOPLE))
    ax[1].set(ylabel="Spearman $\\rho$ per day", ylim=(-0.2, 0.6), xlim=(-0.6, 1.6))
    ax[1].set_title("(b)", loc="left", fontsize=10)
    ax[1].grid(axis="x", visible=False)
    save(OUT, fig, "C4_hr_steps",
         r"Heart rate and step rate while awake. (a) Median heart rate (bars: inter-quartile range) by the number of "
         r"band steps in the minute, after removing each day's mean so that day-to-day differences do not add to the "
         r"curve (bins with fewer than 10 minutes are omitted). (b) The per-day Spearman correlation; every day of both "
         r"participants is positive.", FIGS)


def partial_spearman(x, y, z):
    rx, ry, rz = rankdata(x), rankdata(y), rankdata(z)
    ex = rx - np.polyval(np.polyfit(rz, rx, 1), rz)
    ey = ry - np.polyval(np.polyfit(rz, ry, 1), rz)
    return np.corrcoef(ex, ey)[0, 1], ex, ey


def boot_ci(f, n, n_boot=4000, seed=0):
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n_boot):
        i = rng.integers(0, n, n)
        if len(np.unique(i)) < 5:
            continue
        v = f(i)
        if np.isfinite(v):
            out.append(v)
    return [round(float(v), 2) for v in np.percentile(out, [2.5, 97.5])]


def fig_water(root, res):
    t = pd.read_csv(latest_comparison(root, "Hemel") / "water_walk.csv").dropna(subset=["hr_rise"])
    x, y, z = t.water_day_ml.to_numpy(float), t.hr_rise.to_numpy(float), t.hour.to_numpy(float)
    rho = spearmanr(x, y)[0]
    rho_hour = spearmanr(z, y)[0]
    rho_xz = spearmanr(x, z)[0]
    pr, ex, ey = partial_spearman(x, y, z)
    res.update({"n_walks": int(len(t)), "rho_rise_water_day": round(float(rho), 2),
                "ci_rise_water_day": boot_ci(lambda i: spearmanr(x[i], y[i])[0], len(t)),
                "rho_rise_hour": round(float(rho_hour), 2), "rho_water_day_hour": round(float(rho_xz), 2),
                "partial_rise_water_day_given_hour": round(float(pr), 2),
                "ci_partial": boot_ci(lambda i: partial_spearman(x[i], y[i], z[i])[0], len(t))})
    for col in ("water_2h_ml",):
        res[f"rho_rise_{col}"] = round(float(spearmanr(t[col], y)[0]), 2)
        res[f"partial_rise_{col}_given_hour"] = round(float(partial_spearman(t[col].to_numpy(float), y, z)[0]), 2)
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.0), layout="constrained")
    sc = ax[0].scatter(x, y, c=z, cmap="viridis", vmin=9, vmax=22, s=40, edgecolor="white", lw=0.5, zorder=3)
    for xi, yi, l in zip(x, y, t.label):
        ax[0].annotate(l, (xi, yi), xytext=(4, 3), textcoords="offset points", fontsize=8, color=C["ink2"])
    ax[0].set(xlabel="Water drunk earlier that day (mL)", ylabel="HR rise above rest (bpm)")
    ax[0].set_title(rf"(a) $\rho$ = {rho:.2f}", loc="left", fontsize=10)
    cb = fig.colorbar(sc, ax=list(ax), pad=0.01)
    cb.set_label("Start (hour)")
    ax[1].scatter(ex, ey, c=z, cmap="viridis", vmin=9, vmax=22, s=40, edgecolor="white", lw=0.5, zorder=3)
    ax[1].axhline(0, color=C["ink2"], lw=0.7)
    ax[1].axvline(0, color=C["ink2"], lw=0.7)
    ax[1].set(xlabel="Water (rank, hour removed)", ylabel="HR rise (rank, hour removed)")
    ax[1].set_title(rf"(b) partial $\rho$ = {pr:.2f}", loc="left", fontsize=10)
    save(OUT, fig, "C5_water_walk",
         rf"Participant~1: water drunk earlier in the day and the rise of heart rate when walking ({len(t)} walks, "
         r"days 1--8; rise = walking heart rate minus the resting heart rate 5--30\,min before). Colour: hour the walk "
         rf"started. (a) Walks after more water had smaller rises ($\rho={rho:.2f}$, 95\,\% CI "
         rf"${res['ci_rise_water_day'][0]:.2f}$ to ${res['ci_rise_water_day'][1]:.2f}$), but the rise also shrinks later in "
         rf"the day ($\rho={rho_hour:.2f}$) and water accumulates through the day ($\rho={rho_xz:.2f}$). (b) Ranks of "
         r"both after removing the time of day: partial $\rho=" + f"{pr:.2f}" + r"$ (95\,\% CI "
         rf"${res['ci_partial'][0]:.2f}$ to ${res['ci_partial'][1]:.2f}$).", FIGS)


def run(root):
    global OUT, FIGS
    root = Path(root).resolve()
    OUT, FIGS = root / "participants", []
    res = {"body": {p: {"height_m": b["height_m"], "mass_kg": b["mass_kg"],
                        "bmi": round(b["mass_kg"] / b["height_m"] ** 2, 1)} for p, b in BODY.items()}}
    m = per_day(root)
    res["per_day"] = {}
    fig_days(m, res["per_day"])
    res["water_per_kg_ml"] = {p: round(1000 * res["per_day"]["hydration_ml"][p]["mean"] / BODY[p]["mass_kg"], 1)
                              for p in BODY}
    res["gait"] = {}
    fig_gait(gait_frame(root), res["gait"])
    R = corr_rows(root)
    res["correlations"] = {}
    fig_corr(R, res["correlations"])
    res["hr_steps"] = {}
    fig_hr_steps(hr_steps_frame(root), R, res["hr_steps"])
    res["water_walk"] = {}
    fig_water(root, res["water_walk"])
    (OUT / "participants_report.json").write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(res, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "../..")
