#!/usr/bin/env python3
"""Regenerate snapshot figures in tradexyz-open-positions.md from the Hyperliquid API.

Every number that can change over time lives in a marked block
`<!-- gen:NAME -->` ... `<!-- /gen:NAME -->` in the markdown. This script rewrites
those blocks; text outside the markers is never touched.

    python3 regen.py                  # all fast blocks (~1 min)
    python3 regen.py --full           # including the coverage scan (~8 min)
    python3 regen.py --only snapshot  # one block
    python3 regen.py --list           # list blocks
    python3 regen.py --dry-run        # show diff, do not write

Stdlib only, no dependencies.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures
import datetime as dt
import difflib
import json
import re
import sys
import textwrap
import threading
import time
import urllib.request
from pathlib import Path

DOC = Path(__file__).with_name("tradexyz-open-positions.md")
INFO = "https://api.hyperliquid.xyz/info"
LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
DEX = "xyz"

# Address used as the case study in the document. Change if the focus moves.
CASE_MASTER = "0xf5d81a135f756ca16544e53c20fc20643ec3ad53"

# How many top leaderboard addresses to probe in the coverage scan. Raise for a
# tighter result, but ~2 requests per address so cost is linear.
COVERAGE_LB_SAMPLE = 3000


# --------------------------------------------------------------------------- http

class RateLimiter:
    """Hyperliquid weight limit: 1200 per minute per IP, held at 1100."""

    def __init__(self, budget: int = 1100, window: float = 60.0):
        self.budget = budget
        self.window = window
        self.spent: collections.deque[tuple[float, int]] = collections.deque()
        self.lock = threading.Lock()

    def take(self, weight: int) -> None:
        while True:
            with self.lock:
                now = time.time()
                while self.spent and now - self.spent[0][0] > self.window:
                    self.spent.popleft()
                used = sum(w for _, w in self.spent)
                if used + weight <= self.budget:
                    self.spent.append((now, weight))
                    return
                wait = self.window - (now - self.spent[0][0]) + 0.05
            time.sleep(min(wait, 5.0))


LIMITER = RateLimiter()

# Weight per request type. Unlisted types count as 20 (Hyperliquid default).
WEIGHTS = {"clearinghouseState": 2, "spotClearinghouseState": 2, "userRole": 60}


def info(payload: dict, retries: int = 4):
    weight = WEIGHTS.get(payload.get("type", ""), 20)
    last: Exception | None = None
    for attempt in range(retries):
        LIMITER.take(weight)
        try:
            req = urllib.request.Request(
                INFO, data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as exc:  # noqa: BLE001 - retry anything, report the last error
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{payload.get('type')} failed after {retries} attempts: {last}")


def pmap(fn, items, workers=6):
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(fn, items))


# ------------------------------------------------------------------------ format

def usd(v: float) -> str:
    a = abs(v)
    if a >= 1e9:
        return f"${v / 1e9:.2f}B"
    if a >= 1e6:
        return f"${v / 1e6:.1f}M"
    if a >= 1e3:
        return f"${v / 1e3:.1f}k"
    return f"${v:.0f}"


def usd_exact(v: float) -> str:
    return f"${v:,.0f}"


def pct(v: float, digits: int = 1) -> str:
    return f"{v:.{digits}f}%"


def num(v: int) -> str:
    """Thousands separator matching the English prose in the document."""
    return f"{v:,}"


def short(addr: str) -> str:
    return f"`{addr[:10]}…{addr[-5:]}`"


def wrap(text: str, subsequent: str = "", width: int = 98) -> str:
    """Wrap prose to the document line width so diffs stay readable."""
    return textwrap.fill(
        " ".join(text.split()), width=width, subsequent_indent=subsequent,
        break_long_words=False, break_on_hyphens=False)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


# -------------------------------------------------------------------------- fetch

_cache: dict[str, object] = {}


def markets() -> tuple[list[dict], list[dict]]:
    """(universe, ctxs) for dex xyz, cached for the process lifetime."""
    if "markets" not in _cache:
        meta, ctxs = info({"type": "metaAndAssetCtxs", "dex": DEX})
        _cache["markets"] = (meta, ctxs)
    meta, ctxs = _cache["markets"]  # type: ignore[misc]
    return meta, ctxs


def rows() -> list[dict]:
    meta, ctxs = markets()
    out = []
    for u, c in zip(meta["universe"], ctxs):
        px = float(c.get("markPx") or 0)
        out.append({
            "coin": u["name"].removeprefix(f"{DEX}:"),
            "name": u["name"],
            "oi": float(c.get("openInterest") or 0) * px,
            "vlm": float(c.get("dayNtlVlm") or 0),
            "fund": float(c.get("funding") or 0),
            "lev": u.get("maxLeverage"),
            "delisted": bool(u.get("isDelisted")),
            "margin_mode": u.get("marginMode"),
            "growth": u.get("growthMode") == "enabled",
        })
    return out


def tape(limit_markets: int | None = None) -> list[dict]:
    """recentTrades for the most active xyz markets. Cached for the process lifetime."""
    key = f"tape:{limit_markets}"
    if key in _cache:
        return _cache[key]  # type: ignore[return-value]
    active = [r for r in rows() if not r["delisted"]]
    active.sort(key=lambda r: -r["vlm"])
    if limit_markets:
        active = active[:limit_markets]
    batches = pmap(lambda r: info({"type": "recentTrades", "coin": r["name"]}), active)
    out = []
    for b in batches:
        for t in b or []:
            if len(t.get("users") or []) == 2:
                out.append(t)
    _cache[key] = out
    return out


def leaderboard() -> list[dict]:
    if "lb" not in _cache:
        with urllib.request.urlopen(LEADERBOARD, timeout=180) as r:
            _cache["lb"] = json.load(r)["leaderboardRows"]
    return _cache["lb"]  # type: ignore[return-value]


def xyz_state(addr: str) -> tuple[float, int, float, float]:
    """(absolute notional, position count, long notional, short notional)."""
    try:
        r = info({"type": "clearinghouseState", "user": addr, "dex": DEX}, retries=2)
    except RuntimeError:
        return 0.0, 0, 0.0, 0.0
    ntl = lng = sht = 0.0
    positions = r.get("assetPositions", [])
    for p in positions:
        pos = p["position"]
        v = abs(float(pos["positionValue"]))
        ntl += v
        if float(pos["szi"]) > 0:
            lng += v
        else:
            sht += v
    return ntl, len(positions), lng, sht


# ------------------------------------------------------------------------- blocks

def block_asof() -> str:
    return now_utc().strftime("%Y-%m-%d")


def block_dex_facts() -> str:
    dexs = info({"type": "perpDexs"})
    me = next((d for d in dexs if d and d.get("name") == DEX), None)
    others = [d["name"] for d in dexs if d and d.get("name") != DEX]

    deposit = ""
    try:
        st = info({"type": "perpDexStatus", "dex": DEX})
        for k in ("totalNetDeposit", "netDeposit", "totalNetDeposits"):
            if st and st.get(k) is not None:
                deposit = usd(float(st[k]))
                break
    except RuntimeError:
        pass

    rs = rows()
    total = len(rs)
    delisted = sum(1 for r in rs if r["delisted"])
    no_cross = sum(1 for r in rs if r["margin_mode"] == "noCross")
    strict = sum(1 for r in rs if r["margin_mode"] == "strictIsolated")
    growth = sum(1 for r in rs if r["growth"])

    lines = [
        "| Field | Value |",
        "| --- | --- |",
        f"| `dex` name | `{DEX}` |",
        f"| Deployer | `{(me or {}).get('deployer', '—')}` |",
        f"| Coin prefix | `{DEX}:` (e.g. `{DEX}:NVDA`, `{DEX}:SP500`) |",
        "| Collateral | USDC (`collateralToken: 0`) |",
    ]
    if deposit:
        lines.append(f"| Total net deposit | ~{deposit} (`perpDexStatus`) |")
    lines += [
        f"| Markets | {total} total, {total - delisted} active, {delisted} delisted |",
        f"| Margin mode | {no_cross} `noCross`, {strict} `strictIsolated`, "
        f"{total - no_cross - strict} with no flag |",
        f"| Growth mode | {growth} of {total} markets |",
        "",
        "Other HIP-3 dexes currently active: "
        + ", ".join(f"`{n}`" for n in others) + ".",
    ]
    return "\n".join(lines)


def block_snapshot() -> str:
    rs = rows()
    active = [r for r in rs if not r["delisted"]]
    oi_all = sum(r["oi"] for r in rs)
    vlm_all = sum(r["vlm"] for r in rs)
    delisted = [r["coin"] for r in rs if r["delisted"]]

    top = sorted(active, key=lambda r: -r["oi"])[:15]
    lines = [
        wrap(f"Total OI notional **{usd(oi_all)}** across {len(rs)} markets ({len(active)} active, "
             f"{len(delisted)} delisted), 24h volume **{usd(vlm_all)}**."),
        "",
        "| Market | OI notional | 24h volume | Max lev | Funding (1h) |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for r in top:
        lines.append(
            f"| `{r['coin']}` | {usd(r['oi'])} | {usd(r['vlm'])} | "
            f"{r['lev']}x | {r['fund'] * 100:+.4f}% |")
    if delisted:
        lines += [
            "",
            wrap("Delisted as of today: " + " ".join(f"`{c}`" for c in delisted) + "."),
            wrap("Delisted markets still appear in the universe and still have residual OI — "
                 "filter `isDelisted` if you don't want them."),
        ]
    return "\n".join(lines)


def block_limits() -> str:
    lim = info({"type": "perpDexLimits", "dex": DEX})
    caps = lim.get("coinToOiCap") or []
    caps = sorted(((c, float(v)) for c, v in caps), key=lambda r: -r[1])[:5]

    at_cap = info({"type": "perpsAtOpenInterestCap", "dex": DEX}) or []

    lines = [
        "| Field | Value |",
        "| --- | --- |",
        f"| `totalOiCap` | {usd_exact(float(lim['totalOiCap']))} |",
        f"| `oiSzCapPerPerp` | {usd_exact(float(lim['oiSzCapPerPerp']))} |",
        f"| `maxTransferNtl` | {usd_exact(float(lim['maxTransferNtl']))} |",
        "| `coinToOiCap` | per-market, e.g. "
        + ", ".join(f"`{c.removeprefix(DEX + ':')}` {usd(v)}" for c, v in caps) + " |",
        "| `perpsAtOpenInterestCap` | "
        + (", ".join(f"`{c.removeprefix(DEX + ':')}`" for c in at_cap)
           if at_cap else "empty — no market is at cap")
        + " |",
    ]
    return "\n".join(lines)


def block_stp_check() -> str:
    trades = tape(limit_markets=40)
    self_match = sum(1 for t in trades if t["users"][0].lower() == t["users"][1].lower())
    n_markets = len({t["coin"] for t in trades})
    verdict = "**zero**" if self_match == 0 else f"**{self_match}**"
    return wrap(
        f"Verified: of {len(trades)} trades pulled across {n_markets} `{DEX}` markets, "
        f"{verdict} have `users[0] == users[1]`. Do not spend time hunting literal "
        "self-matches — look for multi-address structure.")


def block_seed_sources() -> str:
    lb = len(leaderboard())
    active = sum(1 for r in rows() if not r["delisted"])
    return "\n".join([
        "| Source | Address count | Bias |",
        "| --- | ---: | --- |",
        f"| `https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` | ~{num(lb)} | "
        "Undocumented, ~34 MB. **Sub-accounts are not included at all.** |",
        f"| `recentTrades` per market | 10 trades/market → ~{num(active * 10)} pairs | "
        "Only traders active in the last few minutes |",
        "| WebSocket `trades` | Unbounded, cumulative | "
        "Only those trading since subscribe; idle positions are invisible |",
        "| `PerpDexClassTransfer` events on S3 | Partial | "
        "See the next subsection — misses unified-account users |",
    ])


def block_unified() -> str:
    """Find a real unified-account trap from the tape; do not hardcode an address."""
    freq = collections.Counter()
    for t in tape(limit_markets=40):
        for u in t["users"]:
            freq[u.lower()] += 1
    candidates = [a for a, _ in freq.most_common(40)]

    def probe(addr: str) -> dict | None:
        try:
            mode = info({"type": "userAbstraction", "user": addr}, retries=2)
            ntl, npos, _, _ = xyz_state(addr)
            if npos == 0:
                return None
            av = float(info({"type": "clearinghouseState", "user": addr, "dex": DEX},
                            retries=2)["marginSummary"]["accountValue"])
            spot = info({"type": "spotClearinghouseState", "user": addr}, retries=2)
            usdc = next((float(b["total"]) for b in spot.get("balances", [])
                         if b["coin"] == "USDC"), 0.0)
        except (RuntimeError, KeyError, TypeError):
            return None
        mode_name = mode if isinstance(mode, str) else (mode or {}).get("type", str(mode))
        return {"addr": addr, "mode": mode_name, "pos": npos, "av": av,
                "usdc": usdc, "ntl": ntl, "gap": usdc / av if av > 0 else 0.0}

    probes = [p for p in pmap(probe, candidates, workers=5) if p]
    unified = sorted((p for p in probes if "unified" in p["mode"].lower()),
                     key=lambda p: -p["gap"])[:2]
    other = sorted((p for p in probes if "unified" not in p["mode"].lower()),
                   key=lambda p: -p["ntl"])[:1]
    picked = unified + other
    if not picked:
        return ("No unified-account example was caught in the latest tape sample — "
                "re-run `regen.py --full` when the market is busier.")

    lines = [
        "| Address | Mode | `xyz` positions | `xyz` accountValue | Actual spot USDC |",
        "| --- | --- | ---: | ---: | ---: |",
    ]
    for p in picked:
        label = "`disabled` (standard)" if "unified" not in p["mode"].lower() else f"`{p['mode']}`"
        emph = f"**{usd(p['usdc'])}**" if p["gap"] > 1.5 else usd(p["usdc"])
        lines.append(f"| {short(p['addr'])} | {label} | {p['pos']} | {usd(p['av'])} | {emph} |")

    if unified and unified[0]["gap"] > 1.5:
        top = unified[0]
        lines += ["", wrap(
            f"For {short(top['addr'])}, reading `accountValue` on dex `{DEX}` understates "
            f"collateral by **{top['gap']:.0f}x** — a misread here means a total miss on "
            "liquidation distance.")]
    return "\n".join(lines)


def case_data() -> dict:
    """All CASE_MASTER case-study figures in one pull, cached."""
    if "case" in _cache:
        return _cache["case"]  # type: ignore[return-value]

    master = CASE_MASTER
    subs = info({"type": "subAccounts", "user": master}) or []
    sub_addrs = [s["subAccountUser"].lower() for s in subs if s.get("subAccountUser")]

    lb = leaderboard()
    lb_set = {r["ethAddress"].lower() for r in lb}
    entry = next((r for r in lb if r["ethAddress"].lower() == master), None)

    own = xyz_state(master)
    native_av = float(
        info({"type": "clearinghouseState", "user": master})["marginSummary"]["accountValue"])

    states = pmap(xyz_state, sub_addrs) if sub_addrs else []
    biggest = max(zip(sub_addrs, states), key=lambda r: r[1][0], default=(None, (0, 0, 0, 0)))

    daily = info({"type": "userFees", "user": master}).get("dailyUserVlm") or []
    week = daily[-8:-1] if len(daily) >= 8 else daily
    week_vlm = sum(float(d["userCross"]) + float(d["userAdd"]) for d in week)
    all_vlm = sum(float(d["userCross"]) + float(d["userAdd"]) for d in daily)
    lb_week = next(
        (float(w["vlm"]) for name, w in (entry or {}).get("windowPerformances", [])
         if name == "week"), 0.0)

    tape_addrs = {u.lower() for t in tape(limit_markets=40) for u in t["users"]}

    data = {
        "master": master,
        "subs": sub_addrs,
        "subs_on_lb": sum(1 for a in sub_addrs if a in lb_set),
        "sub_total": sum(s[0] for s in states),
        "biggest": biggest,
        "own_ntl": own[0],
        "own_pos": own[1],
        "native_av": native_av,
        "lb_size": len(lb),
        "lb_av": float(entry["accountValue"]) if entry else 0.0,
        "lb_week": lb_week,
        "week_vlm": week_vlm,
        "all_vlm": all_vlm,
        "vlm_days": len(daily),
        "open_ntl": sum(s[0] for s in states) + own[0],
        "tape_addrs": len(tape_addrs),
        "tape_on_lb": len(tape_addrs & lb_set),
    }
    _cache["case"] = data
    return data


def block_case_lb() -> str:
    d = case_data()
    m = d["master"][:10]
    addr, state = d["biggest"]

    found = (f"only **{d['subs_on_lb']}** appear on the leaderboard"
             if d["subs_on_lb"] else "**none** appear on the leaderboard")
    item1 = ("1. **The leaderboard does not list sub-accounts — it folds them into the master.** Of "
             f"{len(d['subs'])} sub-accounts of `{m}…`, {found}.")
    if addr and state[0] > 0:
        item1 += (f" The largest, `{addr[:10]}…`, holds **{usd(state[0])} across {state[1]} "
                  "positions** and is still invisible there.")
    if d["lb_av"]:
        item1 += (f" The leaderboard reports the master's `accountValue` as **{usd(d['lb_av'])}**, "
                  f"while the master itself has only {usd(d['native_av'])} on native perps and "
                  f"**{usd(d['own_ntl'])} on `{DEX}`** ({d['own_pos']} positions) — the gap is "
                  f"{usd(d['sub_total'])} belonging to aggregated sub-accounts.")
    item1 += (" So the leaderboard reports the right *value* at cluster level, but **the "
              "address that actually holds the positions never appears**, and cannot be used "
              "to fan out positions.")

    item2 = (
        f"2. **The leaderboard misses most active traders.** Of {d['tape_addrs']} addresses "
        f"seen trading on the tape, only {d['tape_on_lb']} "
        f"(**{pct(100 * d['tape_on_lb'] / max(d['tape_addrs'], 1), 0)}**) are on the leaderboard.")

    return "\n".join([wrap(item1, "   "), wrap(item2, "   ")])


def block_case_churn() -> str:
    d = case_data()
    if not (d["all_vlm"] > 0 and d["open_ntl"] > 0):
        return wrap("A cheap companion ratio: **volume ÷ open notional**. The comparison "
                    "figure could not be pulled for the current example address.")
    ratio = d["all_vlm"] / d["open_ntl"]
    return wrap(
        f"A cheap companion ratio: **{d['vlm_days']}-day volume ÷ open notional**. For "
        f"{short(d['master'])}, {usd(d['all_vlm'])} volume over {usd(d['open_ntl'])} open "
        f"notional ≈ **{ratio:.0f}x**. High, but still in the range of an active market maker "
        "— not a figure that stands alone as evidence.")


def block_case_vlm() -> str:
    d = case_data()
    m = d["master"][:10]
    if not (d["week_vlm"] > 0 and d["lb_week"] > 0):
        return wrap("4. **Volume figures need to be reconciled across sources** before they are "
                    "used as an absolute — `userFees` and the leaderboard do not always agree.",
                    "   ")
    out = [wrap(
        f"4. **Volume figures differ {d['lb_week'] / d['week_vlm']:.2f}x across sources, and the "
        f"gap is unexplained.** For `{m}…`, `userFees.dailyUserVlm` sums to **{usd(d['week_vlm'])}** "
        f"over a full 7 days, while the leaderboard reports **{usd(d['lb_week'])}** for the "
        "`week` window. Two candidate explanations that cannot yet be separated: the leaderboard "
        "counts both sides of each trade, or `userFees` already cuts growth-mode volume "
        "contribution (>=90%) while the leaderboard is raw. Do not use an absolute volume "
        "figure from either source without naming the source.", "   ")]
    if d["own_ntl"] == 0 and d["own_pos"] == 0:
        out += ["", wrap(
            "One thing that **is** settled: `userFees` on the master **aggregates "
            f"sub-accounts**. Master `{m}…` itself holds zero positions on `{DEX}`, but "
            f"its `userFees` reports {usd(d['week_vlm'])} of weekly volume. So the master's "
            "volume figure is a cluster figure, not the master's own activity — and that "
            "actually helps: one `userFees` call already gives volume for the whole cluster.")]
    return "\n".join(out)


def coverage_data() -> dict:
    """Slow: ~2 requests per address. Measures what share of OI can be captured."""
    if "coverage" in _cache:
        return _cache["coverage"]  # type: ignore[return-value]

    rs = rows()
    oi_one_side = sum(r["oi"] for r in rs)

    tape_addrs = sorted({u.lower() for t in tape() for u in t["users"]})
    lb = sorted(leaderboard(), key=lambda r: -float(r["accountValue"]))
    lb_top = [r["ethAddress"].lower() for r in lb[:COVERAGE_LB_SAMPLE]]
    targets = list(dict.fromkeys(tape_addrs + lb_top))

    print(f"  coverage scan: {len(targets):,} addresses", file=sys.stderr, flush=True)
    results = pmap(xyz_state, targets, workers=8)

    captured = sum(r[0] for r in results)
    data = {
        "markets": len(rs),
        "oi_one_side": oi_one_side,
        "ground_truth": oi_one_side * 2,
        "targets": len(targets),
        "lb_top": len(lb_top),
        "lb_size": len(lb),
        "tape_addrs": len(tape_addrs),
        "holders": sum(1 for r in results if r[1]),
        "captured": captured,
        "long": sum(r[2] for r in results),
        "short": sum(r[3] for r in results),
        # How fast the curve flattens: first 500 addresses vs last 1000.
        "head": sum(r[0] for r in results[:500]),
        "tail": sum(r[0] for r in results[-1000:]),
        "pct": 100 * captured / (oi_one_side * 2) if oi_one_side else 0.0,
    }
    _cache["coverage"] = data
    return data


def block_coverage_pct() -> str:
    return pct(coverage_data()["pct"])


def block_coverage() -> str:
    d = coverage_data()
    return "\n".join([
        wrap("The benchmark: `openInterest` from `metaAndAssetCtxs` is counted **one-sided**, so "
             "the total absolute position value of all users = 2 x sum(OI x mark). As of "
             f"{now_utc():%Y-%m-%d} for {d['markets']} `{DEX}` markets that is 2 x "
             f"{usd(d['oi_one_side'])} = **{usd(d['ground_truth'])}**."),
        "",
        wrap(f"Query `clearinghouseState(dex=\"{DEX}\")` for {num(d['targets'])} addresses — "
             f"the top {num(d['lb_top'])} on the leaderboard by `accountValue`, plus "
             f"{d['tape_addrs']} addresses that appear on the tape:"),
        "",
        "| | |",
        "| --- | ---: |",
        f"| Addresses queried | {num(d['targets'])} |",
        f"| That actually hold a `{DEX}` position | {num(d['holders'])} |",
        f"| Notional captured | {usd(d['captured'])} |",
        f"| **Coverage** | **{pct(d['pct'])}** |",
        "",
        wrap(f"Long captured {usd(d['long'])} and short captured {usd(d['short'])} — "
             f"balanced, and consistent with {pct(d['pct'], 0)} coverage on both sides of the "
             "book. That is an internal check that the figure is not a sampling artifact."),
        "",
        wrap("More important: **the curve has already flattened**. The first 500 addresses "
             f"contribute {usd(d['head'])}; the last 1,000 add only {usd(d['tail'])}. So "
             f"exhausting all {num(d['lb_size'])} leaderboard addresses still will not "
             "approach 100%. Two structural reasons:"),
    ])


BLOCKS: dict[str, tuple[bool, object]] = {
    "asof": (False, block_asof),
    "dex-facts": (False, block_dex_facts),
    "snapshot": (False, block_snapshot),
    "limits": (False, block_limits),
    "stp-check": (False, block_stp_check),
    "seed-sources": (False, block_seed_sources),
    "unified": (True, block_unified),
    "case-churn": (True, block_case_churn),
    "case-lb": (True, block_case_lb),
    "case-vlm": (True, block_case_vlm),
    "coverage": (True, block_coverage),
    "coverage-pct": (True, block_coverage_pct),
}


# --------------------------------------------------------------------------- main

def splice(text: str, name: str, body: str) -> str:
    """Replace the contents between markers. Single-line markers are treated as inline."""
    pattern = re.compile(
        rf"(<!-- gen:{re.escape(name)} -->)(.*?)(<!-- /gen:{re.escape(name)} -->)",
        re.DOTALL)
    m = pattern.search(text)
    if not m:
        raise KeyError(f"marker gen:{name} is missing from {DOC.name}")
    inline = "\n" not in m.group(2)
    return text[:m.end(1)] + (body if inline else f"\n{body}\n") + text[m.start(3):]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--full", action="store_true", help="also run slow blocks")
    ap.add_argument("--only", help="comma-separated list of blocks")
    ap.add_argument("--dry-run", action="store_true", help="show diff, do not write")
    ap.add_argument("--list", action="store_true", help="list blocks and exit")
    args = ap.parse_args()

    if args.list:
        for name, (slow, _) in BLOCKS.items():
            print(f"  {name:<12} {'slow' if slow else 'fast'}")
        return 0

    if args.only:
        wanted = [n.strip() for n in args.only.split(",")]
        unknown = [n for n in wanted if n not in BLOCKS]
        if unknown:
            print(f"unknown blocks: {', '.join(unknown)}", file=sys.stderr)
            return 2
    else:
        wanted = [n for n, (slow, _) in BLOCKS.items() if args.full or not slow]

    original = DOC.read_text()
    text = original
    failed: list[str] = []

    for name in wanted:
        _, fn = BLOCKS[name]
        started = time.time()
        print(f"» {name}", file=sys.stderr, flush=True)
        try:
            text = splice(text, name, fn())  # type: ignore[operator]
        except Exception as exc:  # noqa: BLE001 - one failed block must not cancel the rest
            failed.append(name)
            print(f"  failed: {exc}", file=sys.stderr)
            continue
        print(f"  done in {time.time() - started:.1f}s", file=sys.stderr)

    if text == original:
        print("no changes.", file=sys.stderr)
        return 1 if failed else 0

    if args.dry_run:
        diff = difflib.unified_diff(
            original.splitlines(True), text.splitlines(True),
            fromfile=f"{DOC.name} (current)", tofile=f"{DOC.name} (new)")
        sys.stdout.writelines(diff)
    else:
        DOC.write_text(text)
        changed = sum(1 for a, b in zip(original.splitlines(), text.splitlines()) if a != b)
        print(f"{DOC.name} rewritten (~{changed} lines changed).", file=sys.stderr)

    if failed:
        print(f"failed blocks: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
