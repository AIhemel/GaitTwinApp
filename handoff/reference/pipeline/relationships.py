"""Cross-day relationship (correlation / covariance) analysis.

Usage:  python relationships.py <subject_dir> [last_day]

For a fixed set of variable pairs, computed on the per-minute tables of every day:
  * per-day Spearman correlation,
  * pooled within-day (repeated-measures) Pearson correlation: each variable is centred on its own day mean
    before pooling, so differences between days cannot create a correlation; 95 % CI from a moving-block
    bootstrap (10-min blocks) because neighbouring minutes are not independent,
  * the same on minute-to-minute changes (first differences), which removes slow trends that two variables
    share only because both drift over a session,
  * pooled within-day covariance and regression slope (y per unit x) in natural units.
Outputs go to <subject_dir>/comparison/upto_day<N>/ (figures cmp<N>_rel_*, latex/relationships_table.tex,
relationships.csv).
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

import compare_days as cd
from daily_analysis import C, fig_size

WALK = ("outdoor_walk", "walk")
# (group, label, x, y, subset, unit_x, unit_y); the table shows the label without its "(...)" context, under
# a heading that names the group and context
PAIRS = [
    ("Heart rate, awake", "HR vs steps (awake)", "steps_band", "hr", "awake", "steps/min", "bpm"),
    ("Heart rate, walking", "HR vs cadence (walk)", "steps_insole", "hr", "walk_hr", "steps/min", "bpm"),
    ("Heart rate, walking", "HR vs speed (walk)", "gps_speed_mps", "hr", "walk_hr", "m/s", "bpm"),
    ("Heart rate, walking", "HR vs temperature (walk)", "temp_c", "hr", "walk_hr", "°C", "bpm"),
    ("Heart rate, walking", "HR vs PM$_{2.5}$ (walk)", "pm25", "hr", "walk_hr", "µg/m³", "bpm"),
    ("Heart rate, walking", "HR vs sound (walk)", "dba", "hr", "walk_hr", "dBA", "bpm"),
    ("Heart rate, asleep", "HR vs temperature (sleep)", "temp_c", "hr", "sleep_env", "°C", "bpm"),
    ("Heart rate, asleep", "HR vs CO$_2$ (sleep)", "co2_ppm", "hr", "sleep_env", "ppm", "bpm"),
    ("Heart rate, asleep", "HR vs PM$_{2.5}$ (sleep)", "pm25", "hr", "sleep_env", "µg/m³", "bpm"),
    ("Heart rate, asleep", "HR vs sound (sleep)", "dba", "hr", "sleep_env", "dBA", "bpm"),
    ("Gait and sensors, walking", "Stride time vs cadence (walk)", "steps_insole", "stride_time_s", "walk", "steps/min", "s"),
    ("Gait and sensors, walking", "Insole vs band steps (walk)", "steps_band", "steps_insole", "walk", "steps/min", "steps/min"),
    ("Environment", "Sound vs PM$_{2.5}$ (walk)", "pm25", "dba", "walk", "µg/m³", "dBA"),
    ("Environment", "PM$_{10}$ vs PM$_{2.5}$ (all)", "pm25", "pm10", "env", "µg/m³", "µg/m³"),
    ("Environment", "RH vs temperature (all)", "temp_c", "rh_pct", "env", "°C", "%"),
]
HR_GROUPS = ["Heart rate, awake", "Heart rate, walking", "Heart rate, asleep"]


def subset(mt, ctx_of, which):
    ctx = mt.session.map(ctx_of)
    if which == "awake":
        return mt[(mt.context != "sleep") & mt.context.notna()]
    if which == "walk":  # minutes of actual walking
        return mt[ctx.isin(WALK) & (mt.steps_insole >= 60)]
    if which == "walk_hr":  # walking minutes without suspected optical-HR cadence lock (for heart-rate pairs)
        lock = mt.get("hr_cadence_lock", pd.Series(False, index=mt.index)).fillna(False).astype(bool)
        return mt[ctx.isin(WALK) & (mt.steps_insole >= 60) & ~lock]
    if which == "sleep_env":
        return mt[(ctx == "overnight") & (mt.context == "sleep")]
    if which == "env":
        return mt[mt.pm25.notna()]
    raise ValueError(which)


def block_boot_r(blocks, n_boot=1000, seed=0):
    """CI for a pooled correlation by resampling 10-minute blocks (keeps within-block autocorrelation)."""
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n_boot):
        pick = [blocks[i] for i in rng.integers(0, len(blocks), len(blocks))]
        x = np.concatenate([b[0] for b in pick])
        y = np.concatenate([b[1] for b in pick])
        if x.std() > 0 and y.std() > 0:
            out.append(np.corrcoef(x, y)[0, 1])
    return np.percentile(out, [2.5, 97.5]) if out else [np.nan, np.nan]


def analyse(D):
    rows = []
    tables = {n: D.minutes(n) for n in D.n}
    ctx = {n: {s["key"]: s["context"] for s in D.summary[n]["sessions"]} for n in D.n}
    for grp, label, x, y, which, ux, uy in PAIRS:
        for diff in (False, True):
            per_day, blocks, xs, ys = {}, [], [], []
            for n in D.n:
                d = subset(tables[n], ctx[n], which)[[x, y, "session"]].copy()
                d["session"] = d.session.fillna("none")  # minutes outside any sensor session
                if diff:  # minute-to-minute change within each session, consecutive minutes only
                    d = d.sort_index()
                    step = d.index.to_series().diff().dt.total_seconds().eq(60) & d.session.eq(d.session.shift())
                    d[[x, y]] = d[[x, y]].diff()
                    d = d[step]
                d = d.dropna(subset=[x, y])
                if len(d) < 10 or d[x].nunique() < 3 or d[y].nunique() < 3:
                    continue
                per_day[n] = (d[x].corr(d[y], method="spearman"), len(d))
                cx, cy = d[x] - d[x].mean(), d[y] - d[y].mean()  # centre within day
                xs.append(cx.to_numpy()); ys.append(cy.to_numpy())
                g = ((d.index - d.index[0]).total_seconds() // 600).astype(int)
                blocks += [(cx.to_numpy()[g == k], cy.to_numpy()[g == k]) for k in np.unique(g)]
            if not xs:
                continue
            X, Y = np.concatenate(xs), np.concatenate(ys)
            r = np.corrcoef(X, Y)[0, 1]
            lo, hi = block_boot_r(blocks)
            cov = float(np.mean(X * Y))
            rows.append({"group": grp, "pair": label, "x": x, "y": y, "subset": which,
                         "series": "change" if diff else "level", "days": len(per_day), "n_min": int(len(X)),
                         "r_pooled": r, "ci_low": lo, "ci_high": hi, "cov": cov, "slope": cov / np.mean(X * X),
                         "unit": f"{uy} per {ux}", **{f"rho_day{n}": v[0] for n, v in per_day.items()},
                         **{f"n_day{n}": v[1] for n, v in per_day.items()}})
    res = pd.DataFrame(rows)
    res.to_csv(D.out / "relationships.csv", index=False)
    return res


def verdict(row_lvl, row_chg, n_days):
    """Short consistency label used in the table."""
    days = [row_lvl.get(f"rho_day{n}") for n in n_days]
    days = [v for v in days if v is not None and not pd.isna(v)]
    same_sign = len(days) >= 2 and (all(v > 0.2 for v in days) or all(v < -0.2 for v in days))
    sig = not (row_lvl.ci_low <= 0 <= row_lvl.ci_high)
    chg_sig = row_chg is not None and not (row_chg.ci_low <= 0 <= row_chg.ci_high)
    if len(days) < 2:
        return "one day"
    if same_sign and sig and chg_sig and abs(row_lvl.r_pooled) >= 0.3:
        return "consistent"
    if same_sign and sig:
        return "level only"
    if sig:
        return "varies"
    return "none"


def plot(D, res, group_names, name, caption):
    sub = res[res.group.isin(group_names)]
    pairs = list(dict.fromkeys(sub.pair))
    fig, axes = plt.subplots(1, 2, figsize=fig_size(0.33 * len(pairs) + 1.2), sharey=True, layout="constrained")
    for ax, series, title in zip(axes, ("level", "change"), ("(a) Minute values", "(b) Minute changes")):
        ax.axvline(0, color=C["ink"], lw=0.8)
        for yi, p in enumerate(pairs):
            r = sub[(sub.pair == p) & (sub.series == series)]
            if r.empty:
                continue
            r = r.iloc[0]
            for i, n in enumerate(D.n):
                v = r.get(f"rho_day{n}")
                if v is not None and not pd.isna(v):
                    ax.plot(v, yi + (i - (len(D.n) - 1) / 2) * 0.16, "os^D"[i % 4], color=cd.DAY_COLORS[i], ms=5,
                            alpha=0.9, label=D.label(n) if yi == 0 else None)
            ax.plot([r.ci_low, r.ci_high], [yi, yi], color=C["ink"], lw=2.2, solid_capstyle="butt")
            ax.plot(r.r_pooled, yi, "D", color="white", mec=C["ink"], mew=1.6, ms=6.5,
                    label="Pooled (95% CI)" if yi == 0 else None)
        ax.set(xlim=(-1.08, 1.08), xlabel="Correlation", title=title)
        ax.set_xticks([-1, -0.5, 0, 0.5, 1])
        ax.grid(axis="y", visible=False)
    axes[0].set_yticks(range(len(pairs)), pairs)
    axes[0].invert_yaxis()
    h, l = axes[0].get_legend_handles_labels()
    order = sorted(range(len(l)), key=lambda i: (l[i].startswith("Pooled"), l[i]))
    fig.legend([h[i] for i in order], [l[i] for i in order], loc="outside upper center", ncol=min(len(D.n) + 1, 4))
    cd.save(D, fig, name, caption)


def write_table(D, res):
    import re
    def f2(v):  # correlation style without the leading zero: .27, $-$.50
        t = f"{v + 0.0:.2f}".replace("-0.00", "0.00").replace("0.", ".", 1)
        return t.replace("-", "$-$")
    lines = []
    for grp in dict.fromkeys(res.group):
        if lines:
            lines.append(r"\addlinespace")
        lines.append(rf"\multicolumn{{{4 + len(D.n)}}}{{l}}{{\textit{{{grp}}}}} \\")
        for p in dict.fromkeys(res[res.group == grp].pair):
            lv = res[(res.pair == p) & (res.series == "level")].iloc[0]
            ch = res[(res.pair == p) & (res.series == "change")]
            ch = ch.iloc[0] if len(ch) else None
            short = re.sub(r"\s*\(.*?\)$", "", p).replace("HR vs ", "")
            short = (short[0].upper() + short[1:]).replace("Stride time vs", "Stride vs").replace(" steps", "")
            per_day = " & ".join("--" if pd.isna(lv.get(f"rho_day{n}", np.nan)) else f2(lv[f"rho_day{n}"])
                                 for n in D.n)
            chg = "--" if ch is None else f2(ch.r_pooled) + ("$^*$" if not (ch.ci_low <= 0 <= ch.ci_high) else "")
            lines.append(f"\\quad {short} & {per_day} & {f2(lv.r_pooled)} ({f2(lv.ci_low)}, {f2(lv.ci_high)}) & "
                         f"{chg} & {verdict(lv, ch, D.n)} \\\\".replace("-", "$-$", 0))
    (D.out / "latex" / "relationships_table.tex").write_text(
        "% Auto-generated by relationships.py. Requires booktabs.\n"
        "\\begin{table}[htbp]\n  \\centering\n  " + ("\\footnotesize" if len(D.n) < 5 else "\\scriptsize")
        + f"\n  \\setlength{{\\tabcolsep}}{{{2 if len(D.n) >= 7 else 3}pt}}\n"
        f"  \\caption{{Relationships between per-minute measurements, days 1--{max(D.n)}. Pairs are listed as "
        r"heart rate (or the first variable named) against the second. Per day: Spearman $\rho$ on each day. "
        r"Level: pooled within-day (repeated-measures) Pearson $r$ with 10-minute block-bootstrap 95\,\% CI. "
        r"Change: the same for minute-to-minute changes ($^*$: CI excludes zero). Consistent: same sign with "
        r"$|\rho|>0.2$ on every day, both CIs excluding zero and $|r|\geq0.3$; level only: consistent in levels "
        r"but not in changes; varies: pooled CI excludes zero but per-day signs or sizes differ. Covariances and "
        r"regression slopes are given in relationships.csv.}"
        f"\n  \\label{{tab:{D.prefix}_relationships}}\n"
        f"  \\begin{{tabular}}{{l{'r' * len(D.n)}crl}}\n    \\toprule\n"
        f"    & \\multicolumn{{{len(D.n)}}}{{c}}{{Per-day $\\rho$}} & & & \\\\\n"
        f"    \\cmidrule(lr){{2-{1 + len(D.n)}}}\n"
        f"    Pair & {' & '.join(f'D{n}' for n in D.n)} & "
        + ("Level $r$ (95\\,\\% CI) & Change $r$ & " if len(D.n) < 8 else "Level $r$ (CI) & Change & ")
        + "Verdict \\\\\n    \\midrule\n    " + "\n    ".join(lines) +
        "\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n", encoding="utf-8")


def run(subject_dir, last=None):
    D = cd.Days(subject_dir, last, clean=False)
    D.figures = []
    res = analyse(D)
    plot(D, res, HR_GROUPS, "rel_hr",
         r"Heart-rate relationships on each day (coloured symbols: per-day Spearman $\rho$) and pooled over days "
         r"(diamond and bar: within-day Pearson $r$ with 95\,\% block-bootstrap CI). (a) Minute values; (b) "
         r"minute-to-minute changes, which remove slow trends that two variables share only because both drift "
         r"over a session. Walking minutes are those with at least 60 insole steps, excluding minutes of suspected "
         r"optical heart-rate cadence lock; sleep minutes are those inside "
         r"the band's sleep period during the overnight bedroom recording.")
    plot(D, res, ["Gait and sensors, walking", "Environment"], "rel_other",
         r"Gait, sensor-agreement and environment relationships on each day and pooled, presented as in "
         rf"Fig.~\ref{{fig:{D.prefix}_rel_hr}}. These pairs act partly as checks: stride time must fall with cadence, "
         r"and PM$_{2.5}$ and PM$_{10}$ come from the same particle sensor.")
    write_table(D, res)
    for name, cap in D.figures:
        (D.out / "latex" / f"fig_{name}.tex").write_text(
            "\\begin{figure}[htbp]\n  \\centering\n"
            f"  \\includegraphics[width=\\textwidth]{{figures/{name}.pdf}}\n"
            f"  \\caption{{{cap}}}\n  \\label{{fig:{name}}}\n\\end{{figure}}\n", encoding="utf-8")
    print(f"relationships for days {D.n} -> {D.out}")
    return res


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "..", int(sys.argv[2]) if len(sys.argv) > 2 else None)
