"""Cross-day follow-up analyses (run after compare_days.py and relationships.py).

Usage:  python walk_hydration.py <subject_dir> [last_day]

1. Robustness of the heart-rate / step-rate relationship: per-day Spearman rho with block-bootstrap CIs,
   leave-one-day-out pooled r, the effect of removing suspected cadence-lock minutes, and how the pooled
   within-day correlation depends on the time scale (changes of 1- to 30-min means).
2. Water before walking: fluid in the 2 h before each walk and time since the last drink against walking heart
   rate, with temperature and pace as possible confounders.

Writes comparison/upto_dayN/: figures cmpN_hr_steps_robust, cmpN_water_walk (+ latex/fig_*.tex),
hr_steps_robustness.json, water_walk.csv, water_walk.json.
"""
import json
import sys

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

import daily_analysis as da
from daily_analysis import C, fig_size
from compare_days import Days, DAY_COLORS, save

RNG = np.random.default_rng(7)
B = 2000  # bootstrap replicates


def pooled_r(df, x, y):
    """Within-day (repeated-measures) Pearson r: both variables centred on each day's mean."""
    d = df[[x, y, "day"]].dropna()
    if len(d) < 10:
        return np.nan
    xc = d[x] - d.groupby("day")[x].transform("mean")
    yc = d[y] - d.groupby("day")[y].transform("mean")
    return float(np.corrcoef(xc, yc)[0, 1])


def block_boot(df, fn, block="block"):
    """Bootstrap CI resampling whole blocks within each day (keeps the autocorrelation inside blocks)."""
    groups = {k: g for k, g in df.groupby(["day", block])}
    keys = list(groups)
    by_day = pd.Series(keys).groupby([k[0] for k in keys]).apply(list)
    vals = []
    for _ in range(B):
        pick = [groups[k] for ks in by_day for k in (ks[i] for i in RNG.integers(0, len(ks), len(ks)))]
        vals.append(fn(pd.concat(pick)))
    return [float(np.nanpercentile(vals, 2.5)), float(np.nanpercentile(vals, 97.5))]


def load_minutes(D):
    out = []
    for n in D.n:
        m = D.minutes(n).reset_index()
        m["day"] = n
        out.append(m)
    m = pd.concat(out, ignore_index=True)
    m["block"] = m.minute.dt.floor("10min")
    return m


# =========================================================================== 1. HR vs steps robustness
def hr_steps_robustness(D, m):
    aw = m[m.context.notna() & (m.context != "sleep") & m.hr.notna() & m.steps_band.notna()].copy()
    res = {"minutes": int(len(aw)), "per_day": {}}
    for n, g in aw.groupby("day"):
        rho = lambda d: d.hr.corr(d.steps_band, method="spearman")
        res["per_day"][n] = {"rho": round(float(rho(g)), 2), "ci": [round(v, 2) for v in block_boot(g, rho)],
                             "n": int(len(g))}
    res["positive_days"] = int(sum(v["rho"] > 0 for v in res["per_day"].values()))
    res["sign_test_p_two_sided"] = round(float(2 * 0.5 ** len(res["per_day"])), 4) \
        if res["positive_days"] in (0, len(res["per_day"])) else None
    r_all = lambda d: pooled_r(d, "steps_band", "hr")
    res["pooled"] = {"r": round(r_all(aw), 2), "ci": [round(v, 2) for v in block_boot(aw, r_all)]}
    res["leave_one_day_out"] = {n: round(r_all(aw[aw.day != n]), 2) for n in D.n}
    nolock = aw[~aw.hr_cadence_lock.fillna(False).astype(bool)]
    res["pooled_without_lock"] = {"r": round(r_all(nolock), 2), "ci": [round(v, 2) for v in block_boot(nolock, r_all)],
                                  "lock_minutes_removed": int(len(aw) - len(nolock))}
    # time scale: correlation of changes between consecutive k-minute means (k = 1 ... 30)
    scales = {}
    for k in (1, 2, 5, 10, 15, 30):
        rows = []
        for n, g in aw.groupby("day"):
            s = g.set_index("minute")[["hr", "steps_band"]].resample(f"{k}min").mean()
            s = s.diff().dropna()
            s["day"], s["block"] = n, s.index.floor("60min") if k < 10 else s.index.floor("180min")
            rows.append(s.reset_index())
        ch = pd.concat(rows)
        f = lambda d: pooled_r(d, "steps_band", "hr")
        scales[k] = {"r": round(f(ch), 2), "ci": [round(v, 2) for v in block_boot(ch, f)], "n": int(len(ch))}
    res["change_by_scale_min"] = scales
    # slope: bpm per 100 steps/min (within-day)
    xc = aw.steps_band - aw.groupby("day").steps_band.transform("mean")
    yc = aw.hr - aw.groupby("day").hr.transform("mean")
    res["slope_bpm_per_100_steps_min"] = round(float(100 * np.polyfit(xc, yc, 1)[0]), 1)
    res["r_squared_pct"] = round(100 * res["pooled"]["r"] ** 2, 1)
    return res


