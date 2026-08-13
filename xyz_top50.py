#!/usr/bin/env python3
"""Reconstruct a trade.xyz trader ranking from the public Hyperliquid API.

hl.eco/xyz-leaderboard ranks every account by volume, fees, OI, and realized
PnL, but that data only comes out through SSE gated by Cloudflare Turnstile. Those
figures come from an indexer on top of node fills, not from the public API.

What can be reproduced from the public API exactly and truly scoped to `xyz`
is only **open-position notional**, via `clearinghouseState(dex="xyz")`. Per-address
volume is not available per-dex: `recentTrades` only gives the last 10 fills per
market, and `userFees` is exchange-wide and aggregated across the whole cluster.
So this script ranks by open notional, and labels the volume column as what it is:
a cross-exchange cluster figure.

The hard problem is enumeration: no endpoint lists position holders.
Candidates are gathered from the Hyperliquid leaderboard and the tape, then expanded
via `subAccounts` — a necessary step because sub-accounts never appear on the
leaderboard even when they hold large positions.

    python3 xyz_top50.py                    # full scan (~22 min)
    python3 xyz_top50.py --from-cache       # re-render, no network
    python3 xyz_top50.py --lb-sample 500    # faster, lower coverage
    python3 xyz_top50.py --no-expand        # skip sub-account expansion
    python3 xyz_top50.py --top 100          # longer ranking

Stdlib only. Borrows the rate limiter and format helpers from regen.py.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import regen as R

OUT = R.Path(__file__).with_name("xyz-top50.md")
CACHE = R.Path(__file__).with_name("xyz-top50.json")
DEX = R.DEX

# How many top leaderboard addresses (by accountValue) to use as seeds.
LB_SAMPLE = 3000

# Clusters are only resolved for the top N: `userRole` is weight 60, far more
# expensive than other requests, so it is not worth running on every candidate.
ROLE_DEPTH = 80

# Sub-account expansion is limited to the N largest position holders. Masters of
# large clusters almost always get caught in the leaderboard seed because their
# accountValue is aggregated, so expanding a thin tail adds many requests without
# adding much notional.
EXPAND_DEPTH = 500


def log(msg: str) -> None:
    print(f"  {msg}", file=sys.stderr, flush=True)


def mult(v: float) -> str:
    """A ratio below 1 rounds to `0x` at zero decimals, which reads as missing data."""
    return f"{v:.0f}x" if v >= 10 else f"{v:.1f}x"


# --------------------------------------------------------------------------- fetch

def state(addr: str) -> dict | None:
    """`xyz` positions for one address. None if it has no positions or the call failed."""
    try:
        r = R.info({"type": "clearinghouseState", "user": addr, "dex": DEX}, retries=2)
    except RuntimeError:
        return None
    positions = r.get("assetPositions") or []
    if not positions:
        return None

    ntl = lng = sht = 0.0
    upnl = 0.0
    coins: list[tuple[str, float]] = []
    for p in positions:
        pos = p["position"]
        v = abs(float(pos["positionValue"]))
        ntl += v
        upnl += float(pos.get("unrealizedPnl") or 0)
        if float(pos["szi"]) > 0:
            lng += v
        else:
            sht += v
        coins.append((pos["coin"].removeprefix(f"{DEX}:"), v))
    if ntl <= 0:
        return None

    coins.sort(key=lambda c: -c[1])
    return {
        "addr": addr, "ntl": ntl, "npos": len(positions), "long": lng, "short": sht,
        "upnl": upnl, "top_coin": coins[0][0],
        "conc": coins[0][1] / ntl,
    }


def subs_of(addr: str) -> list[str]:
    try:
        r = R.info({"type": "subAccounts", "user": addr}, retries=2) or []
    except RuntimeError:
        return []
    return [s["subAccountUser"].lower() for s in r if s.get("subAccountUser")]


def master_of(addr: str) -> str | None:
    """Master of a sub-account, if this address actually is a sub-account."""
    try:
        r = R.info({"type": "userRole", "user": addr}, retries=2) or {}
    except RuntimeError:
        return None
    if r.get("role") != "subAccount":
        return None
    m = (r.get("data") or {}).get("master")
    return m.lower() if m else None


def fees_of(addr: str) -> dict:
    """Volume and maker share from `userFees`. Exchange-wide and cluster-aggregated."""
    try:
        r = R.info({"type": "userFees", "user": addr}, retries=2) or {}
    except RuntimeError:
        return {"vlm": 0.0, "maker": None, "days": 0}
    daily = r.get("dailyUserVlm") or []
    cross = sum(float(d["userCross"]) for d in daily)
    add = sum(float(d["userAdd"]) for d in daily)
    total = cross + add
    return {
        "vlm": total,
        "maker": (add / total) if total > 0 else None,
        "days": len(daily),
    }


# ----------------------------------------------------------------------- pipeline

def seeds(lb_sample: int) -> tuple[list[str], dict]:
    """Initial candidates: top of the leaderboard by accountValue, plus addresses on the tape."""
    log("fetching xyz tape…")
    tape_addrs = sorted({u.lower() for t in R.tape() for u in t["users"]})

    log("fetching Hyperliquid leaderboard…")
    lb = sorted(R.leaderboard(), key=lambda r: -float(r["accountValue"]))
    lb_top = [r["ethAddress"].lower() for r in lb[:lb_sample]]

    cand = list(dict.fromkeys(tape_addrs + lb_top))
    return cand, {"tape": len(tape_addrs), "lb_top": len(lb_top), "lb_size": len(lb)}


def scan(addrs: list[str], label: str, workers: int = 8) -> list[dict]:
    log(f"scan {label}: {len(addrs):,} addresses (~{len(addrs) * 2 / 1100:.1f} min)")
    t0 = time.time()
    res = [r for r in R.pmap(state, addrs, workers=workers) if r]
    log(f"  -> {len(res):,} position holders in {time.time() - t0:.0f}s")
    return res


def expand(holders: list[dict], seen: set[str], depth: int) -> list[str]:
    """Sub-accounts of each position holder. These never appear on the leaderboard."""
    owners = [h["addr"] for h in sorted(holders, key=lambda h: -h["ntl"])[:depth]]
    log(f"expanding sub-accounts from {len(owners):,} position holders "
        f"(~{len(owners) * 20 / 1100:.1f} min)")
    lists = R.pmap(subs_of, owners, workers=8)
    new = [a for lst in lists for a in lst if a not in seen]
    new = list(dict.fromkeys(new))
    log(f"  -> {len(new):,} new sub-accounts found")
    return new


def clusters(rank: list[dict]) -> dict[str, str]:
    """Map address -> master. Only for the top of the ranking; `userRole` is expensive."""
    targets = [r["addr"] for r in rank[:ROLE_DEPTH]]
    log(f"resolving clusters for top {len(targets)} (~{len(targets) * 60 / 1100:.1f} min)")
    masters = R.pmap(master_of, targets, workers=6)
    return {a: (m or a) for a, m in zip(targets, masters)}


# ------------------------------------------------------------------------- report

def build(args) -> dict:
    cand, meta = seeds(args.lb_sample)
    seen = set(cand)
    holders = scan(cand, "seed")

    if not args.no_expand:
        new = expand(holders, seen, args.expand_depth)
        if new:
            seen |= set(new)
            extra = scan(new, "sub-account")
            holders += extra
            meta["expanded"] = len(new)
            meta["from_subs"] = len(extra)
            meta["sub_ntl"] = sum(h["ntl"] for h in extra)

    # Dedup: one address can enter via seed and via expansion.
    uniq: dict[str, dict] = {}
    for h in holders:
        uniq[h["addr"]] = h
    rank = sorted(uniq.values(), key=lambda h: -h["ntl"])

    cmap = clusters(rank) if not args.no_roles else {}
    for r in rank[:ROLE_DEPTH]:
        r["master"] = cmap.get(r["addr"], r["addr"])

    top = rank[:args.top]
    log(f"fetching volume for top {len(top)}…")
    for r, f in zip(top, R.pmap(fees_of, [r["addr"] for r in top], workers=6)):
        r["fees"] = f
        r["churn"] = f["vlm"] / r["ntl"] if f["vlm"] else 0.0

    for r in rank:
        ls = r["long"] + r["short"]
        r["bias"] = (r["long"] - r["short"]) / ls if ls else 0.0

    rs = R.rows()
    oi_one_side = sum(r["oi"] for r in rs)
    captured = sum(h["ntl"] for h in rank)

    return {
        "meta": meta,
        "rank": rank,
        "top": top,
        "markets": len(rs),
        "oi_one_side": oi_one_side,
        "ground_truth": oi_one_side * 2,
        "captured": captured,
        "pct": 100 * captured / (oi_one_side * 2) if oi_one_side else 0.0,
        "top_share": 100 * sum(h["ntl"] for h in top) / captured if captured else 0.0,
        "scanned": len(seen),
    }


def render(d: dict) -> str:
    m = d["meta"]
    L = [
        f"# Top {len(d['top'])} trade.xyz position holders",
        "",
        R.wrap(
            f"Reconstructed from the public Hyperliquid API on {R.now_utc():%Y-%m-%d %H:%M} UTC "
            f"by `xyz_top50.py`. Ranked by **open-position notional on dex `{DEX}`** — the only "
            "per-address quantity that is truly scoped to xyz and verifiable from a public "
            "endpoint."),
        "",
        "## What can and cannot be reproduced",
        "",
        R.wrap(
            "hl.eco ranks on volume, fees, OI, and realized PnL for *every* account. Three of "
            "those four columns have no public-API counterpart. `recentTrades` only returns "
            "the **last 10 fills per market**, and `userFees` is exchange-wide and aggregated "
            "across the whole cluster, so it cannot be sliced per-dex. hl.eco figures come from "
            "an indexer on top of node fills, not from this API."),
        "",
        R.wrap(
            "Consequence: the volume column below is **not xyz volume**: it is the whole "
            "cluster's volume across all of Hyperliquid. Kept because it is still informative "
            "for a churn ratio, but do not read it as an xyz volume ranking."),
        "",
        "## Coverage",
        "",
        R.wrap(
            f"`openInterest` is counted one-sided, so total notional of all users = 2 x sum(OI x "
            f"mark). For {d['markets']} `{DEX}` markets that is 2 x {R.usd(d['oi_one_side'])} = "
            f"**{R.usd(d['ground_truth'])}**."),
        "",
        "| | |",
        "| --- | ---: |",
        f"| Addresses scanned | {R.num(d['scanned'])} |",
        f"| Position holders found | {R.num(len(d['rank']))} |",
        f"| Notional captured | {R.usd(d['captured'])} |",
        f"| **Coverage of the market** | **{R.pct(d['pct'])}** |",
        f"| Top {len(d['top'])} share of what was captured | {R.pct(d['top_share'])} |",
        "",
    ]

    if m.get("expanded"):
        L += [R.wrap(
            f"Sub-account expansion contributed {R.num(m['from_subs'])} position holders from "
            f"{R.num(m['expanded'])} addresses found via `subAccounts`, carrying "
            f"{R.usd(m.get('sub_ntl', 0))} notional. **None of those addresses are on the "
            "Hyperliquid leaderboard** — without this step they disappear from the ranking "
            "entirely."), ""]

    L += [
        "## Ranking",
        "",
        "| # | Address | Notional | Pos | Long/Short | Bias | Concentration | Top market | "
        "Cluster volume | Churn | Maker |",
        "| --: | --- | --: | --: | --- | --: | --: | --- | --: | --: | --: |",
    ]

    for i, r in enumerate(d["top"], 1):
        f = r.get("fees") or {}
        vlm = R.usd(f["vlm"]) if f.get("vlm") else "—"
        maker = f"{100 * f['maker']:.0f}%" if f.get("maker") is not None else "—"
        churn = mult(r["churn"]) if r.get("churn") else "—"
        sub = " ·s" if r.get("master") and r["master"] != r["addr"] else ""
        L.append(
            f"| {i} | `{r['addr'][:10]}…{r['addr'][-4:]}`{sub} | {R.usd(r['ntl'])} | "
            f"{r['npos']} | {R.usd(r['long'])} / {R.usd(r['short'])} | {r['bias']:+.2f} | "
            f"{100 * r['conc']:.0f}% | {r['top_coin']} | {vlm} | {churn} | {maker} |")

    L += [
        "",
        R.wrap(
            "`·s` marks an address whose `userRole` returns `subAccount` — the position belongs "
            "to a cluster, not an independent trader. **Bias** is (long − short) ÷ total: a "
            "value near zero is a near-market-neutral book, which is normal for a market maker "
            "but also the shape expected from paired positions across sub-accounts. "
            "**Concentration** is the share of notional in its largest market. **Churn** is "
            "cluster volume ÷ open notional; because the numerator is cross-exchange, the "
            "figure is an upper bound, not xyz churn."),
        "",
    ]
    L += signals(d["top"])
    return "\n".join(L) + "\n"


def signals(top: list[dict]) -> list[str]:
    """Rows whose shape stands out. Not accusations, just candidates to follow up."""
    subs = [r for r in top if r.get("master") and r["master"] != r["addr"]]
    churned = sorted((r for r in top if r.get("churn")), key=lambda r: -r["churn"])[:5]
    neutral = [r for r in top if abs(r["bias"]) <= 0.15]

    L = ["## Shapes that stand out", ""]

    if subs:
        L += [R.wrap(
            f"**{len(subs)} of the top {len(top)} are sub-accounts**, holding "
            f"{R.usd(sum(r['ntl'] for r in subs))} — and none of them appear on the Hyperliquid "
            "leaderboard, which folds their value into the master. Any ranking built from the "
            "leaderboard alone will miss them."), ""]

    if churned:
        L += ["Highest churn (cluster volume ÷ open notional):", "",
              "| Address | Notional | Cluster volume | Churn | Maker | Bias |",
              "| --- | --: | --: | --: | --: | --: |"]
        for r in churned:
            f = r["fees"]
            mk = f"{100 * f['maker']:.0f}%" if f.get("maker") is not None else "—"
            L.append(f"| `{r['addr'][:10]}…{r['addr'][-4:]}` | {R.usd(r['ntl'])} | "
                     f"{R.usd(f['vlm'])} | {mult(r['churn'])} | {mk} | {r['bias']:+.2f} |")
        L.append("")

    if neutral:
        L += [R.wrap(
            f"**{len(neutral)} addresses hold a near-delta-neutral book** (|bias| <= 0.15) "
            "while sitting on large notional. Neutral itself is normal for a market maker; "
            "what is worth following up is neutral **plus** high churn plus counterparties "
            "that repeat inside one cluster — that combination is dissected in "
            "`tradexyz-open-positions.md` §7."), ""]

    return L


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--from-cache", action="store_true",
                   help=f"re-render from {CACHE.name} without touching the network")
    p.add_argument("--lb-sample", type=int, default=LB_SAMPLE,
                   help=f"top leaderboard addresses to use as seeds (default {LB_SAMPLE})")
    p.add_argument("--top", type=int, default=50, help="ranking length (default 50)")
    p.add_argument("--no-expand", action="store_true", help="skip sub-account expansion")
    p.add_argument("--expand-depth", type=int, default=EXPAND_DEPTH,
                   help=f"largest position holders to expand (default {EXPAND_DEPTH})")
    p.add_argument("--no-roles", action="store_true", help="skip cluster resolve (userRole)")
    p.add_argument("--out", default=str(OUT), help="destination markdown file")
    args = p.parse_args()

    t0 = time.time()
    if args.from_cache:
        d = json.loads(CACHE.read_text(encoding="utf-8"))
    else:
        d = build(args)
        CACHE.write_text(json.dumps(d, indent=1), encoding="utf-8")

    R.Path(args.out).write_text(render(d), encoding="utf-8")
    log(f"done in {(time.time() - t0) / 60:.1f} min -> {args.out}")

    print(f"coverage {R.pct(d['pct'])} of {R.usd(d['ground_truth'])}; "
          f"{R.num(len(d['rank']))} position holders; "
          f"top {len(d['top'])} = {R.pct(d['top_share'])} of what was captured")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
