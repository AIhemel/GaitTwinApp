# App fixes indicated by the thesis data

Ordered by how much data each problem cost. Each item gives the problem we observed and what to change. The changes
are written to be testable.

## 1. Clock sync and data rate between the two insoles (highest impact)

**Seen:**
* On every one of Spriha's days, one insole streamed at about 60 Hz instead of 112 Hz, with 200–400 ms of Bluetooth
  queueing. As a result, left–right step timing was invalid on every day.
* Hemel's insole clocks reset on reconnect and drifted by 8–21 ppm.
* `ClockSync` already exists (`clockSyncAtEnd` in `session.meta.json`), but it is fitted once per session.

**Change:**
* Send a per-packet sequence number and the node's own `device_ms` with every sample (the timestamp already exists).
  Log any missing sequence numbers.
* Re-estimate the clock offset continuously, for example with a minimum-delay filter over a sliding 60 s window, and
  store the offset and drift in an events row every minute. Re-sync after every reconnect.
* Request a high-priority connection (short connection interval) and a larger MTU, and send several samples per
  notification, so both insoles sustain 112 Hz together.
* Optional: a "hop twice" sync marker button at the start and end of each walk.

**Test:** in a 10-min walk, both feet arrive at ≥ 105 Hz, and the left heel strike falls at 50 ± 3 % of the right
cycle (`step_phase_pct`).

## 2. Live sensor status and dropout alerts

**Seen:**
* The environment node stopped at 08:28 while the session ran until 12:17 (Spriha day 4).
* The node disconnected 10 times in one evening.
* The insoles looped in "reconnecting".
* Posture-cushion dropouts were not noticed until the data was analysed.

**Change:**
* A status bar showing each node's live rate (Hz), the time since its last packet and its battery.
* A notification when a stream is silent for ≥ 2 min, or below 80 % of its expected rate, during a session.
* Automatic reconnect with backoff in a foreground service.

**Test:** switch off a node during a session; an alert appears within 2 min, and reconnect happens automatically when
the node returns.

## 3. One-tap event logging (context labels)

**Seen:**
* Rickshaw rides were never noted; they had to be inferred from foot unloading and vibration.
* Drink times were logged without am/pm.
* One drink time was estimated.
* Whether the AC was on, or the window closed, could only be guessed.

**Change:** a home-screen panel of buttons, each storing `utc_ms` automatically in `events.csv` with `node = APP`:
* start/stop: walk, rickshaw, metro/bus
* point events: drink, meal, AC on/off, fan on/off, window closed/open, cooking, "something interesting"
* an optional voice or text note

**Why:** these taps are the ground-truth labels for the activity and place models, and the evidence behind the
"interesting findings" pages.

## 4. Session files and export

**Seen:**
* `session.meta.json` overwritten by a 1-second restart.
* `endTime` missing.
* Byte-identical duplicate folders (`Day-3 mor` / `Day_3 afternoon`).
* A nested duplicate folder (`Night_3/Night_2`).
* Files uploaded loose, or as `environment (1).csv`.
* A night filed under the wrong day.
* A JSON config saved with a UTF-8 BOM.

**Change:**
* Give each session a UUID. Write the meta file at start, update it atomically (write to a temp file, then rename),
  and write `endTime` on stop, and also on crash recovery at the next app start.
* Name folders `YYYY-MM-DD_HHMM_<label>` (date-based, not day number).
* Export a `manifest.json` with SHA-256 per file, so duplicates are detected on import.
* Write UTF-8 without a BOM.

## 5. Environment node calibration

**Seen:**
* After a cold start, the temperature reads 10–12 °C high within 30 min. The median over 20 recordings was +2.5 °C,
  so a fixed −5 °C correction is wrong.
* The CO₂ sensor reads below outdoor levels (< 420 ppm).
* PM saturates at 3,333.

**Change:**
* Log the node's uptime with each sample. Flag the first 30 min as warm-up.
* Add a calibration screen:
  * a reference thermometer reading, giving a per-node temperature offset
  * a "fresh air" CO₂ calibration
* Store the calibration in the session file.
* Mark readings at the sensor ceiling (PM 3,333; FSR 4,095).

**Hardware note (for the thesis):** move the temperature/RH sensor away from the board's heat sources, or give it
ventilation.

## 6. Sensor information in the session file

**Seen:**
* All three of Spriha's right FSRs were replaced, and Hemel's right Met1 was replaced by a low-range FSR. The pipeline
  only knew because the participants said so.
* The left forefoot FSRs clip at 4,095 in 14–24 % of walking samples, for both participants.

**Change:**
* Store per insole: FSR type and version, replacement date, and a 20-second calibration (stand still on both feet,
  then lift each foot) giving each sensor's unloaded and loaded levels.
* Run the per-minute sensor health check (normal / low range / dropout, from `daily_analysis.py`) live, and warn when
  a sensor fails during a session.

## 7. Wrist band (via Health Connect / Gadgetbridge)

**Seen:**
* Heart rate was recorded every 10 min on Spriha's days 1–2.
* The band was taken off for hours.
* Sleep was only partly recorded.
* The Health Connect export has many duplicate rows, and Google Fit steps are inflated.
* Optical cadence lock occurs while walking.

**Change:**
* At session start, check that HR sampling is set to 1 min.
* Warn after 30 min with no HR while awake.
* Remove duplicates on import, and never sum step sources.
* Apply the cadence-lock flag (|HR − cadence| ≤ 6 bpm for ≥ 2 min) before using HR.

## 8. Participant profile

Store sex, height, mass and, optionally, leg length. Gait comparisons (stride time ÷ √(L/g)) and hydration targets
need them.

## 9. Smaller items

* **Posture cushion:** a per-user "sit upright" calibration. For Hemel, deliberate upright sitting was reported as
  LEAN_FORWARD.
* **GPS:** drop or tag fixes with poor accuracy indoors; indoor fixes scattered over about 60 m.
* **Smart bottle:**
  * sync its log with full timestamps
  * Fused_mL is the primary channel; discard Cap_mL == 500
  * skip plateaus with weight < 2 g (the bottle lifted)
  * time each drink at the lift
