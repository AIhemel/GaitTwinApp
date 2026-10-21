"""Side-by-side comparison of the participants (gait, rides, environment by setting).

Usage:  python compare_participants.py <data_root>     (data_root holds Hemel/, spriha/, ...)
Writes <data_root>/participants/figures/P*.pdf|png, latex/fig_*.tex and participants.json.
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

import daily_analysis as da
from daily_analysis import C, fig_size

PEOPLE = {"Hemel": C["blue"], "Spriha": C["orange"]}


def day_dirs(root, person):
    base = root / person
    out = []
    for p in base.iterdir():
        m = re.fullmatch(r"day[ _](\d+)_?", p.name, re.I)
        if m and (p / "analysis_output" / "summary.json").exists():
            out.append((int(m.group(1)), p))
    return sorted(out)


def steady(s):
    return da.steady(s) if len(s) >= 20 else s.iloc[0:0]


def collect(root):
    gait, env, rides = [], [], []
    for person in PEOPLE:
        folder = "spriha" if person == "Spriha" else person
        for n, d in day_dirs(root, folder):
            S = json.loads((d / "analysis_output" / "summary.json").read_text(encoding="utf-8-sig"))
            cfg = json.loads((d / "day_config.json").read_text(encoding="utf-8-sig"))
            ctx = {s["key"]: s["context"] for s in S["sessions"]}
            for f in (d / "analysis_output").glob("strides_*_*.csv"):
                key, side = f.stem.split("_")[1], f.stem.split("_")[2]
                if ctx.get(key) not in da.WALK_CONTEXTS:
                    continue
                s = steady(pd.read_csv(f))
                if len(s) < 20:
                    continue
                health = (S.get("sensor_health") or {}).get(key, {})
                ok_p = side not in cfg.get("stance_invalid_sides", []) and all(
                    health.get(f"{side} {c}", 0) < 10 for c in ("Heel", "Met1", "Met5"))
                gait.append(pd.DataFrame({"person": person, "day": n, "session": key, "side": side,
                                          "stride_s": s.stride_s, "cadence": 120 / s.stride_s,
                                          "stance_pressure": s.stance_pct if ok_p else np.nan,
                                          "stance_imu": s.stance_imu_pct}))
            mt = pd.read_csv(d / "analysis_output" / "minute_table.csv")
            mt = mt[mt.session.notna()]
            mt["setting"] = mt.session.map(ctx).map({"indoor": "Indoor", "outdoor_walk": "Outdoor walk", "walk": "Outdoor walk",
                                                     "transport": "Vehicle", "overnight": "Bedroom"})
            env.append(mt.assign(person=person, day=n)[["person", "day", "setting", "pm25", "temp_c", "dba", "co2_ppm", "hr"]])
            for key, v in S.get("environment", {}).items():
                if key.startswith("transport_"):
                    rides.append({"person": person, "day": n, "session": key[10:], "pm25": v["pm25"]["median"],
                                  "dba": v["dba"]["median"], "temp": v["temp_c"]["median"], "co2": v["co2_ppm"]["median"]})
    return pd.concat(gait, ignore_index=True), pd.concat(env, ignore_index=True), pd.DataFrame(rides)


def save(out, fig, name, caption, figs):
    (out / "figures").mkdir(parents=True, exist_ok=True)
    (out / "latex").mkdir(parents=True, exist_ok=True)
    fig.savefig(out / "figures" / f"{name}.pdf")
    fig.savefig(out / "figures" / f"{name}.png", dpi=200)
    plt.close(fig)
    (out / "latex" / f"fig_{name}.tex").write_text(
        "\\begin{figure}[htbp]\n  \\centering\n"
        f"  \\includegraphics[width=\\textwidth]{{figures/{name}.pdf}}\n"
        f"  \\caption{{{caption}}}\n  \\label{{fig:{name}}}\n\\end{{figure}}\n", encoding="utf-8")
    figs.append(name)


def boxes(ax, groups, pos, colors, width=0.6):
    bp = ax.boxplot(groups, positions=pos, widths=width, showfliers=False, patch_artist=True,
                    medianprops={"color": C["ink"], "lw": 1.5})
    for p, c in zip(bp["boxes"], colors):
        p.set(facecolor=c, alpha=0.75, edgecolor=C["ink2"])


def run(root):
    root = Path(root).resolve()
    out = root / "participants"
    gait, env, rides = collect(root)
    figs, res = [], {}
    # P1: gait
    fig, ax = plt.subplots(1, 3, figsize=fig_size(3.0), layout="constrained")
    for j, (col, lab) in enumerate((("stride_s", "Stride time (s)"), ("cadence", "Cadence (steps/min)"),
                                    ("stance_pressure", "Stance, left pressure (%)"))):
        g = gait if col != "stance_pressure" else gait[gait.side == "L"]
        groups = [g[g.person == p][col].dropna().values for p in PEOPLE]
        boxes(ax[j], groups, [0, 1], list(PEOPLE.values()))
        ax[j].set_xticks([0, 1], list(PEOPLE))
        ax[j].set(ylabel=lab, title=f"({'abc'[j]})")
        ax[j].grid(axis="x", visible=False)
    for p in PEOPLE:
        g = gait[gait.person == p]
        res[p] = {"strides": int(len(g)), "days": sorted(int(x) for x in g.day.unique()),
                  "stride_s_median": round(float(g.stride_s.median()), 3),
                  "cadence_median": round(float(g.cadence.median()), 1),
                  "stance_left_pressure_median": round(float(g[g.side == "L"].stance_pressure.median()), 1),
                  "stance_imu_median_by_side": {s: round(float(g[g.side == s].stance_imu.median()), 1) for s in ("L", "R")}}
    save(out, fig, "P1_gait",
         r"Gait of the two participants in all walks (steady strides; Hemel: days "
         rf"{min(res['Hemel']['days'])}--{max(res['Hemel']['days'])}, {res['Hemel']['strides']:,} strides; Spriha: days "
         rf"{min(res['Spriha']['days'])}--{max(res['Spriha']['days'])}, {res['Spriha']['strides']:,} strides). (a) Stride time, "
         r"(b) cadence and (c) stance phase from the left insole's pressure sensors (the left insole's sensors were original "
         r"and healthy for both participants).", figs)
    # P2: environment by setting
    settings = ["Indoor", "Outdoor walk", "Vehicle", "Bedroom"]
    fig, axes = plt.subplots(2, 2, figsize=fig_size(4.0), layout="constrained")
    for a, (col, lab) in zip(axes.ravel(), (("pm25", "PM$_{2.5}$ ($\\mu$g/m$^3$)"), ("temp_c", "Temp. (°C)"),
                                            ("dba", "Sound (dBA)"), ("hr", "Heart rate (bpm)"))):
        for i, s in enumerate(settings):
            for k, (p, c) in enumerate(PEOPLE.items()):
                v = env[(env.person == p) & (env.setting == s)][col].dropna().values
                if len(v) >= 3:
                    boxes(a, [v], [i + (k - 0.5) * 0.36], [c], width=0.32)
        a.set_xticks(range(len(settings)), ["Indoor", "Outdoor\nwalk", "Vehicle", "Bed-\nroom"], fontsize=9)
        a.set_ylabel(lab)
        a.grid(axis="x", visible=False)
    handles = [plt.Rectangle((0, 0), 1, 1, color=c, alpha=0.75) for c in PEOPLE.values()]
    fig.legend(handles, list(PEOPLE), loc="outside upper center", ncol=2)
    res["env_medians"] = {p: {s: {c: (round(float(env[(env.person == p) & (env.setting == s)][c].median()), 1)
                                      if env[(env.person == p) & (env.setting == s)][c].notna().sum() else None)
                                  for c in ("pm25", "temp_c", "dba", "hr")} for s in settings} for p in PEOPLE}
    span = {p: sorted(int(x) for x in env[env.person == p].day.unique()) for p in PEOPLE}
    save(out, fig, "P2_settings",
         r"Environment and heart rate by setting for the two participants (1-minute values; "
         + "; ".join(rf"{p} days {span[p][0]}--{span[p][-1]}" for p in PEOPLE)
         + r"). Temperatures include the $-5$\,°C correction. Spriha's band recorded heart rate every 10 minutes on "
         r"days 1--2 and every minute from day~3, so her heart-rate boxes rest on fewer minutes.", figs)
    res["rides"] = rides.to_dict("records")
    (out / "participants.json").write_text(json.dumps(res, indent=1, default=str))
    print(json.dumps(res, indent=1, default=str))


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "../..")
