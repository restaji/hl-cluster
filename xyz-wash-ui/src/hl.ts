const INFO = "/api/hl-info";

export async function hl<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  let delay = 800;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return res.json() as Promise<T>;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 4) {
      throw new Error(
        res.status === 429
          ? "Hyperliquid rate-limited this request"
          : `Hyperliquid ${res.status}`,
      );
    }
    await sleep(delay, signal);
    delay = Math.min(delay * 2, 8000);
  }
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

export async function mapPool<T, R>(
  items: T[],
  n: number,
  fn: (item: T, i: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

type UniverseItem = {
  name: string;
  maxLeverage: number;
  isDelisted?: boolean;
  growthMode?: string;
};

type AssetCtx = {
  openInterest: string;
  markPx: string;
  dayNtlVlm: string;
  funding: string;
};

export async function fetchMarkets(signal?: AbortSignal) {
  type Meta = { universe: UniverseItem[] };
  const [meta, ctxs] = await hl<[Meta, AssetCtx[]]>(
    { type: "metaAndAssetCtxs", dex: "xyz" },
    signal,
  );
  return meta.universe.flatMap((u, i) => {
    if (u.isDelisted) return [];
    const c = ctxs[i];
    const oi = Number(c.openInterest) * Number(c.markPx);
    const vlm = Number(c.dayNtlVlm);
    return [
      {
        coin: u.name.replace(/^xyz:/, ""),
        name: u.name,
        oi,
        vlm,
        ratio: oi > 0 ? vlm / oi : 0,
        lev: u.maxLeverage,
        fund: Number(c.funding) * 100,
        growth: u.growthMode === "enabled",
      },
    ];
  });
}

export type RawTrade = {
  coin: string;
  px: string;
  sz: string;
  time: number;
  users?: string[];
};

export async function fetchRecentTrades(coin: string, signal?: AbortSignal) {
  return hl<RawTrade[]>({ type: "recentTrades", coin }, signal);
}

type RoleRes = { role?: string; data?: { master?: string } };

/** Full role. `subAccounts` still has to be called separately: a master also has role "user". */
export async function fetchRole(user: string, signal?: AbortSignal) {
  const r = await hl<RoleRes>({ type: "userRole", user }, signal);
  const master = r.data?.master?.toLowerCase();
  return {
    role: r.role ?? "user",
    root: r.role === "subAccount" && master ? master : user.toLowerCase(),
  };
}

export async function fetchUserRole(user: string, signal?: AbortSignal) {
  return (await fetchRole(user, signal)).root;
}

export type RawPosition = {
  coin: string;
  szi: string;
  entryPx: string | null;
  positionValue: string;
  unrealizedPnl: string;
  maxLeverage: number;
  leverage?: { type?: string; value?: number };
};

type ChState = {
  marginSummary?: { accountValue?: string };
  assetPositions?: { position: RawPosition }[];
};

export async function fetchState(user: string, signal?: AbortSignal) {
  const r = await hl<ChState>(
    { type: "clearinghouseState", user, dex: "xyz" }, signal);
  return {
    av: Number(r.marginSummary?.accountValue ?? 0),
    positions: (r.assetPositions ?? []).map((p) => p.position),
  };
}

/** Account mode. Response is a plain string or a typed object, depending on mode. */
export async function fetchAbstraction(user: string, signal?: AbortSignal) {
  const r = await hl<unknown>({ type: "userAbstraction", user }, signal);
  if (typeof r === "string") return r;
  const t = (r as { type?: string } | null)?.type;
  return t ?? "default";
}

type SubRow = { subAccountUser?: string };

export async function fetchSubAccounts(master: string, signal?: AbortSignal) {
  const rows = await hl<SubRow[] | null>({ type: "subAccounts", user: master }, signal);
  const members = new Set<string>([master.toLowerCase()]);
  for (const s of rows ?? []) {
    const a = s.subAccountUser?.toLowerCase();
    if (a) members.add(a);
  }
  return [...members];
}

type DayVlm = { userCross: string; userAdd: string };

export async function fetchUserFees(user: string, signal?: AbortSignal) {
  const r = await hl<{
    dailyUserVlm?: DayVlm[];
    userAddRate?: string | number;
  }>({ type: "userFees", user }, signal);
  let taker = 0;
  let maker = 0;
  for (const d of r.dailyUserVlm ?? []) {
    taker += Number(d.userCross);
    maker += Number(d.userAdd);
  }
  const tot = taker + maker;
  return {
    vol15: tot,
    makerPct: tot > 0 ? Math.round((maker / tot) * 100) : 0,
    addBps: Number(r.userAddRate ?? 0) * 1e4,
  };
}
