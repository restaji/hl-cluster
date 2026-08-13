import {
  fetchAbstraction,
  fetchRole,
  fetchState,
  fetchSubAccounts,
  fetchUserFees,
  mapPool,
  type RawPosition,
} from "./hl";
import type { Hit, Lookup, LookupMember, LookupPos, Trade } from "./types";

/** Cap on cluster members queried. Larger clusters are truncated here. */
const MAX_MEMBERS = 40;

function toPos(p: RawPosition, addr: string): LookupPos {
  const szi = Number(p.szi);
  return {
    addr,
    coin: p.coin.replace(/^xyz:/, ""),
    long: szi > 0,
    ntl: Math.abs(Number(p.positionValue)),
    entry: p.entryPx ?? "—",
    upnl: Number(p.unrealizedPnl),
    lev: p.leverage?.value
      ? `${p.leverage.value}x ${p.leverage.type === "isolated" ? "iso" : "cross"}`
      : `${p.maxLeverage}x`,
  };
}

/**
 * Run the detector for a single address, whichever it is.
 *
 * Cluster resolution needs two distinct calls: `userRole` catches the sub-account
 * case, `subAccounts` catches the master — a master itself has role "user", so
 * either call alone is not enough.
 */
export async function lookupAddress(
  addr: string,
  trades: Trade[],
  signal?: AbortSignal,
): Promise<Lookup> {
  const target = addr.toLowerCase();

  const [{ role, root }, mode] = await Promise.all([
    fetchRole(target, signal),
    fetchAbstraction(target, signal).catch(() => "default"),
  ]);

  const subs = await fetchSubAccounts(root, signal).catch(() => [root]);
  const all = [...new Set([root, target, ...subs])];
  const members = all.slice(0, MAX_MEMBERS);
  const inCluster = new Set(members);

  const tapeN = new Map<string, number>();
  for (const t of trades) {
    for (const u of t.users) tapeN.set(u, (tapeN.get(u) ?? 0) + 1);
  }

  const states = await mapPool(
    members,
    3,
    (m) => fetchState(m, signal).catch(() => ({ av: 0, positions: [] })),
    signal,
  );

  const rows: LookupMember[] = members.map((m, i) => ({
    addr: m,
    av: states[i].av,
    ntl: states[i].positions.reduce((s, p) => s + Math.abs(Number(p.positionValue)), 0),
    pos: states[i].positions.length,
    tape: tapeN.get(m) ?? 0,
    self: m === target,
  }));
  rows.sort((a, b) => Number(b.self) - Number(a.self) || b.ntl - a.ntl);

  const own = states[members.indexOf(target)] ?? { av: 0, positions: [] };
  const positions = members
    .flatMap((m, i) => states[i].positions.map((p) => toPos(p, m)))
    .sort((a, b) => b.ntl - a.ntl);

  const fees = await fetchUserFees(root, signal).catch(() => null);

  let tapeTouch = 0;
  const intraRows: Hit[] = [];
  const cp = new Map<string, { n: number; ntl: number }>();
  for (const t of trades) {
    const [b, s] = t.users;
    const hitB = inCluster.has(b);
    const hitS = inCluster.has(s);
    if (!hitB && !hitS) continue;
    tapeTouch += 1;
    const ntl = Number(t.px) * Number(t.sz);
    if (hitB && hitS) {
      intraRows.push({
        time: t.time, coin: t.coin, ntl, px: t.px, sz: t.sz,
        buyer: b, seller: s, root,
      });
      continue;
    }
    const other = hitB ? s : b;
    const prev = cp.get(other) ?? { n: 0, ntl: 0 };
    cp.set(other, { n: prev.n + 1, ntl: prev.ntl + ntl });
  }

  return {
    addr: target,
    role,
    root,
    mode,
    isCluster: members.length > 1,
    clusterSize: all.length,
    truncated: all.length > MAX_MEMBERS,
    members: rows,
    positions,
    av: own.av,
    ntl: rows.reduce((s, m) => s + m.ntl, 0),
    vol15: fees?.vol15 ?? null,
    makerPct: fees?.makerPct ?? null,
    addBps: fees?.addBps ?? null,
    tapeTouch,
    intra: intraRows.length,
    intraRows,
    counterparties: [...cp.entries()]
      .map(([a, v]) => ({ addr: a, ...v }))
      .sort((x, y) => y.n - x.n)
      .slice(0, 8),
  };
}

/** Re-score tape stats after fills arrive, without refetching positions. */
export function attachTape(data: Lookup, trades: Trade[]): Lookup {
  const inCluster = new Set(data.members.map((m) => m.addr));
  const tapeN = new Map<string, number>();
  let tapeTouch = 0;
  const intraRows: Hit[] = [];
  const cp = new Map<string, { n: number; ntl: number }>();

  for (const t of trades) {
    const [b, s] = t.users;
    const hitB = inCluster.has(b);
    const hitS = inCluster.has(s);
    if (hitB) tapeN.set(b, (tapeN.get(b) ?? 0) + 1);
    if (hitS) tapeN.set(s, (tapeN.get(s) ?? 0) + 1);
    if (!hitB && !hitS) continue;
    tapeTouch += 1;
    const ntl = Number(t.px) * Number(t.sz);
    if (hitB && hitS) {
      intraRows.push({
        time: t.time, coin: t.coin, ntl, px: t.px, sz: t.sz,
        buyer: b, seller: s, root: data.root,
      });
      continue;
    }
    const other = hitB ? s : b;
    const prev = cp.get(other) ?? { n: 0, ntl: 0 };
    cp.set(other, { n: prev.n + 1, ntl: prev.ntl + ntl });
  }

  return {
    ...data,
    members: data.members.map((m) => ({ ...m, tape: tapeN.get(m.addr) ?? 0 })),
    tapeTouch,
    intra: intraRows.length,
    intraRows,
    counterparties: [...cp.entries()]
      .map(([a, v]) => ({ addr: a, ...v }))
      .sort((x, y) => y.n - x.n)
      .slice(0, 8),
  };
}
