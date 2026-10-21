# Data formats (as exported by app v0.0.1)

Examples of every stream are in `../sample_data/`. All times are Unix epoch milliseconds (UTC). Local time is
Asia/Dhaka (UTC+6).

## Session folder

One folder per recording, containing `session.meta.json` plus one CSV per stream that was active.

`session.meta.json` (abridged):

```json
{
  "fileName": "Day_7 noon",
  "startTime": "2026-10-14T08:35:21.824Z",
  "endTime": "2026-10-14T13:06:13.375Z",
  "appVersion": "0.0.1",
  "nodeBindings": {"GAIT": "<mac>", "GAIT_LEFT": "<mac>", "POSTURE": "<mac>", "HYDRATION": "<mac>", "ENVIRONMENT": "<mac>"},
  "activeInterests": ["POSTURE", "GAIT", "GAIT_LEFT", "ENVIRONMENT"],
  "timeBase": "...",
  "streams": {"gait": "...", "...": "..."},
  "clockSyncAtEnd": {"GAIT": {"offsetMs": 1791982997778, "samples": 16648}, "...": {}}
}
```

`GAIT` is the right insole; `GAIT_LEFT` is the left insole.

## Streams

| File | Columns | Rate | Notes |
|---|---|---|---|
| `gait.csv` | `side,rx_ms,device_ms,utc_ms,Pitch,Roll,Quat_I,Quat_J,Quat_K,Quat_Real,Yaw,Heel_FSR,Met1_FSR,Met5_FSR,Accel_X,Accel_Y,Accel_Z` | ~112 Hz per insole | `side` R/L. FSR 0–4095 (12-bit; left forefoot saturates). Accel in m/s². `utc_ms` = device_ms + ClockSync offset; refit offline from rx_ms/device_ms if needed. |
| `environment.csv` | `rx_ms,device_utc_s,utc_ms,co2_ppm,temp_c,rh_pct,pm1,pm25,pm10,dba,lat,lon` | 1 per 10 s | `utc_ms` = arrival = end of the 10 s averaging window. `temp_c` is raw (self-heating, see APP_FIXES §5). PM ceiling 3333. |
| `posture.csv` | `rx_ms,device_utc_s,utc_ms,utc_source,replayed,pose,pose_name` | on change | A pose is committed after being held 10 s (onset ≈ 10 s earlier). `pose_name` values seen: STRAIGHT, LEAN_FORWARD, LEAN_BACKWARD, LEAN_LEFT, LEAN_RIGHT, SLOUCH (the pipeline relabels Hemel's LEAN_FORWARD as upright). `replayed` = 1 for queued events. |
| `hydration.csv` | `rx_ms,device_ms,utc_ms,offline,Weight_g,Cap_mL,Fused_mL` | ~1 Hz | Fused_mL is the primary channel; Cap_mL == 500 is invalid. |
| `gps.csv` | `utc_ms,lat,lon,accuracy_m,speed_mps,weather_temp_c,weather_rh_pct` | phone GPS | Weather from an online API at the fix. |
| `events.csv` | `rx_ms,node,event,device_ms,utc_ms,detail` | sparse | Session start/stop, connects/disconnects, user notes. |

## Outside the session folders (per day)

* **Wrist band:** a Health Connect export (`Fit_YYYY-MM-DD.csv` + `.meta.json`; mostly Xiaomi Smart Band 10 via
  Gadgetbridge). Long format with many duplicate rows: remove duplicates, and do not sum steps across sources.
  Example: `sample_data/wearable_health_connect_head.csv`.
* **Drinking log:** `hydration_manual.csv` with columns `local_time,volume_ml`. These are the smart bottle's own log,
  typed in by the participant. Call it the "smart-bottle log", never "manual".
* **Analysis config:** `day_config.json` defines sessions, contexts, events and per-day options for the Python
  pipeline. See the two examples in `sample_data/`.

## Analysis outputs (Python pipeline, per day: `analysis_output/`)

* **`minute_table.csv`**: one row per minute. Columns: `hr, steps_band, steps_insole, stride_time_s, stance_pct,
  co2_ppm, temp_c, rh_pct, pm25, pm10, dba, gps_speed_mps, posture, sleep_stage, water_ml, hr_cadence_lock, event,
  session, context`. This is the layout the app's `minute_summary` table should reproduce.
* **`strides_<session>_<side>.csv`**: one row per stride, with IMU and pressure gait events.
* **`daily_metrics.csv` and `summary.json`**: the day's headline numbers. They map onto the daily report cards.
