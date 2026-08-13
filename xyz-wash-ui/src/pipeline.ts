import {
  fetchMarkets,
  fetchRecentTrades,
  fetchSubAccounts,
  fetchUserRole,
  mapPool,
  sleep,
  type RawTrade,
} from "./hl";
import type { Cluster, Hit, Market, Recip, Trade } from "./types";

const ROLE_KEY = "xyz-tape-roles-v1";
const SUB_KEY = "xyz-tape-subs-v1";

type Cache<T> = Record<string, { v: T; at: number }>;
const DAY = 24 * 60 * 60 * 1000;

function loadCache<T>(key: string): Cache<T> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Cache<T>;
  } catch {
    return {};
  }
}

function saveCache<T>(key: string, c: Cache<T>) {
  localStorage.setItem(key, JSON.stringify(c));
}

function fresh<T>(c: Cache<T>, k: string): T | undefined {
  const hit = c[k];
  if (!hit || Date.now() - hit.at > DAY) return undefined;
  return hit.v;
}

export type TapeData = {
  markets: Market[];
  trades: Trade[];
  oi: number;
  vlm: number;
  fills: number;
  selfMatch: number;
  resolved: number;
  clusters: Cluster[];
  recip: Recip[];
  hits: Hit[];
  fetchedAt: number;
};

export type Progress = (msg: string) => void;

function toTrade(t: RawTrade): Trade | null {
  const users = t.users;
  if (!users || users.length < 2) return null;
  return {
    coin: t.coin.replace(/^xyz:/, ""),
    px: t.px,
    sz: t.sz,
    time: t.time,
    users: [users[0].toLowerCase(), users[1].toLowerCase()],
  };
}

function ntl(t: Trade) {
  return Number(t.px) * Number(t.sz);
}

function reciprocity(trades: Trade[], min = 4): Recip[] {
  const directed = new Map<string, number>();
  const notional = new Map<string, number>();
  const coins = new Map<string, Set<string>>();
  const pair = (a: string, b: string) => `${a}|${b}`;
  const und = (a: string, b: string) => (a < b ? pair(a, b) : pair(b, a));

  for (const t of trades) {
    const [b, s] = t.users;
    directed.set(pair(b, s), (directed.get(pair(b, s)) ?? 0) + 1);
    const u = und(b, s);
    notional.set(u, (notional.get(u) ?? 0) + ntl(t));
    if (!coins.has(u)) coins.set(u, new Set());
    coins.get(u)!.add(t.coin);
  }

  const out: Recip[] = [];
  const seen = new Set<string>();
  for (const [k, nAb] of directed) {
    const [a, b] = k.split("|");
    if (a >= b) continue;
    const nBa = directed.get(pair(b, a)) ?? 0;
    const n = nAb + nBa;
    if (n < min) continue;
    const u = und(a, b);
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({
      a,
      b,
      n,
      bal: 1 - Math.abs(nAb - nBa) / n,
      ntl: notional.get(u) ?? 0,
      coins: [...(coins.get(u) ?? [])],
    });
  }
  return out.sort((x, y) => y.bal * y.ntl - x.bal * x.ntl);
}

function summarize(
  trades: Trade[],
  rootOf: (a: string) => string,
  membersOf: Map<string, Set<string>>,
): { clusters: Cluster[]; hits: Hit[]; resolved: number } {
  const hits: Hit[] = [];
  let resolved = 0;
  const tapeN = new Map<string, number>();
  const tapeNtl = new Map<string, number>();
  const onTape = new Map<string, Set<string>>();

  for (const t of trades) {
    const [b, s] = t.users;
    const rb = rootOf(b);
    const rs = rootOf(s);
    if (rb === rs) {
      hits.push({
        time: t.time,
        coin: t.coin,
        ntl: ntl(t),
        px: t.px,
        sz: t.sz,
        buyer: b,
        seller: s,
        root: rb,
      });
    }
    const known = membersOf.has(rb) || membersOf.has(rs) || rb !== b || rs !== s;
    if (known) resolved += 1;
    for (const [addr, r] of [
      [b, rb],
      [s, rs],
    ] as const) {
      tapeN.set(r, (tapeN.get(r) ?? 0) + 1);
      tapeNtl.set(r, (tapeNtl.get(r) ?? 0) + ntl(t));
      if (!onTape.has(r)) onTape.set(r, new Set());
      onTape.get(r)!.add(addr);
    }
  }

  const intraN = new Map<string, number>();
  for (const h of hits) intraN.set(h.root, (intraN.get(h.root) ?? 0) + 1);

  const clusters: Cluster[] = [];
  for (const [root, tape] of tapeN) {
    const members = [...(membersOf.get(root) ?? [root])];
    const intra = intraN.get(root) ?? 0;
    clusters.push({
      root,
      size: members.length,
      tape,
      intra,
      share: tape ? (intra / tape) * 100 : 0,
      ntl: tapeNtl.get(root) ?? 0,
      onTape: [...(onTape.get(root) ?? [])],
      members,
      vol15: null,
      makerPct: null,
      addBps: null,
    });
  }
  clusters.sort((a, b) => b.tape - a.tape);
  return { clusters, hits, resolved };
}

