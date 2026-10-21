"""ML task A, step 2: heel-strike detection from the raw foot-IMU stream (no pressure sensors).

Usage:  python ml_heelstrike.py <subject_dir> [--rebuild]

Each insole stream is resampled to 100 Hz with four IMU channels (foot tilt from flat, tilt rate, rotation speed,
acceleration magnitude). A small temporal convolutional network (TCN) outputs, for every sample, how likely a heel
strike is there; peaks above 0.4 are detections. Labels: the impact times of all detected strides. Scored only inside
"labelled regions" (every step there is known) and in vehicle/lift periods (no steps there at all).

Baseline: peak detector on acceleration magnitude, threshold tuned on the training days.
Evaluation: leave-one-day-out over 7 days, and cross-foot (train on one foot, test on the other).
Writes <subject_dir>/ml/A_gait/heelstrike_results.json and figures.
"""
import json
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy.signal import find_peaks

import daily_analysis as da
from daily_analysis import C, fig_size
from compare_days import Days
from ml_gait import imu_signals, session_obj, CHANNELS

FS = 100           # Hz after resampling
TOL_MS = 50        # a detection within +-50 ms of a labelled impact is a hit
MIN_DIST = 60      # samples (0.6 s): one heel strike per foot per stride at most
VEHICLE_WORDS = ("rickshaw", "metro", "vehicle", "lift", "train")


# =========================================================================== dataset
def resample(d, sig):
    """Uniform 100 Hz segments of the four channels, split where the stream has gaps > 200 ms."""
    t = d.t.to_numpy(float)
    cut = np.where(np.diff(t) > 200)[0]
    segs = []
    for a, b in zip(np.r_[0, cut + 1], np.r_[cut + 1, len(t)]):
        if t[b - 1] - t[a] < 5000:
            continue
        grid = np.arange(t[a], t[b - 1], 1000 / FS)
        segs.append((grid, np.stack([np.interp(grid, t[a:b], sig[c][a:b]) for c in CHANNELS]).astype(np.float32)))
    return segs


def build(D):
    data = []
    for n in D.n:
        base = D.dirs[D.n.index(n)]
        # walking: every gait session with strides
        for sm in D.summary[n]["sessions"]:
            key = sm["key"]
            for side in ("R", "L"):
                f = base / "analysis_output" / f"strides_{key}_{side}.csv"
                if not f.exists():
                    continue
                s = pd.read_csv(f)
                s = s[s.hs_imu_ms.notna()]
                if len(s) < 30:
                    continue
                sess = session_obj(D, n, key)
                d = da.gait_timed(sess, side) if sess.has("gait") else None
                if d is None:
                    continue
                fs = len(d) / max(1e-9, (d.t.iloc[-1] - d.t.iloc[0]) / 1000)
                sig, _ = imu_signals(d, fs)
                imp = s.hs_imu_ms.to_numpy(float)
                reg = np.stack([imp - 250, imp + 1000 * s.stride_s.to_numpy() - 250], axis=1)
                for grid, X in resample(d, sig):
                    inreg = np.zeros(len(grid), bool)
                    for a, b in reg:
                        inreg[(grid >= a) & (grid < b)] = True
                    if inreg.sum() < 3 * FS:
                        continue
                    labs = imp[(imp >= grid[0]) & (imp <= grid[-1])]
                    data.append({"day": n, "session": key, "side": side, "kind": "walk", "t": grid, "X": X,
                                 "mask": inreg, "impacts": labs})
        # vehicles and lift: no steps at all
        for e in D.cfg[n].get("events", []):
            if not e.get("exclude_gait") or not any(w in e["label"].lower() for w in VEHICLE_WORDS):
                continue
            at = lambda v: pd.Timestamp(v if len(v) > 8 else f"{D.cfg[n]['date']} {v}", tz=da.TZ)
            t0, t1 = at(e["start"]), at(e["end"])
            for sc in D.cfg[n]["sessions"]:
                folder = base / sc["folder"]
                if not (folder / "gait.csv").exists():
                    continue
                sess = da.Session("veh", e["label"], "transport", folder, t0, t1, None, True)
                for side in ("R", "L"):
                    try:
                        d = da.gait_timed(sess, side)
                    except Exception:
                        d = None
                    if d is None or len(d) < 500:
                        continue
                    fs = len(d) / max(1e-9, (d.t.iloc[-1] - d.t.iloc[0]) / 1000)
                    sig, _ = imu_signals(d, fs)
                    for grid, X in resample(d, sig):
                        data.append({"day": n, "session": e["label"], "side": side, "kind": "vehicle", "t": grid,
                                     "X": X, "mask": np.ones(len(grid), bool), "impacts": np.array([])})
                break  # one folder per event
        print(f"day {n}: {sum(1 for x in data if x['day'] == n)} segments, "
              f"{sum(len(x['impacts']) for x in data if x['day'] == n)} labelled impacts, "
              f"{sum(len(x['t']) for x in data if x['day'] == n and x['kind'] == 'vehicle') / FS / 60:.1f} vehicle min",
              flush=True)
    return data