def plot_hr_steps_robust(D, res):
    fig, ax = plt.subplots(1, 2, figsize=fig_size(3.2), layout="constrained", gridspec_kw={"width_ratios": [1.1, 1]})
    days = list(res["per_day"])
    for j, n in enumerate(days):
        v = res["per_day"][n]
        ax[0].errorbar(v["rho"], j, xerr=[[v["rho"] - v["ci"][0]], [v["ci"][1] - v["rho"]]], fmt="o",
                       color=DAY_COLORS[D.n.index(n)], ms=6, capsize=3)
    p = res["pooled"]
    ax[0].errorbar(p["r"], len(days) + 0.4, xerr=[[p["r"] - p["ci"][0]], [p["ci"][1] - p["r"]]], fmt="D",
                   color=C["ink"], mfc="white", ms=7, capsize=3)
    lodo = list(res["leave_one_day_out"].values())
    ax[0].plot(lodo, [len(days) + 1.2] * len(lodo), "|", color=C["ink2"], ms=10, mew=1.5)
    ax[0].set_yticks(list(range(len(days))) + [len(days) + 0.4, len(days) + 1.2],
                     [f"Day {n}" for n in days] + ["Pooled", "Leave one\nday out"])
    ax[0].axvline(0, color=C["ink"], lw=0.8)
    ax[0].set(xlabel=r"Correlation (HR vs steps)", title="(a) Per day and pooled", xlim=(-0.15, 0.5))
    ax[0].invert_yaxis()
    ax[0].grid(axis="y", visible=False)
    ks = list(res["change_by_scale_min"])
    r = [res["change_by_scale_min"][k]["r"] for k in ks]
    lo = [res["change_by_scale_min"][k]["ci"][0] for k in ks]
    hi = [res["change_by_scale_min"][k]["ci"][1] for k in ks]
    x = np.arange(len(ks))
    ax[1].fill_between(x, lo, hi, color=C["band"], lw=0)
    ax[1].plot(x, r, "o-", color=C["blue"], lw=1.6, ms=5, label="Changes")
    ax[1].axhline(p["r"], color=C["ink"], lw=1, ls="--", label="Levels (pooled)")
    ax[1].axhline(0, color=C["ink2"], lw=0.8)
    ax[1].set_xticks(x, [str(k) for k in ks])
    ax[1].set(xlabel="Averaging window (min)", ylabel="Pooled within-day r", title="(b) Changes vs time scale")
    ax[1].legend(loc="upper left", fontsize=9.5)
    sc = res["change_by_scale_min"]
    save(D, fig, "hr_steps_robust",
         rf"Robustness of the relationship between wrist heart rate and step rate in awake minutes "
         rf"({res['minutes']:,} minutes, days {D.n[0]}--{D.n[-1]}). (a) Spearman $\rho$ per day with 10-minute block-"
         rf"bootstrap 95\,\% CIs; pooled within-day Pearson $r$ (diamond) and the pooled $r$ when each day in turn is left "
         rf"out (ticks: {min(lodo):.2f}--{max(lodo):.2f}). (b) Pooled within-day correlation between \emph{{changes}} of heart "
         rf"rate and step rate after averaging over windows of 1 to 30 minutes (band: 95\,\% CI); dashed: correlation of "
         rf"levels. Minute-to-minute changes are unrelated ($r={sc[1]['r']:.2f}$) because heart rate responds to activity "
         rf"over several minutes; over {ks[-1]}-minute windows the changes correlate with $r={sc[ks[-1]]['r']:.2f}$.")


