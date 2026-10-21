# Hand-off: health-twin thesis → app development on Ubuntu

Everything needed to continue the work on another machine, with a new Claude session.

## How to use

1. Copy this folder (or `handoff.zip`) to Ubuntu.
2. Copy `CLAUDE.md` into the root of the **app repository**, and copy `docs/`, `config/`, `mockups/` and
   `sample_data/` into the repository too (for example under `research/`).
3. Start Claude in the app repository and say, for example:
   *"Read CLAUDE.md and docs/APP_FIXES.md, then let's plan step 1 (insole clock sync)."*

## Contents

| Path | What it is |
|---|---|
| `CLAUDE.md` | Project context and standing rules for Claude: study, participants, findings, conventions |
| `docs/APP_FIXES.md` | Data-reliability changes for the recorder app, ordered by impact, each with a test |
| `docs/FEATURE_HEALTH_TWIN.md` | New feature spec: analysis on the phone, alert catalogue, reminders, daily report UI, build order |
| `docs/DATA_FORMATS.md` | The app's current CSV/JSON formats and the analysis outputs |
| `config/thresholds.json` | Alert thresholds: absolute limits, personal-baseline rules, persistence and cooldown; values from the data |
| `mockups/daily_report.html` | Phone mockup of the daily report, built from Hemel's day 7 (open in a browser, narrow the window) |
| `sample_data/` | One trimmed session per participant (gait, environment, posture, bottle, GPS, events, meta), a band export head, day configs |
| `reference/pipeline/` | The Python analysis pipeline: the reference implementation to port or check against |
| `reference/ml/` | Model sizes and latency for the phone (`deploy.json`) and cross-validated results |
| `reference/reports/` | Two-participant comparison, ML report, example daily reports (PDF) |

The raw data for all days stays on Windows in `G:\MY COOL EXPERIMENTS\Thesis_data_collection\`. Copy it separately if
the pipeline needs to run on Ubuntu (`pip install numpy pandas scipy matplotlib scikit-learn torch`; LaTeX: `texlive-full`
for the reports).
