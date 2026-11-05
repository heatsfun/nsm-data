# nsm-data

Snapshot of New School Mode (higher.fun `feeMode: rewards`) coins for https://newschoolmode.com.

- `coins.json`: up to 36 New School coins sorted by Higher trust grade (A..F, none), then market cap. Always includes $NSM.
- `modes.json`: mint -> `rewards` | `classic` cache (a coin's mode never changes, so each mint is looked up once).
- Rebuilt every 5 minutes by GitHub Actions (`.github/workflows/build.yml`), committed when coins change or the snapshot is older than 30 minutes.

Data URL: https://raw.githubusercontent.com/heatsfun/nsm-data/main/coins.json

Not financial advice. Data from api.higher.fun.