# =========================================================================== 2. water before walking
def walk_table(D, m):
    rows = []
    for n in D.n:
        S = D.summary[n]
        hyd = D.hydration(n)
        if hyd is None:
            continue
        prev = D.hydration(n - 1) if n - 1 in D.n else None  # last drink may be on the previous day
        if prev is not None:
            hyd = pd.concat([prev, hyd], ignore_index=True)
        hyd["t"] = pd.to_datetime(hyd.local_time).dt.tz_localize(da.TZ)
        mt = m[m.day == n].set_index("minute")
        for s in S["sessions"]:
            if s["context"] not in da.WALK_CONTEXTS:
                continue
            t0, t1 = (pd.Timestamp(s[k]).tz_localize(da.TZ) for k in ("start", "end"))
            w = mt[t0:t1]
            steps = w.steps_insole.fillna(w.steps_band)
            walking = w[(steps >= 80)]
            valid = walking[~walking.hr_cadence_lock.fillna(False).astype(bool) & walking.hr.notna()]
            if len(walking) < 4:
                continue
            first = walking.index.min()
            before = hyd[hyd.t < first]
            pre = mt[first - pd.Timedelta(minutes=30):first - pd.Timedelta(minutes=5)]
            pre_rest = pre[(pre.steps_band.fillna(0) < 20)].hr
            rows.append({
                "day": n, "walk": s["key"], "label": f"D{n}-{s['key']}", "start": f"{first:%H:%M}",
                "walking_min": int(len(walking)), "hr_valid_min": int(len(valid)),
                "lock_min": int(walking.hr_cadence_lock.fillna(False).astype(bool).sum()),
                # walking HR not determinable when most walking minutes are suspected cadence lock
                "walk_hr": float(valid.hr.median()) if len(valid) >= 4 and
                len(valid) >= 0.5 * walking.hr.notna().sum() else np.nan,
                "pre_rest_hr": float(pre_rest.median()) if len(pre_rest) >= 5 else np.nan,
                "water_2h_ml": int(before[before.t >= first - pd.Timedelta(hours=2)].volume_ml.sum()),
                "water_day_ml": int(before[before.t >= first.normalize()].volume_ml.sum()),
                "h_since_drink": round(float((first - before.t.max()).total_seconds() / 3600), 2) if len(before) else np.nan,
                "temp_c": float(walking.temp_c.median()) if walking.temp_c.notna().any() else np.nan,
                "cadence": float(steps[steps >= 80].median()),
                "speed_mps": float(walking.gps_speed_mps.median()) if walking.gps_speed_mps.notna().any() else np.nan,
                "hour": first.hour + first.minute / 60})
    t = pd.DataFrame(rows)
    t["hr_rise"] = t.walk_hr - t.pre_rest_hr
    return t


def spearman_ci(x, y):
    d = pd.DataFrame({"x": x, "y": y}).dropna()
    if len(d) < 4:
        return np.nan, [np.nan, np.nan], len(d)
    rho = d.x.corr(d.y, method="spearman")
    boots = []
    for _ in range(B):
        s = d.iloc[RNG.integers(0, len(d), len(d))]
        if s.x.nunique() > 1 and s.y.nunique() > 1:
            boots.append(s.x.corr(s.y, method="spearman"))
    return float(rho), [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))], len(d)