def heatmap(seg, sigma=3):
    y = np.zeros(len(seg["t"]), np.float32)
    idx = np.searchsorted(seg["t"], seg["impacts"])
    k = np.arange(-4 * sigma, 4 * sigma + 1)
    for i in idx:
        j = i + k
        ok = (j >= 0) & (j < len(y))
        y[j[ok]] = np.maximum(y[j[ok]], np.exp(-0.5 * (k[ok] / sigma) ** 2))
    return y


# =========================================================================== model
def make_net(torch):
    nn = torch.nn

    class Block(nn.Module):
        def __init__(self, ch, dil):
            super().__init__()
            self.c = nn.Sequential(nn.Conv1d(ch, ch, 5, padding=2 * dil, dilation=dil), nn.BatchNorm1d(ch), nn.ReLU(),
                                   nn.Conv1d(ch, ch, 1))
            self.act = nn.ReLU()

        def forward(self, x):
            return self.act(x + self.c(x))

    class TCN(nn.Module):
        """Dilated convolutions see about 1.3 s of context: enough to tell the heel strike from push-off peaks."""
        def __init__(self, ch=32):
            super().__init__()
            self.inp = nn.Sequential(nn.Conv1d(len(CHANNELS), ch, 7, padding=3), nn.BatchNorm1d(ch), nn.ReLU())
            self.blocks = nn.Sequential(*[Block(ch, d) for d in (1, 2, 4, 8, 16)])
            self.out = nn.Conv1d(ch, 1, 1)

        def forward(self, x):
            return self.out(self.blocks(self.inp(x))).squeeze(1)

    return TCN()


class HeelStrikeTCN:
    def __init__(self, steps=2500, seed=0, win=512):
        import torch
        self.torch, self.steps, self.seed, self.win = torch, steps, seed, win
        self.dev = "cuda" if torch.cuda.is_available() else "cpu"

    def fit(self, segs):
        torch = self.torch
        rng = np.random.default_rng(self.seed)
        torch.manual_seed(self.seed)
        segs = [s for s in segs if len(s["t"]) > self.win]
        allX = np.concatenate([s["X"] for s in segs], axis=1)
        self.mu, self.sd = allX.mean(1, keepdims=True), allX.std(1, keepdims=True) + 1e-6
        targ = [heatmap(s) for s in segs]
        w = np.array([len(s["t"]) * (3 if s["kind"] == "vehicle" else 1) for s in segs], float)
        w /= w.sum()  # vehicles are rare: sample them more often
        self.net = make_net(torch).to(self.dev)
        opt = torch.optim.AdamW(self.net.parameters(), lr=2e-3, weight_decay=1e-3)
        sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=self.steps)
        for _ in range(self.steps):
            xb, yb, mb = [], [], []
            for i in rng.choice(len(segs), 64, p=w):
                s = segs[i]
                a = rng.integers(0, len(s["t"]) - self.win)
                x = (s["X"][:, a:a + self.win] - self.mu) / self.sd
                x = x * (1 + 0.1 * rng.standard_normal((x.shape[0], 1)))  # amplitude jitter
                xb.append(x)
                yb.append(targ[i][a:a + self.win])
                mb.append(s["mask"][a:a + self.win])
            xb = torch.tensor(np.array(xb), dtype=torch.float32, device=self.dev)
            yb = torch.tensor(np.array(yb), device=self.dev)
            mb = torch.tensor(np.array(mb), dtype=torch.float32, device=self.dev)
            logit = self.net(xb)
            l = torch.nn.functional.binary_cross_entropy_with_logits(logit, yb, reduction="none",
                                                                     pos_weight=torch.tensor(8.0, device=self.dev))
            loss = (l * mb).sum() / mb.sum().clamp(min=1)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
        return self

    def prob(self, seg):
        torch = self.torch
        self.net.eval()
        with torch.no_grad():
            x = torch.tensor((seg["X"] - self.mu) / self.sd, dtype=torch.float32, device=self.dev)[None]
            return torch.sigmoid(self.net(x))[0].cpu().numpy()

    def n_params(self):
        return int(sum(p.numel() for p in self.net.parameters()))


