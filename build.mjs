// Builds coins.json: New School Mode (feeMode 'rewards') coins from higher.fun.
// No dependencies. Node 18+ (global fetch).
import { readFile, writeFile } from "node:fs/promises";

const API = "https://api.higher.fun";
const NSM = "FA7ScL6CPYFU5PQeGJrNbYZePCnuEU6tf5T1rezATPLt";
const NON_A_COINS = 40; // top non-A coins by market cap (site shows fewer, sized to fit the board)
const MAX_PAGES = 30; // sort=new pagination safety cap (100 coins per page)
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
  // Paginate sort=new to the end: covers every coin on higher.fun (a few pages today)
  const byMint = new Map();
  let cursor = null, pages = 0;
  do {
    const r = await getJson(`/coins?sort=new&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!Array.isArray(r?.items)) throw new Error("bad list page");
    for (const c of r.items) if (c?.mint && !byMint.has(c.mint)) byMint.set(c.mint, c);
    cursor = r.items.length ? r.nextCursor : null;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  // Grades change over time: never cache trustGrade. Any coin that was an A grader in the last
  // snapshot but is missing from this run's list pages gets its CURRENT detail fetched, so it can
  // drop out of (or stay in) the A section based on today's grade.
  const prevA = ((await readJson("board.json", null))?.coins ?? prev?.coins ?? []).filter((c) => c.trustGrade === "A").map((c) => c.mint);
  let refreshed = 0;
  for (const mint of prevA) {
    if (byMint.has(mint)) continue;
    try { const d = await getJson(`/coins/${mint}`, 2); if (d?.mint) { byMint.set(mint, d); refreshed++; if (d.feeMode) modes[mint] = d.feeMode; } }
    catch { /* keep going; it simply isn't emitted this run */ }
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
  // Selection: every A grader (newest first), then the top non-A coins by market cap. NSM always included.
  const strip = ({ _mc, ...c }) => c;
  const byMc = (a, b) => (a._mc === b._mc ? 0 : a._mc > b._mc ? -1 : 1);
  const aGraders = coins.filter((c) => c.trustGrade === "A")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const rest = coins.filter((c) => c.trustGrade !== "A").sort(byMc);
  const restTop = rest.slice(0, NON_A_COINS);
  const nsm = rest.find((c) => c.isNsm);
  if (nsm && !restTop.includes(nsm)) restTop.push(nsm);
  const top = [...aGraders, ...restTop].map(strip);
  if (top.length === 0) throw new Error("no New School coins found; keeping last coins.json");

  // Persist modes (sorted keys for stable diffs)
  const sortedModes = Object.fromEntries(Object.entries(modes).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile("modes.json", JSON.stringify(sortedModes, null, 1) + "\n");

  // board.json: the full board (all A graders newest first, then top non-A by market cap).
  // coins.json: same order capped at 36 coins, kept for sites still validating "<= 36 coins".
  const now = new Date().toISOString();
  const legacy = top.slice(0, 36);
  const nsmOut = top.find((c) => c.isNsm);
  if (nsmOut && !legacy.some((c) => c.isNsm)) legacy[legacy.length - 1] = nsmOut;
  const prevBoard = await readJson("board.json", null);
  let written = [];
  for (const [file, list, old] of [["board.json", top, prevBoard], ["coins.json", legacy, prev]]) {
    const changed = !old || JSON.stringify(old.coins) !== JSON.stringify(list);
    const stale = !old || Date.now() - Date.parse(old.updatedAt) > STALE_MS;
    if (changed || stale) { await writeFile(file, JSON.stringify({ updatedAt: now, solUsd, coins: list }, null, 1) + "\n"); written.push(file); }
  }
  console.log(`pages=${pages} prevARefreshed=${refreshed} listed=${byMint.size} aGraders=${aGraders.length} emitted=${top.length} lookedUp=${looked} failed=${failed} newSchool=${coins.length} written=${written.join(',') || 'none'}`);
}

main().catch((e) => { console.error("build failed:", e.message); process.exit(1); });