def partial_spearman(d, x, y, z):
    """Spearman correlation of x and y after removing the linear effect of z from the ranks of both."""
    r = d[[x, y, z]].dropna().rank()
    if len(r) < 5:
        return np.nan
    res = lambda a: r[a] - np.polyval(np.polyfit(r[z], r[a], 1), r[z])
    return float(np.corrcoef(res(x), res(y))[0, 1])


def water_walk(D, t):
    v = t.dropna(subset=["walk_hr"])
    res = {"walks": int(len(t)), "walks_with_hr": int(len(v)), "pairs": {}}
    res["excluded_lock"] = t[t.walk_hr.isna() & (t.lock_min > 0)].label.tolist()
    res["partial"] = {f"hr_rise~{x}|hour": round(partial_spearman(v, x, "hr_rise", "hour"), 2)
                      for x in ("water_2h_ml", "water_day_ml", "h_since_drink")}
    res["partial"].update({f"walk_hr~{x}|temp_c": round(partial_spearman(v, x, "walk_hr", "temp_c"), 2)
                           for x in ("water_2h_ml", "h_since_drink")})
    for x in ("water_2h_ml", "h_since_drink", "water_day_ml", "temp_c", "cadence", "hour"):
        for y in ("walk_hr", "hr_rise"):
            r, ci, n = spearman_ci(v[x], v[y])
            res["pairs"][f"{y}~{x}"] = {"rho": round(r, 2), "ci": [round(c, 2) for c in ci], "n": n}
    r, ci, n = spearman_ci(v.water_2h_ml, v.temp_c)
    res["pairs"]["temp_c~water_2h_ml"] = {"rho": round(r, 2), "ci": [round(c, 2) for c in ci], "n": n}
    # linear model with temperature as covariate (descriptive; few walks)
    d = v.dropna(subset=["water_2h_ml", "temp_c"])
    X = np.column_stack([np.ones(len(d)), d.water_2h_ml / 100, d.temp_c])
    beta, *_ = np.linalg.lstsq(X, d.walk_hr, rcond=None)
    boots = []
    for _ in range(B):
        s = d.iloc[RNG.integers(0, len(d), len(d))]
        Xs = np.column_stack([np.ones(len(s)), s.water_2h_ml / 100, s.temp_c])
        if np.linalg.matrix_rank(Xs) == 3:
            boots.append(np.linalg.lstsq(Xs, s.walk_hr, rcond=None)[0][1])
    res["model_hr_per_100ml_adj_temp"] = {"b": round(float(beta[1]), 1), "ci": [round(float(np.percentile(boots, q)), 1)
                                                                              for q in (2.5, 97.5)], "n": int(len(d))}
    drank = v[v.water_2h_ml >= 200]
    dry = v[v.water_2h_ml < 200]
    res["groups"] = {"drank_200ml_2h": {"n": int(len(drank)), "median_hr": round(float(drank.walk_hr.median()), 0)
                                        if len(drank) else None, "walks": drank.label.tolist()},
                     "less": {"n": int(len(dry)), "median_hr": round(float(dry.walk_hr.median()), 0)
                              if len(dry) else None, "walks": dry.label.tolist()}}
    return res