def detect_tcn(model, seg, thr=0.4):
    p = model.prob(seg)
    pk, _ = find_peaks(p, height=thr, distance=MIN_DIST)
    return seg["t"][pk]


def detect_peaks(seg, h):
    """Baseline: acceleration-magnitude peaks at least h m/s^2 above the stream's median."""
    acc = seg["X"][CHANNELS.index("acc")]
    pk, _ = find_peaks(acc, height=np.median(acc) + h, distance=MIN_DIST)
    return seg["t"][pk]


# =========================================================================== scoring
def score(segs, detections):
    tp = fp = fn = 0
    errs, veh_fp, veh_min = [], 0, 0.0
    for s, det in zip(segs, detections):
        inm = s["mask"][np.clip(np.searchsorted(s["t"], det), 0, len(s["t"]) - 1)] if len(det) else np.array([], bool)
        det = det[inm]
        if s["kind"] == "vehicle":
            veh_fp += len(det)
            veh_min += len(s["t"]) / FS / 60
            continue
        lab = s["impacts"]
        lab = lab[s["mask"][np.clip(np.searchsorted(s["t"], lab), 0, len(s["t"]) - 1)]]
        used = np.zeros(len(det), bool)
        for x in lab:
            if len(det):
                j = np.argmin(np.abs(det - x) + used * 1e9)
                if not used[j] and abs(det[j] - x) <= TOL_MS:
                    used[j] = True
                    tp += 1
                    errs.append(det[j] - x)
                    continue
            fn += 1
        fp += int((~used).sum())
    P = tp / max(tp + fp, 1)
    R = tp / max(tp + fn, 1)
    e = np.array(errs)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": round(P, 4), "recall": round(R, 4),
            "f1": round(2 * P * R / max(P + R, 1e-9), 4),
            "timing_bias_ms": round(float(e.mean()), 1) if len(e) else None,
            "timing_sd_ms": round(float(e.std()), 1) if len(e) else None,
            "vehicle_false_per_min": round(veh_fp / veh_min, 2) if veh_min else None, "vehicle_min": round(veh_min, 1)}


def bilateral_filter(segs, dets, same_ms=150, alt=(250, 1000)):
    """Keep a heel strike on one foot only if the other foot alternates with it.

    Vehicle vibration hits both feet at the same moment; walking heel strikes alternate about half a stride apart.
    A detection is kept if the other foot has no detection within +-same_ms and has one 0.25-1.0 s before or after.
    Where the other insole is not streaming, the detection is kept unchanged (single-foot fallback).
    """
    out = []
    for i, (s, det) in enumerate(zip(segs, dets)):
        others = [(o, d) for o, d in zip(segs, dets) if o is not s and o["day"] == s["day"]
                  and o["session"] == s["session"] and o["side"] != s["side"]]
        if not others or not len(det):
            out.append(det)
            continue
        od = np.concatenate([d for _, d in others]) if others else np.array([])
        cover = [(o["t"][0], o["t"][-1]) for o, _ in others]
        keep = []
        for x in det:
            if not any(a <= x <= b for a, b in cover):
                keep.append(True)  # other foot not recording: cannot check
                continue
            dd = np.abs(od - x) if len(od) else np.array([1e9])
            keep.append(bool(dd.min() > same_ms and ((dd >= alt[0]) & (dd <= alt[1])).any()))
        out.append(det[np.array(keep, bool)])
    return out


