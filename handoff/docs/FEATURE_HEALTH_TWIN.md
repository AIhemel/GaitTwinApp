# Feature spec: health-twin analysis, alerts, reminders and daily report

Status: proposal, written 2026-10-21 from the thesis data (Hemel days 1–8, Spriha days 1–4).
Thresholds live in [`../config/thresholds.json`](../config/thresholds.json). The Python reference
implementation of every measure is in [`../reference/pipeline/`](../reference/pipeline/).

## 1. What the feature does

The app stops being only a recorder. It analyses the streams on the phone and does three things:

1. **Alerts.** It notifies when something leaves the safe or usual range: heart rate high at rest, uneven gait, a
   polluted or stuffy environment, a poor posture held too long, or low water intake.
2. **Reminders.** It nudges before things go wrong: no drink for 2.5 h, sitting for 50 min, falling behind on water.
3. **Daily health-twin report.** It shows a smartwatch-style summary of the day across body, movement, environment,
   hydration, posture and sleep, against the person's own baseline.

## 2. Design principles (learned from the data)

| Principle | Why (evidence from the recordings) |
|---|---|
| **Personal baseline first, population limits second.** | Sleeping HR is 62 bpm for one participant and 71 for the other, each with SD 1–2 bpm. One fixed threshold would be wrong for one of them. Spriha's left foot always rotates more, which is her normal, not an anomaly. |
| **Use context to decide which rules apply.** | HR of 130 bpm is normal while walking and abnormal while sitting. PM2.5 of 80 is a normal Dhaka street but unusual in a bedroom. The activity and place models decide which rule set is active. |
| **Require a condition to persist, then apply a cooldown.** | Single-minute spikes are common (a CO₂ breath spike to 560 ppm, sound spikes to 86 dBA). Rules fire only after the condition holds for a set duration, and the same alert type cannot repeat within 60 min. |
| **Avoid alert fatigue.** | Dhaka PM2.5 was above the WHO guideline 100 % of the time. That belongs in the daily report, not in a notification every hour. |
| **Clean the data before applying rules.** | Before any rule runs: drop HR minutes affected by optical cadence lock, flag the environment node's 30-min warm-up, and disable pressure measures from faulty or replaced FSRs. |
| **Don't make claims the data didn't support.** | Do not say "drink before walking to lower your HR". That was tested and not supported. Insights describe what happened, not what caused it. |
| **Every alert is a measurement.** | Log the trigger values and the user's response (useful / not useful / wrong). That is the thesis evaluation and the way to tune thresholds. |

## 3. Architecture (on the phone)

```
BLE streams ──► Ingest + clock sync ──► Windowing ──► Feature extractors ──► Minute table (DB)
 (insoles L/R,      (device_ms → utc,     1 s / 10 s /     gait: strides, IMU toe-off,         │
  env node,          seq numbers,          per stride /     stance/swing/push-off/tilt, SI     │
  cushion,           loss & delay log)     1 min            env: rolling means, AQI, Leq      ▼
  bottle,                                                   hydration: plateaus → drinks  Context engine
  band via HC,                                              posture: bouts                (activity GBM +
  GPS)                                                      HR: cadence-lock filter        place LR + taps)
                                                                                                │
                                   Baseline store ◄──────── nightly update (median/MAD, 14 d) ◄─┤
                                         │                                                      ▼
                                         └──────────────────► Rule engine (thresholds.json) ──► Notification manager
                                                                                                (severity, cooldown,
                                                                                                 quiet hours, log)
                                                                         Daily summary job (on wake + 23:59)
                                                                                    │
                                                                                    ▼
                                                                         Report UI (Today / Timeline / domains / trends)
```

* **Where it runs.** Feature extraction and rules run on the phone in a foreground service. The models are small:
  activity GBM 3.2 MB / 8 ms per call, place logistic regression 4 kB, heel-strike TCN 32 k parameters ≈ 2 ms
  (see `reference/ml/deploy.json`).
* **Reference implementation.** The Python reference is `reference/pipeline/daily_analysis.py`:
  * `detect_strides`
  * IMU toe-off (`stance_imu_pct`)
  * `bottle_plateaus`
  * `analyze_bottle`
  * the cadence-lock flag
  * sensor health

  Port these to the app language, or run Python on the phone (e.g. Chaquopy) for a first version.
* **Storage.** Use a local DB with these tables:
  * `minute_summary` (one row per minute: hr, steps, context, env means, posture, water, gait stats per foot, quality flags)
  * `strides` (per foot)
  * `events` (user taps + detected)
  * `alerts` (trigger, values, severity, delivered_at, user_response)
  * `baselines` (per user × measure × context)
  * `daily_summary`