def place_labels(ax, xs, ys, labels, fontsize=8):
    """Greedy label placement: for each point try 8 positions around it and keep the first whose box overlaps no
    earlier label and no other marker (boxes estimated in points)."""
    fig = ax.figure
    fig.canvas.draw()
    to_pt = lambda x, y: ax.transData.transform((x, y)) * 72 / fig.dpi
    pts = [to_pt(x, y) for x, y in zip(xs, ys)]
    placed = []
    opts = [(6, 0, "left", "center"), (-6, 0, "right", "center"), (0, 7, "center", "bottom"), (0, -7, "center", "top"),
            (5, 7, "left", "bottom"), (-5, 7, "right", "bottom"), (5, -7, "left", "top"), (-5, -7, "right", "top")]
    for k, ((px, py), lab) in enumerate(zip(pts, labels)):
        w, h = 0.55 * fontsize * len(lab), 1.1 * fontsize
        for dx, dy, ha, va in opts:
            x0 = px + dx - (w if ha == "right" else w / 2 if ha == "center" else 0)
            y0 = py + dy - (h if va == "top" else h / 2 if va == "center" else 0)
            box = (x0, y0, x0 + w, y0 + h)
            hit = any(not (box[2] < b[0] or box[0] > b[2] or box[3] < b[1] or box[1] > b[3]) for b in placed)
            hit |= any(j != k and box[0] - 4 < qx < box[2] + 4 and box[1] - 4 < qy < box[3] + 4
                       for j, (qx, qy) in enumerate(pts))
            if not hit:
                break
        placed.append(box)
        ax.annotate(lab, (xs[k], ys[k]), xytext=(dx, dy), textcoords="offset points", ha=ha, va=va,
                    fontsize=fontsize, color=C["ink2"])


def plot_water_walk(D, t, res):
    v = t.dropna(subset=["walk_hr"])
    fig, ax = plt.subplots(1, 3, figsize=fig_size(3.1), layout="constrained")
    panels = ((ax[0], "water_2h_ml", "walk_hr", "Water in 2 h before (mL)", "Walking HR (bpm)", "a"),
              (ax[1], "water_2h_ml", "hr_rise", "Water in 2 h before (mL)", "HR rise above rest (bpm)", "b"),
              (ax[2], "hour", "hr_rise", "Start (hour of day)", "HR rise above rest (bpm)", "c"))
    for a, x, y, xl, yl, letter in panels:
        for _, r in v.iterrows():
            i = D.n.index(r.day)
            a.plot(r[x], r[y], "os^D*vP"[i % 7], color=DAY_COLORS[i], ms=7, mec="white", mew=0.6)
        p = res["pairs"][f"{y}~{x}"]
        a.set(xlabel=xl, ylabel=yl, title=rf"({letter}) $\rho$ = {p['rho']:.2f}")
    ax[1].axhline(0, color=C["ink2"], lw=0.8)
    ax[2].axhline(0, color=C["ink2"], lw=0.8)
    ax[0].set_xlim(-300, v.water_2h_ml.max() + 150)
    ax[1].set_xlim(-300, v.water_2h_ml.max() + 150)
    ax[2].set_xlim(v.hour.min() - 4, v.hour.max() + 2.5)
    for a, x, y, *_ in panels:
        place_labels(a, v[x].tolist(), v[y].tolist(), v.label.tolist())
    pa, pb, pc = (res["pairs"][k] for k in ("walk_hr~water_2h_ml", "hr_rise~water_2h_ml", "hr_rise~hour"))
    pp = res["partial"]["hr_rise~water_2h_ml|hour"]
    excl = (rf" Walks {', '.join(res['excluded_lock'])} are excluded because most of their walking minutes were suspected "
            r"cadence lock." if res["excluded_lock"] else "")
    save(D, fig, "water_walk",
         rf"Water drunk before walking and heart rate during the walk ({res['walks_with_hr']} walks over days "
         rf"{D.n[0]}--{D.n[-1]}; median heart rate of walking minutes excluding suspected cadence lock).{excl} (a) Walking "
         r"heart rate against fluid from the bottle log in the 2 hours before the walk; (b) rise of heart rate above the "
         r"resting value 5--30 minutes before the walk, against the same; (c) that rise against the time of day. "
         rf"Spearman $\rho$ with bootstrap 95\,\% CI: (a) {pa['rho']:.2f} ({pa['ci'][0]:.2f} to {pa['ci'][1]:.2f}), "
         rf"(b) {pb['rho']:.2f} ({pb['ci'][0]:.2f} to {pb['ci'][1]:.2f}), (c) {pc['rho']:.2f} ({pc['ci'][0]:.2f} to "
         rf"{pc['ci'][1]:.2f}); (b) after allowing for the time of day: partial $\rho={pp:.2f}$. Labels: day and walk.")