export async function loadTape(
  onProgress: Progress,
  signal?: AbortSignal,
  onMarkets?: (snap: { markets: Market[]; oi: number; vlm: number }) => void,
): Promise<TapeData> {
  onProgress("Markets");
  const markets = await fetchMarkets(signal);
  const oi = markets.reduce((s, m) => s + m.oi, 0);
  const vlm = markets.reduce((s, m) => s + m.vlm, 0);
  onMarkets?.({ markets, oi, vlm });

  onProgress(`Tape 0/${markets.length}`);
  let done = 0;
  const batches = await mapPool(
    markets,
    3,
    async (m) => {
      const raw = await fetchRecentTrades(m.name, signal);
      done += 1;
      onProgress(`Tape ${done}/${markets.length}`);
      return raw;
    },
    signal,
  );

  const trades: Trade[] = [];
  let selfMatch = 0;
  for (const raw of batches) {
    for (const t of raw) {
      const tr = toTrade(t);
      if (!tr) continue;
      if (tr.users[0] === tr.users[1]) selfMatch += 1;
      trades.push(tr);
    }
  }

  const freq = new Map<string, number>();
  for (const t of trades) {
    freq.set(t.users[0], (freq.get(t.users[0]) ?? 0) + 1);
    freq.set(t.users[1], (freq.get(t.users[1]) ?? 0) + 1);
  }
  const recip = reciprocity(trades);
  const priority: string[] = [];
  const seen = new Set<string>();
  const add = (a: string) => {
    const x = a.toLowerCase();
    if (!seen.has(x)) {
      seen.add(x);
      priority.push(x);
    }
  };
  for (const r of recip) {
    add(r.a);
    add(r.b);
  }
  for (const [a] of [...freq.entries()].sort((x, y) => y[1] - x[1]).slice(0, 50)) {
    add(a);
  }

  const roleCache = loadCache<string>(ROLE_KEY);
  const subCache = loadCache<string[]>(SUB_KEY);
  const root = new Map<string, string>();
  const members = new Map<string, Set<string>>();
  const expanded = new Set<string>();

  async function expand(master: string) {
    const m = master.toLowerCase();
    if (expanded.has(m)) return;
    expanded.add(m);
    let list = fresh(subCache, m);
    if (!list) {
      await sleep(800, signal);
      list = await fetchSubAccounts(m, signal);
      subCache[m] = { v: list, at: Date.now() };
      saveCache(SUB_KEY, subCache);
    }
    if (!members.has(m)) members.set(m, new Set([m]));
    root.set(m, m);
    for (const a of list) {
      root.set(a, m);
      members.get(m)!.add(a);
    }
  }

  let i = 0;
  for (const addr of priority) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (root.has(addr)) {
      i += 1;
      continue;
    }
    const cached = fresh(roleCache, addr);
    let master: string;
    if (cached) {
      master = cached;
    } else {
      onProgress(`Clusters ${i + 1}/${priority.length}`);
      await sleep(3100, signal);
      master = await fetchUserRole(addr, signal);
      roleCache[addr] = { v: master, at: Date.now() };
      saveCache(ROLE_KEY, roleCache);
    }
    root.set(addr, master);
    if (!members.has(master)) members.set(master, new Set([master]));
    members.get(master)!.add(addr);
    await expand(master);
    i += 1;
    onProgress(`Clusters ${i}/${priority.length}`);
  }

  const rootOf = (a: string) => root.get(a) ?? a;
  const { clusters, hits, resolved } = summarize(trades, rootOf, members);

  return {
    markets,
    trades,
    oi,
    vlm,
    fills: trades.length,
    selfMatch,
    resolved,
    clusters: clusters.filter((c) => c.size > 1 || c.tape >= 8).slice(0, 20),
    recip: recip.slice(0, 16),
    hits,
    fetchedAt: Date.now(),
  };
}