* **Clocks.** Every rule uses `utc_ms`. Gait symmetry from **each foot's own strides** needs no inter-insole sync.
  Step timing between the feet (`step_phase_pct`) does need synced clocks, so enable it only when sync quality is
  good (see APP_FIXES §1).

## 4. Alert catalogue

| ID | Domain | Trigger (summary; exact values in thresholds.json) | Severity | Message (example) | Actions |
|---|---|---|---|---|---|
| HR-1 | Heart | HR ≥ 120 for 10 min while inactive (not walking or in a vehicle), cadence-lock minutes removed | warning | "Your heart rate has been 124 bpm for 10 min while sitting." | OK / I was active / Snooze |
| HR-2 | Heart | HR ≥ 150 for 10 min while inactive | urgent | "Heart rate 152 bpm at rest for 10 min. If you feel unwell, seek help." | OK / Call contact |
| HR-3 | Heart | HR < 40 for 10 min awake | warning | "Heart rate unusually low (38 bpm)." | OK |
| HR-4 | Heart | Sitting HR robust z > 4 for 15 min | nudge | "Heart rate higher than your usual for sitting (112 vs ~100)." | OK / Why? |
| HR-5 | Heart | Mean sleeping HR > baseline + 5 bpm | info (morning card) | "Sleeping heart rate 69 bpm, 6 above your usual. Often seen with stress, illness, heat or alcohol." | — |
| GA-1 | Gait | Symmetry index (stance %, swing, push-off, tilt range or stride) beyond personal median ± max(floor, 4 MAD) in 2 consecutive 60-stride windows | nudge, then warning if it repeats in 3 walks | "Your steps are uneven: right stance 6 % longer than left (usual: 1 %)." | Show me / Ignore / Shoe issue |
| GA-2 | Gait | Possible slip: impact robust z ≥ 6 with forefoot-first contact | nudge | "Did you slip or stumble at 19:21?" | Yes / No |
| GA-3 | Gait | Stride-time variability (CV) above personal z 4 over a walk | info | "Your walking rhythm was less regular today." | — |
| EN-1 | Environment | PM2.5 5-min mean ≥ 150 µg/m³ | warning | "Very high particles (PM2.5 380). Move away or ventilate." | OK / Mask on |
| EN-2 | Environment | PM2.5 5-min mean ≥ 250 µg/m³ | urgent | "Hazardous air (PM2.5 716)." | OK |
| EN-3 | Environment | CO₂ 10-min mean ≥ 1000 / ≥ 1500 ppm | nudge / warning | "Stuffy room: CO₂ 1,050 ppm. Open a window or door." | Done / Snooze |
| EN-4 | Environment | Noise Leq15 ≥ 70 dBA (info); Leq30 ≥ 85 dBA (warning) | info / warning | "Loud for 30 min (87 dBA). Consider ear protection." | OK |
| EN-5 | Environment | Heat index ≥ 32 / ≥ 39 °C (only after node warm-up and calibration) | nudge / warning | "Hot and humid (heat index 34 °C). Drink water." | Log a drink |
| EN-6 | Environment | Variable robust z > 4 vs the same place class | info | "Unusual for your bedroom: PM2.5 160 (usual ~70)." | — |
| HY-1 | Hydration | 2.5 h awake with no drink | nudge (reminder) | "No water for 2 h 30 min." | Log a drink / Snooze |
| HY-2 | Hydration | Below 60 % of the expected pace for the time of day | nudge | "You're at 0.5 L of 1.6 L by 15:00." | Log a drink |
| HY-3 | Hydration | Daily target reached | info | "Daily water goal reached." | — |
| PO-1 | Posture | Poor posture held for 20 min | nudge | "Slouching for 20 min. Sit back and straighten up." | Done / Snooze |
| PO-2 | Posture | Seated for 50 min | nudge (reminder) | "Seated 50 min. Stand and move for 2–3 min." | Done / Snooze |
| SL-1 | Sleep | Sleep < 6 h | info (morning card) | "5 h 23 min of sleep." | — |
| DQ-1 | Data | Stream silent ≥ 2 min, rate < 80 %, FSR fault, band off 30 min | info (status bar; push only during a session) | "Left insole disconnected 3 min ago." | Reconnect |