def plot_aligned(D, m, t):
    """Heart rate from 30 min before to 15 min after the start of each walk, drank (>= 200 mL in 2 h) vs not."""
    v = t.dropna(subset=["walk_hr"])
    fig, ax = plt.subplots(figsize=fig_size(3.2), layout="constrained")
    for _, r in v.iterrows():
        mt = m[m.day == r.day].set_index("minute")
        t0 = pd.Timestamp(f"{D.cfg[r.day]['date']} {r.start}", tz=da.TZ)
        w = mt[t0 - pd.Timedelta(minutes=30):t0 + pd.Timedelta(minutes=15)].hr
        x = (w.index - t0).total_seconds() / 60
        drank = r.water_2h_ml >= 200
        ax.plot(x, w.values, color=C["blue"] if drank else C["ink2"], lw=1.8 if drank else 0.9,
                alpha=0.95 if drank else 0.55, label="Drank $\\geq$200 mL in the 2 h before" if drank else "No drink in the 2 h before")
        if drank:
            ax.annotate(r.label, (x[-1], w.values[-1]), xytext=(3, 0), textcoords="offset points", fontsize=8.5,
                        color=C["blue"], va="center")
    ax.axvline(0, color=C["ink"], lw=1, ls="--")
    ax.axvspan(-30, -5, color=C["band"], lw=0, zorder=0)
    ax.text(-17.5, 0.02, "resting window", transform=ax.get_xaxis_transform(),
            ha="center", va="bottom", fontsize=9, color=C["ink2"])
    h, l = ax.get_legend_handles_labels()
    u = dict(zip(l, h))
    ax.legend(u.values(), u.keys(), loc="upper left", fontsize=9)
    ax.set(xlabel="Minutes from the start of walking", ylabel="Heart rate (bpm)", xlim=(-30, 19))
    save(D, fig, "walk_hr_aligned",
         rf"Wrist heart rate around the start of every walk with a valid walking heart rate ({len(v)} walks, days "
         rf"{D.n[0]}--{D.n[-1]}), aligned at the first walking minute (dashed). Blue: walks with at least 200\,mL drunk in "
         r"the previous 2 hours (labelled); grey: the others. The shaded band is the resting window used for the rise "
         r"of heart rate above rest.")


def run(subject_dir, last=None):
    D = Days(subject_dir, last, clean=False)
    m = load_minutes(D)
    rob = hr_steps_robustness(D, m)
    plot_hr_steps_robust(D, rob)
    t = walk_table(D, m)
    t.to_csv(D.out / "water_walk.csv", index=False)
    ww = water_walk(D, t)
    plot_water_walk(D, t, ww)
    plot_aligned(D, m, t)
    (D.out / "hr_steps_robustness.json").write_text(json.dumps(rob, indent=1, default=str))
    (D.out / "water_walk.json").write_text(json.dumps(ww, indent=1, default=str))
    for name, cap in D.figures:
        (D.out / "latex" / f"fig_{name}.tex").write_text(
            "\\begin{figure}[htbp]\n  \\centering\n"
            f"  \\includegraphics[width=\\textwidth]{{figures/{name}.pdf}}\n"
            f"  \\caption{{{cap}}}\n  \\label{{fig:{name}}}\n\\end{{figure}}\n", encoding="utf-8")
    print(f"robustness + water-before-walk for days {D.n} -> {D.out}")
    return rob, t, ww


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "..", int(sys.argv[2]) if len(sys.argv) > 2 else None)
