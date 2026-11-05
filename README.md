# nsm-data

Snapshot of New School Mode (higher.fun `feeMode: rewards`) coins for https://newschoolmode.com.

- `board.json`: all A-grade New School coins (newest first), then the top 100 non-A coins by market cap. Grades are re-read every run (never cached).
- `coins.json`: same order capped at 36 coins (legacy, for older site versions).
- `modes.json`: mint -> `rewards` | `classic` cache (a coin's mode never changes, so each mint is looked up once).
- Rebuilt every 5 minutes by GitHub Actions (`.github/workflows/build.yml`), committed when coins change or the snapshot is older than 30 minutes.

Data URL: https://raw.githubusercontent.com/heatsfun/nsm-data/main/coins.json

Not financial advice. Data from api.higher.fun.