def tune_baseline(segs):
    best = None
    for h in np.arange(2, 40, 2):
        f = score(segs, [detect_peaks(s, h) for s in segs])
        val = f["f1"] - 0.002 * (f["vehicle_false_per_min"] or 0)  # also penalise steps counted in vehicles
        if best is None or val > best[0]:
            best = (val, h)
    return best[1]


def run(subject_dir, rebuild=False):
    D = Days(subject_dir, clean=False)
    out = Path(subject_dir).resolve() / "ml" / "A_gait"
    out.mkdir(parents=True, exist_ok=True)
    cache = out / "stream_segments.pkl"
    if cache.exists() and not rebuild:
        data = pickle.loads(cache.read_bytes())
    else:
        data = build(D)
        cache.write_bytes(pickle.dumps(data))
    res = {"segments": len(data), "impacts": int(sum(len(s["impacts"]) for s in data)),
           "vehicle_min": round(sum(len(s["t"]) for s in data if s["kind"] == "vehicle") / FS / 60, 1),
           "lodo": [], "cross_foot": []}
    folds = [(f"test day {n}", [s for s in data if s["day"] != n], [s for s in data if s["day"] == n]) for n in D.n]
    folds_x = [("train left, test right", [s for s in data if s["side"] == "L"], [s for s in data if s["side"] == "R"]),
               ("train right, test left", [s for s in data if s["side"] == "R"], [s for s in data if s["side"] == "L"])]
    all_det = {"tcn": [], "peak": [], "segs": []}
    for kind, fl in (("lodo", folds), ("cross_foot", folds_x)):
        for name, tr, te in fl:
            h = tune_baseline(tr)
            m = HeelStrikeTCN().fit(tr)
            dt = [detect_tcn(m, s) for s in te]
            dp = [detect_peaks(s, h) for s in te]
            r = {"name": name, "baseline_threshold": float(h), "tcn": score(te, dt), "peak": score(te, dp),
                 "params": m.n_params()}
            res[kind].append(r)
            if kind == "lodo":
                all_det["tcn"] += dt
                all_det["peak"] += dp
                all_det["segs"] += te
            print(f"{kind:10s} {name:24s} TCN F1 {r['tcn']['f1']:.3f} (P {r['tcn']['precision']:.3f} R {r['tcn']['recall']:.3f}, "
                  f"timing {r['tcn']['timing_bias_ms']}+-{r['tcn']['timing_sd_ms']} ms, vehicle {r['tcn']['vehicle_false_per_min']}/min)"
                  f" | peaks(h={h:.0f}) F1 {r['peak']['f1']:.3f} (P {r['peak']['precision']:.3f} R {r['peak']['recall']:.3f}, "
                  f"vehicle {r['peak']['vehicle_false_per_min']}/min)", flush=True)
    res["lodo_pooled"] = {k: score(all_det["segs"], all_det[k]) for k in ("tcn", "peak")}
    # two-foot alternation check (needs both insoles; uses the test day's own detections only)
    res["lodo_pooled_bilateral"] = {k: score(all_det["segs"], bilateral_filter(all_det["segs"], all_det[k]))
                                    for k in ("tcn", "peak")}
    pickle.dump(all_det, open(out / "heelstrike_lodo_detections.pkl", "wb"))
    for side in ("R", "L"):
        idx = [i for i, s in enumerate(all_det["segs"]) if s["side"] == side]
        res[f"lodo_pooled_{side}"] = {k: score([all_det["segs"][i] for i in idx], [all_det[k][i] for i in idx])
                                      for k in ("tcn", "peak")}
    (out / "heelstrike_results.json").write_text(json.dumps(res, indent=1, default=str))
    print(json.dumps({k: v for k, v in res.items() if k.startswith("lodo_pooled")}, indent=1))
    return res


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "..", "--rebuild" in sys.argv)