Rules for message text:
* Always include the **measured value** and the **usual value**.
* Give one **concrete action**.
* Use no diagnostic language.
* Urgent HR alerts include a "seek help if unwell" line.

## 5. Reminders

* **Hydration.**
  * A gap reminder (HY-1) and a pace check (HY-2) run every 60 min while awake.
  * After a logged or detected drink, the gap timer resets.
  * When heat index ≥ 32 °C, the daily target increases by 0.5 L. This is a heuristic and is labelled as one in the UI.
* **Movement.** The sitting reminder (PO-2) uses the posture cushion when connected, otherwise band steps (< 50 steps in 50 min).
* **Scheduled.** Optional user-set reminders: water at fixed times, an evening "log your day" check.
* Reminders pause while asleep and while the user is walking or riding.

## 6. Daily health-twin report (main UI)

Reference look: the mockup [`../mockups/daily_report.html`](../mockups/daily_report.html), built from Hemel's real day 7.
Open it in a browser at phone width. Brand apps (Fitbit, Garmin, Samsung Health, Apple Health) show a stack of cards,
each with one headline number, a small chart and a status chip. Do the same, with one twist: each status compares to
**the person's own usual range**, not a population norm.

### Screens

1. **Today** (home):
   * header: date, data-coverage bar (which sensors recorded and for how long)
   * six domain cards, each with a status chip (Usual / Above usual / Below usual / Alert):
     * **Heart**: resting and sleeping HR vs baseline, time above 120 at rest, sparkline
     * **Movement & gait**: steps, walking minutes, cadence, a symmetry gauge (L vs R), events (slip)
     * **Environment**: AQI exposure bar (minutes per category), peak events, CO₂ and noise minutes over limits
     * **Hydration**: litres vs target with a progress ring, longest gap, drinks timeline
     * **Posture**: minutes monitored, % upright, longest sitting bout
     * **Sleep**: duration, stages, sleeping HR, bedroom PM2.5 and noise
   * **Insights** (2–3 plain sentences generated from rules, e.g. "Your heart rate was highest in the lab
     (median 104 bpm) and lowest on your evening walk (93)".)
   * **Alerts today** (list, tap → detail)
2. **Timeline**: a 24-hour ribbon of context (sleep, indoor, walk, rickshaw, metro, …), with HR, PM2.5 and steps
   stacked under it and event pins (drinks, alerts, user taps). This is the "twin" view: one day as one picture.
3. **Domain detail** (one per card): the full chart, the 7- and 30-day trend against the baseline band, and an
   explanation of the measure.
4. **Gait detail**:
   * L/R comparison bars for stance %, swing, push-off and tilt range, with the symmetry index and the personal
     usual band
   * per-walk list
   * stride-time distribution, with a body-size-normalised view
5. **Trends**: weekly view of each headline measure, with personal baseline bands.
6. **Alerts inbox**: every alert with its values, plus "useful / not useful / wrong" feedback.
7. **Data quality**: sensor uptime, disconnections, warm-up periods, faulty FSRs, band wear time.

### Scoring: use transparent statuses rather than one opaque score

Brand apps give one "readiness" or "health" score. With two participants and no outcome data, a combined score cannot
be validated. Show per-domain **status chips** based on the personal baseline instead. If a single number is wanted
for the thesis, define it explicitly: for example, the % of domains in the usual range, with the formula shown on tap.

## 7. Build order

1. **Data reliability** (APP_FIXES §1–4): synced clocks, live status, tap events, robust session files. Without these,
   the alerts are built on gaps.
2. **Minute table on the phone** plus the **Today** and **Timeline** screens. Port the pipeline functions, then check
   against the Python outputs on the sample data (`sample_data/`).
3. **Absolute alerts** (HR-1/2/3, EN-1–5, HY-1/2, PO-1/2, DQ-1) with the notification policy.
4. **Personal baselines** and the personal alerts (HR-4/5, GA-1, EN-6).
5. **Context models** (activity, place) gating the rules. Slip prompt GA-2.
6. **Evaluation**, reported in the thesis:
   * alert precision from user feedback
   * false alarms per day
   * time from event to notification
   * battery use over 24 h

## 8. Open questions for the build

* App stack and language. The session files show `appVersion 0.0.1` and Android Health Connect, so most likely
  Android. Confirm Kotlin, Flutter or React Native.
* Does any processing move to the node firmware? For example, impact detection on the insole would save Bluetooth
  bandwidth.
* Notification channel and wording language (English and/or Bangla).
* Where daily summaries are stored or exported for the thesis (CSV per day, same layout as `analysis_output/`).
