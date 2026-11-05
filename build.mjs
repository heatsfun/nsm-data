// Builds coins.json: New School Mode (feeMode 'rewards') coins from higher.fun.
// No dependencies. Node 18+ (global fetch).
import { readFile, writeFile } from "node:fs/promises";

const API = "https://api.higher.fun";
const NSM = "FA7ScL6CPYFU5PQeGJrNbYZePCnuEU6tf5T1rezATPLt";
const MAX_COINS = 36;
const NEWEST_SLOTS = 12; // newest New School coins always on the board, whatever their grade
const DELAY_MS = 350; // ~170 req/min max, well under the 300/min limit
const STALE_MS = 30 * 60 * 1000; // rewrite even if unchanged after 30 min
const GRADES = { A: 0, B: 1, C: 2, D: 3, F: 4 };
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; nsm-data/1.0; +https://github.com/heatsfun/nsm-data)",
  Accept: "application/json",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReq = 0;
async function getJson(path, tries = 3) {
  for (let i = 1; ; i++) {
    const wait = lastReq + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    try {
      const res = await fetch(API + path, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 && i < tries) { await sleep(5000 * i); continue; }
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(1000 * i);
    }
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

const toSol = (lamports) => Number(BigInt(lamports ?? "0")) / 1e9;
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

async function main() {
  const modes = await readJson("modes.json", {});
  const prev = await readJson("coins.json", null);

  // 1. Lists (any failure aborts without touching coins.json)
  // sort=new first: its mints get their feeMode looked up first, so fresh launches land in this run
  const byMint = new Map();
  const newMints = [];
  for (const sort of ["new", "trending", "mcap"]) {
    const r = await getJson(`/coins?sort=${sort}&limit=100`);
    if (!Array.isArray(r?.items)) throw new Error(`bad list for ${sort}`);
    for (const c of r.items) {
      if (!c?.mint) continue;
      if (sort === "new") newMints.push(c.mint);
      if (!byMint.has(c.mint)) byMint.set(c.mint, c);
    }
  }
  if (byMint.size === 0) throw new Error("empty lists");

  // 2. SOL price
  const sp = await getJson("/sol-price");
  const solUsd = Number(sp?.usd);
  if (!Number.isFinite(solUsd) || solUsd <= 0) throw new Error("bad sol price");

  // 3. Always include NSM, with fresh detail
  if (!byMint.has(NSM)) {
    const d = await getJson(`/coins/${NSM}`);
    byMint.set(NSM, d);
    if (d.feeMode) modes[NSM] = d.feeMode;
  }

  // 4. feeMode only for unknown mints (cached forever)
  const unknown = [...byMint.keys()].filter((m) => !modes[m]);
  let looked = 0, failed = 0;
  for (const mint of unknown) {
    try {
      const d = await getJson(`/coins/${mint}`, 2);
      if (d?.feeMode === "rewards" || d?.feeMode === "classic") { modes[mint] = d.feeMode; looked++; }
    } catch { failed++; } // retried next run
  }

  // 5. Filter, sort, shape
  const coins = [...byMint.values()]
    .filter((c) => modes[c.mint] === "rewards")
    // Only emit coins the site's strict validator accepts (one bad coin would reject the whole file)
    .filter((c) => typeof c.name === "string" && typeof c.ticker === "string"
      && (c.status === "curve" || c.status === "graduated") && Number.isFinite(Date.parse(c.createdAt))
      && /^\d+$/.test(String(c.marketCap ?? "0")) && /^\d+$/.test(String(c.volume24h ?? "0")))
    .map((c) => {
      const mcSol = toSol(c.marketCap);
      return {
        mint: c.mint, name: c.name, ticker: c.ticker, imageUri: typeof c.imageUri === "string" && c.imageUri ? c.imageUri : null,
        status: c.status, createdAt: c.createdAt, trustGrade: typeof c.trustGrade === "string" ? c.trustGrade : null,
        marketCapSol: round(mcSol, 4), marketCapUsd: round(mcSol * solUsd, 2),
        volume24hUsd: round(toSol(c.volume24h) * solUsd, 2),
        url: `https://higher.fun/coin/${c.mint}`, isNsm: c.mint === NSM,
        _mc: BigInt(c.marketCap ?? "0"),
      };
    })
    .sort((a, b) => {
      const g = (GRADES[a.trustGrade] ?? 5) - (GRADES[b.trustGrade] ?? 5);
      return g !== 0 ? g : a._mc === b._mc ? 0 : a._mc > b._mc ? -1 : 1;
    });
  // Reserve slots: NSM + the newest New School coins, then fill by grade. Final order stays grade-sorted.
  const newest = coins.filter((c) => newMints.includes(c.mint))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, NEWEST_SLOTS);
  const keep = new Set([...coins.filter((c) => c.isNsm), ...newest]);
  for (const c of coins) { if (keep.size >= MAX_COINS) break; keep.add(c); }
  let top = coins.filter((c) => keep.has(c)).map(({ _mc, ...c }) => c);
  if (top.length === 0) throw new Error("no New School coins found; keeping last coins.json");

  // Persist modes (sorted keys for stable diffs)
  const sortedModes = Object.fromEntries(Object.entries(modes).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile("modes.json", JSON.stringify(sortedModes, null, 1) + "\n");

  const changed = !prev || JSON.stringify(prev.coins) !== JSON.stringify(top);
  const stale = !prev || Date.now() - Date.parse(prev.updatedAt) > STALE_MS;
  if (changed || stale) {
    const out = { updatedAt: new Date().toISOString(), solUsd, coins: top };
    await writeFile("coins.json", JSON.stringify(out, null, 1) + "\n");
  }
  console.log(`listed=${byMint.size} lookedUp=${looked} failed=${failed} newSchool=${coins.length} written=${changed || stale} (changed=${changed}, stale=${stale})`);
}

main().catch((e) => { console.error("build failed:", e.message); process.exit(1); });
