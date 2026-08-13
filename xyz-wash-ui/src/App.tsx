import { useEffect, useMemo, useState } from "react";
import { fmtTime, HL_WALLET, shortAddr, usdM, usdShort, vol15Label } from "./constants";
import type { Cluster, Lookup, Market } from "./types";
import { useTape } from "./useTape";

type Tab = "markets" | "clusters" | "hits" | "pairs";
type MktMetric = "vlm" | "ratio";

const TABS: { id: Tab; label: string }[] = [
  { id: "markets", label: "Markets" },
  { id: "clusters", label: "Clusters" },
  { id: "hits", label: "Hits" },
  { id: "pairs", label: "Pairs" },
];

function Addr({ address, dim = false }: { address: string; dim?: boolean }) {
  return (
    <a
      className={`addr${dim ? " dim" : ""}`}
      href={HL_WALLET(address)}
      target="_blank"
      rel="noreferrer"
      title={address}
      onClick={(e) => e.stopPropagation()}
    >
      {shortAddr(address)}
    </a>
  );
}

function HBar({
  items,
  color,
  format,
  active,
  onPick,
}: {
  items: { id: string; label: string; value: number }[];
  color: string;
  format: (v: number) => string;
  active?: string | null;
  onPick?: (id: string) => void;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  if (items.length === 0) return null;
  return (
    <div className="hbar">
      {items.map((i) => (
        <button
          type="button"
          className={`hbar-row${active === i.id ? " on" : ""}`}
          key={i.id}
          onClick={() => onPick?.(i.id)}
        >
          <span className="hbar-lab">{i.label}</span>
          <span className="hbar-track">
            <span
              className="hbar-fill"
              style={{ width: `${(i.value / max) * 100}%`, background: color }}
            />
          </span>
          <span className="hbar-val">{format(i.value)}</span>
        </button>
      ))}
    </div>
  );
}

function matchesQ(q: string, ...addrs: string[]) {
  if (!q) return true;
  const n = q.toLowerCase();
  return addrs.some((a) => a.toLowerCase().includes(n));
}

function useSort<T>(rows: T[]) {
  const [key, setKey] = useState<string | null>(null);
  const [dir, setDir] = useState<1 | -1>(-1);
  const sorted = useMemo(() => {
    if (!key) return rows;
    return [...rows].sort((a, b) => {
      const av = (a as Record<string, unknown>)[key];
      const bv = (b as Record<string, unknown>)[key];
      if (typeof av === "number" && typeof bv === "number") {
        const an = Number.isFinite(av) ? av : 0;
        const bn = Number.isFinite(bv) ? bv : 0;
        return (an - bn) * dir;
      }
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }, [rows, key, dir]);
  const toggle = (k: string) => {
    if (key === k) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setKey(k);
      setDir(-1);
    }
  };
  const mark = (k: string) => (key === k ? (dir === -1 ? " ↓" : " ↑") : "");
  return { sorted, toggle, mark };
}

function Th({
  k,
  label,
  num,
  toggle,
  mark,
}: {
  k: string;
  label: string;
  num?: boolean;
  toggle: (k: string) => void;
  mark: (k: string) => string;
}) {
  return (
    <th className={num ? "num" : undefined}>
      <button type="button" className="th-btn" onClick={() => toggle(k)}>
        {label}
        {mark(k)}
      </button>
    </th>
  );
}

function dash(n: number, fmt: (v: number) => string) {
  return n ? fmt(n) : "—";
}

function Empty({ cols, children }: { cols: number; children: string }) {
  return (
    <tr className="empty">
      <td colSpan={cols}>{children}</td>
    </tr>
  );
}

function posCaption(data: Lookup) {
  const n = data.positions.length;
  const longN = data.positions.filter((p) => p.long).reduce((s, p) => s + p.ntl, 0);
  const shortN = data.positions.filter((p) => !p.long).reduce((s, p) => s + p.ntl, 0);
  const book =
    n && (longN || shortN)
      ? ` · ${usdShort(longN)} long / ${usdShort(shortN)} short`
      : "";
  if (!data.isCluster) {
    return n
      ? `Positions of ${shortAddr(data.addr)} — ${n} markets${book}`
      : `Positions of ${shortAddr(data.addr)}`;
  }
  const holders = new Set(data.positions.map((p) => p.addr)).size;
  return n
    ? `Cluster positions — ${n} across ${holders} address${holders === 1 ? "" : "es"}${book}`
    : "Cluster positions";
}

export default function App() {
  const {
    data, progress, error, busy, loadAll, loadFees,
    lookup, lookupError, clearLookup,
  } = useTape();
  const [tab, setTab] = useState<Tab>("clusters");
  const [q, setQ] = useState("");
  const [mkt, setMkt] = useState<MktMetric>("vlm");
  const [pickedMkt, setPickedMkt] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const qTrim = q.trim();
  const qFullAddr = /^0x[a-fA-F0-9]{40}$/.test(qTrim);

  const go = () => void loadAll(qFullAddr ? qTrim : undefined);

  useEffect(() => {
    if (!data.clusters.length) return;
    setPicked((cur) => {
      if (cur && data.clusters.some((c) => c.root === cur)) return cur;
      return (data.clusters.find((c) => c.intra > 0) ?? data.clusters[0]).root;
    });
  }, [data.clusters]);

  useEffect(() => {
    if (!picked) return;
    const c = data.clusters.find((x) => x.root === picked);
    if (c && c.vol15 == null) void loadFees(picked);
  }, [picked, data.clusters, loadFees]);

  const clusters = useMemo(
    () =>
      data.clusters.filter((c) =>
        matchesQ(qTrim, c.root, ...c.members, ...c.onTape),
      ),
    [data.clusters, qTrim],
  );
  const recip = useMemo(
    () => data.recip.filter((r) => matchesQ(qTrim, r.a, r.b)),
    [data.recip, qTrim],
  );
  const hits = useMemo(
    () => data.hits.filter((h) => matchesQ(qTrim, h.buyer, h.seller, h.root)),
    [data.hits, qTrim],
  );

  const clusterSort = useSort(clusters);
  const mktSort = useSort(data.markets);
  const recipSort = useSort(recip);

  const topVol = [...data.markets].sort((a, b) => b.vlm - a.vlm).slice(0, 15);
  const churn = [...data.markets]
    .filter((m) => m.vlm >= 10e6 && m.oi > 0)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 8);

  const selected: Cluster | null =
    data.clusters.find((c) => c.root === picked) ?? null;
  const onTape = new Set((selected?.onTape ?? []).map((a) => a.toLowerCase()));

  const holders = lookup
    ? new Set(lookup.positions.map((p) => p.addr)).size
    : 0;
  const title = lookup
    ? lookup.ntl
      ? `${usdShort(lookup.ntl)} open across ${holders || lookup.clusterSize} address${(holders || lookup.clusterSize) === 1 ? "" : "es"}`
      : "No xyz positions on this cluster"
      : !data.fills
      ? busy
        ? progress === "Positions"
          ? "Loading open positions"
          : "Loading the xyz tape"
        : "Paste an address, then Refresh"
      : data.hits.length === 0
        ? "No declared-cluster wash on this tape"
        : "Almost no wash through declared sub-accounts";

  const when = data.fetchedAt
    ? new Date(data.fetchedAt).toLocaleString()
    : progress;

  return (
    <div className={`page${lookup ? " is-lookup" : ""}`}>
      <header className="top">
        <div className="top-l">
          <p className="eyebrow">trade.xyz on Hyperliquid · live</p>
          <h1>{title}</h1>
        </div>
        <div className="search-row">
          <input
            className="search"
            value={q}
            onChange={(e) => {
              const v = e.target.value;
              setQ(v);
              if (/^0x[a-fA-F0-9]{40}$/.test(v.trim())) void loadAll(v.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") go();
              if (e.key === "Escape") {
                setQ("");
                clearLookup();
              }
            }}
            placeholder="Paste 0x…"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn"
            onClick={go}
            title="Load positions, cluster, and tape"
          >
            {busy ? progress : "Refresh"}
          </button>
        </div>
      </header>

      {!lookup && (
        <section className="stats">
          <div className="stat">
            <div className={`stat-v${data.hits.length ? " warn" : ""}`}>
              {data.fills ? data.hits.length : "—"}
            </div>
            <div className="stat-l">Intra-cluster</div>
          </div>
          <div className="stat">
            <div className="stat-v ok">{data.fills ? data.selfMatch : "—"}</div>
            <div className="stat-l">Self-match</div>
          </div>
          <div className="stat">
            <div className="stat-v">{dash(data.oi, usdShort)}</div>
            <div className="stat-l">Open interest</div>
          </div>
          <div className="stat">
            <div className="stat-v">{dash(data.vlm, usdShort)}</div>
            <div className="stat-l">Volume 24h</div>
          </div>
        </section>
      )}

      {error && (
        <div className="banner">
          <p>
            {error}. Open interest and 24h volume are xyz-wide, not this
            wallet — Refresh to retry the tape. Positions above stay live.
          </p>
        </div>
      )}
      {lookupError && (
        <div className="banner">
          <p>{lookupError}</p>
        </div>
      )}

      {lookup && (
        <LookupCard data={lookup} fills={data.fills} onClose={clearLookup} />
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "tab on" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "markets" && (
        <section className="body">
          <div className="toolbar">
            <button
              type="button"
              className={mkt === "vlm" ? "pill on" : "pill"}
              onClick={() => setMkt("vlm")}
            >
              Vol 24h
            </button>
            <button
              type="button"
              className={mkt === "ratio" ? "pill on" : "pill"}
              onClick={() => setMkt("ratio")}
            >
              Vol ÷ OI
            </button>
          </div>
          {mkt === "vlm" ? (
            <HBar
              items={topVol.map((row) => ({
                id: row.coin,
                label: row.coin,
                value: row.vlm / 1e6,
              }))}
              color="#3d3a8a"
              format={(v) => `$${v.toFixed(0)}M`}
              active={pickedMkt}
              onPick={setPickedMkt}
            />
          ) : (
            <HBar
              items={churn.map((row) => ({
                id: row.coin,
                label: row.coin,
                value: row.ratio,
              }))}
              color="#9a5b12"
              format={(v) => `${v.toFixed(2)}x`}
              active={pickedMkt}
              onPick={setPickedMkt}
            />
          )}
          <p className="cap">
            {mkt === "vlm" ? "Notional USD · 24h" : "Turnover vs open interest · vol ≥ $10M"}
          </p>
          <MarketTable
            rows={mktSort.sorted}
            picked={pickedMkt}
            onPick={setPickedMkt}
            toggle={mktSort.toggle}
            mark={mktSort.mark}
          />
        </section>
      )}

      {tab === "clusters" && (
        <section className="split">
          <div className="split-main">
            <HBar
              items={data.clusters.slice(0, 8).map((c) => ({
                id: c.root,
                label: shortAddr(c.root).slice(0, 10),
                value: c.tape,
              }))}
              color="#3d3a8a"
              format={(v) => String(v)}
              active={picked}
              onPick={setPicked}
            />
            <p className="cap">Fills on tape · click row for members</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <Th k="root" label="Root" toggle={clusterSort.toggle} mark={clusterSort.mark} />
                    <Th k="size" label="N" num toggle={clusterSort.toggle} mark={clusterSort.mark} />
                    <Th k="tape" label="Tape" num toggle={clusterSort.toggle} mark={clusterSort.mark} />
                    <Th k="intra" label="Intra" num toggle={clusterSort.toggle} mark={clusterSort.mark} />
                    <Th k="share" label="Share" num toggle={clusterSort.toggle} mark={clusterSort.mark} />
                    <Th k="ntl" label="Ntl" num toggle={clusterSort.toggle} mark={clusterSort.mark} />
                    <Th k="vol15" label="15d" num toggle={clusterSort.toggle} mark={clusterSort.mark} />
                    <Th k="makerPct" label="Maker" num toggle={clusterSort.toggle} mark={clusterSort.mark} />
                    <Th k="addBps" label="Add" num toggle={clusterSort.toggle} mark={clusterSort.mark} />
                  </tr>
                </thead>
                <tbody>
                  {clusterSort.sorted.length === 0 && (
                    <Empty cols={9}>
                      {qTrim
                        ? "This address is not in the loaded clusters — Refresh to scan it"
                        : busy
                          ? "Loading tape…"
                          : "Paste an address, then Refresh"}
                    </Empty>
                  )}
                  {clusterSort.sorted.map((c) => (
                    <tr
                      key={c.root}
                      className={[
                        picked === c.root ? "on" : "",
                        c.intra > 0 ? "row-warn" : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined}
                      onClick={() => setPicked(c.root)}
                    >
                      <td>
                        <Addr address={c.root} />
                      </td>
                      <td className="num">{c.size}</td>
                      <td className="num">{c.tape}</td>
                      <td className="num">{c.intra}</td>
                      <td className="num">{c.share.toFixed(1)}%</td>
                      <td className="num">{usdShort(c.ntl)}</td>
                      <td className="num">{vol15Label(c.vol15)}</td>
                      <td className="num">{c.makerPct == null ? "—" : `${c.makerPct}%`}</td>
                      <td className="num">
                        {c.addBps == null
                          ? "—"
                          : `${c.addBps >= 0 ? "+" : ""}${c.addBps.toFixed(2)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {selected && (
            <aside className="panel">
              <div className="panel-h">
                <Addr address={selected.root} />
                <span className="panel-meta">
                  {selected.size} · {selected.onTape.length} on tape
                </span>
              </div>
              <div className="members">
                {selected.members.map((m) => (
                  <Addr key={m} address={m} dim={!onTape.has(m.toLowerCase())} />
                ))}
              </div>
            </aside>
          )}
        </section>
      )}

      {tab === "hits" && (
        <section className="body">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Mkt</th>
                  <th className="num">Ntl</th>
                  <th className="num">Px</th>
                  <th className="num">Sz</th>
                  <th>Buyer</th>
                  <th>Seller</th>
                  <th>Cluster</th>
                </tr>
              </thead>
              <tbody>
                {hits.length === 0 && (
                  <Empty cols={8}>
                    {qTrim
                      ? "No intra-cluster fills for this address on the loaded tape"
                      : busy
                        ? "Loading tape…"
                        : "Paste an address, then Refresh"}
                  </Empty>
                )}
                {hits.map((h) => (
                  <tr key={`${h.coin}-${h.time}-${h.buyer}`} className="row-warn">
                    <td>{fmtTime(h.time)}</td>
                    <td>{h.coin}</td>
                    <td className="num">{usdShort(h.ntl)}</td>
                    <td className="num">{h.px}</td>
                    <td className="num">{h.sz}</td>
                    <td>
                      <Addr address={h.buyer} />
                    </td>
                    <td>
                      <Addr address={h.seller} />
                    </td>
                    <td>
                      <Addr address={h.root} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "pairs" && (
        <section className="body">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <Th k="a" label="A" toggle={recipSort.toggle} mark={recipSort.mark} />
                  <Th k="b" label="B" toggle={recipSort.toggle} mark={recipSort.mark} />
                  <Th k="n" label="N" num toggle={recipSort.toggle} mark={recipSort.mark} />
                  <Th k="bal" label="Bal" num toggle={recipSort.toggle} mark={recipSort.mark} />
                  <Th k="ntl" label="Ntl" num toggle={recipSort.toggle} mark={recipSort.mark} />
                  <th>Markets</th>
                </tr>
              </thead>
              <tbody>
                {recipSort.sorted.length === 0 && (
                  <Empty cols={6}>
                    {qTrim
                      ? "This address does not appear in any reciprocal pair"
                      : busy
                        ? "Loading tape…"
                        : "Paste an address, then Refresh"}
                  </Empty>
                )}
                {recipSort.sorted.map((r) => (
                  <tr key={`${r.a}-${r.b}`}>
                    <td>
                      <Addr address={r.a} />
                    </td>
                    <td>
                      <Addr address={r.b} />
                    </td>
                    <td className="num">{r.n}</td>
                    <td className="num">{r.bal.toFixed(2)}</td>
                    <td className="num">{usdShort(r.ntl)}</td>
                    <td>{r.coins.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer>
        {data.fills
          ? `${data.fills} fills · ${data.markets.length} mkts · ${data.resolved} clustered · ${when}`
          : progress}
        {" · "}
        api.hyperliquid.xyz
      </footer>
    </div>
  );
}

function LookupCard({
  data,
  fills,
  onClose,
}: {
  data: Lookup;
  fills: number;
  onClose: () => void;
}) {
  const verdict = data.intra > 0
    ? `${data.intra} intra-cluster fill${data.intra === 1 ? "" : "s"} — wash confirmed`
    : data.tapeTouch > 0
      ? "Zero intra-cluster fills on this tape"
      : "Not active on the current tape";

  return (
    <section className="lookup">
      <div className="lookup-h">
        <div>
          <p className="eyebrow">
            {data.role === "subAccount" ? "Sub-account" : "Standalone account"} · {data.mode} mode
            {data.isCluster
              ? ` · cluster of ${data.clusterSize} address${data.clusterSize === 1 ? "" : "es"}`
              : " · no sub-accounts"}
            {data.truncated ? " · first 40 queried" : ""}
          </p>
          <h2>
            <Addr address={data.addr} />
            {data.root !== data.addr && (
              <>
                {" → master "}
                <Addr address={data.root} />
              </>
            )}
          </h2>
        </div>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="stats tight">
        <div className="stat">
          <div className={`stat-v ${data.intra > 0 ? "warn" : "ok"}`}>{data.intra}</div>
          <div className="stat-l">Intra-cluster</div>
        </div>
        <div className="stat">
          <div className="stat-v">{data.tapeTouch}</div>
          <div className="stat-l">Fills on tape</div>
        </div>
        <div className="stat">
          <div className="stat-v">{dash(data.ntl, usdShort)}</div>
          <div className="stat-l">xyz notional</div>
        </div>
        <div className="stat">
          <div className="stat-v">{vol15Label(data.vol15)}</div>
          <div className="stat-l">15d volume</div>
        </div>
        <div className="stat">
          <div className="stat-v">
            {data.makerPct == null ? "—" : `${data.makerPct}%`}
          </div>
          <div className="stat-l">Maker share</div>
        </div>
      </div>

      <p className="cap">
        {verdict}
        {fills
          ? ` · scored against ${fills} loaded fills`
          : " · tape not loaded yet, positions still live"}
        {" · xyz notional is the cluster book"}
        {" · volume and fees are read at the master"}
        {data.truncated
          ? ` · cluster has ${data.clusterSize} addresses, positions shown for ${data.members.length}`
          : ""}
      </p>

      <div>
        <p className="cap strong">{posCaption(data)}</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {data.isCluster && <th>Address</th>}
                <th>Market</th>
                <th>Side</th>
                <th className="num">Notional</th>
                <th className="num">Entry</th>
                <th className="num">uPnL</th>
                <th className="num">Lev</th>
              </tr>
            </thead>
            <tbody>
              {data.positions.length === 0 ? (
                <Empty cols={data.isCluster ? 7 : 6}>
                  No xyz positions in this cluster
                </Empty>
              ) : (
                data.positions.map((p) => (
                  <tr
                    key={`${p.addr}-${p.coin}`}
                    className={p.addr === data.addr ? "on" : undefined}
                  >
                    {data.isCluster && (
                      <td>
                        <Addr address={p.addr} />
                      </td>
                    )}
                    <td>{p.coin}</td>
                    <td className={p.long ? "side-long" : "side-short"}>
                      {p.long ? "Long" : "Short"}
                    </td>
                    <td className="num">{usdShort(p.ntl)}</td>
                    <td className="num">{p.entry}</td>
                    <td className={`num ${p.upnl >= 0 ? "pnl-up" : "pnl-dn"}`}>
                      {p.upnl >= 0 ? "+" : "−"}
                      {usdShort(Math.abs(p.upnl))}
                    </td>
                    <td className="num">{p.lev}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="lookup-grid">
        <div>
          <p className="cap strong">Cluster members</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Address</th>
                  <th className="num">Equity</th>
                  <th className="num">Notional</th>
                  <th className="num">Pos</th>
                  <th className="num">Tape</th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((m) => (
                  <tr key={m.addr} className={m.self ? "on" : undefined}>
                    <td>
                      <Addr address={m.addr} dim={!m.self && m.pos === 0} />
                    </td>
                    <td className="num">{dash(m.av, usdShort)}</td>
                    <td className="num">{dash(m.ntl, usdShort)}</td>
                    <td className="num">{m.pos || "—"}</td>
                    <td className="num">{m.tape || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <p className="cap strong">Top counterparties</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Address</th>
                  <th className="num">Fill</th>
                  <th className="num">Notional</th>
                </tr>
              </thead>
              <tbody>
                {data.counterparties.length === 0 ? (
                  <Empty cols={3}>No counterparties on the loaded tape</Empty>
                ) : (
                  data.counterparties.map((c) => (
                    <tr key={c.addr}>
                      <td>
                        <Addr address={c.addr} />
                      </td>
                      <td className="num">{c.n}</td>
                      <td className="num">{usdShort(c.ntl)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {data.intraRows.length > 0 && (
        <div>
          <p className="cap strong">Intra-cluster fills</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Mkt</th>
                  <th className="num">Ntl</th>
                  <th>Buyer</th>
                  <th>Seller</th>
                </tr>
              </thead>
              <tbody>
                {data.intraRows.map((h) => (
                  <tr key={`${h.coin}-${h.time}-${h.buyer}`} className="row-warn">
                    <td>{fmtTime(h.time)}</td>
                    <td>{h.coin}</td>
                    <td className="num">{usdShort(h.ntl)}</td>
                    <td>
                      <Addr address={h.buyer} />
                    </td>
                    <td>
                      <Addr address={h.seller} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function MarketTable({
  rows,
  picked,
  onPick,
  toggle,
  mark,
}: {
  rows: Market[];
  picked: string | null;
  onPick: (c: string) => void;
  toggle: (k: string) => void;
  mark: (k: string) => string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <Th k="coin" label="Market" toggle={toggle} mark={mark} />
            <Th k="oi" label="OI" num toggle={toggle} mark={mark} />
            <Th k="vlm" label="Vol" num toggle={toggle} mark={mark} />
            <Th k="ratio" label="Vol/OI" num toggle={toggle} mark={mark} />
            <Th k="lev" label="Lev" num toggle={toggle} mark={mark} />
            <Th k="fund" label="Fund 1h" num toggle={toggle} mark={mark} />
            <th>Fee</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr
              key={m.coin}
              className={picked === m.coin ? "on" : !m.growth ? "row-warn" : undefined}
              onClick={() => onPick(m.coin)}
            >
              <td>{m.coin}</td>
              <td className="num">{usdM(m.oi)}</td>
              <td className="num">{usdM(m.vlm)}</td>
              <td className="num">{m.ratio.toFixed(2)}x</td>
              <td className="num">{m.lev}x</td>
              <td className="num">
                {m.fund >= 0 ? "+" : ""}
                {m.fund.toFixed(4)}%
              </td>
              <td>{m.growth ? "growth" : "full"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
