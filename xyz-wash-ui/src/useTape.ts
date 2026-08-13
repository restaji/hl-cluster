import { useCallback, useEffect, useRef, useState } from "react";
import { fetchUserFees } from "./hl";
import { attachTape, lookupAddress } from "./lookup";
import { loadTape, type TapeData } from "./pipeline";
import type { Lookup } from "./types";

const empty: TapeData = {
  markets: [],
  trades: [],
  oi: 0,
  vlm: 0,
  fills: 0,
  selfMatch: 0,
  resolved: 0,
  clusters: [],
  recip: [],
  hits: [],
  fetchedAt: 0,
};

const FULL_ADDR = /^0x[a-fA-F0-9]{40}$/;

export function useTape() {
  const [data, setData] = useState<TapeData>(empty);
  const [progress, setProgress] = useState("Paste an address");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const ac = useRef<AbortController | null>(null);
  const lookupAc = useRef<AbortController | null>(null);
  const tapeDone = useRef(false);
  const lookupHeld = useRef<Lookup | null>(null);
  const inflight = useRef<string | null>(null);
  const trades = useRef<TapeData["trades"]>([]);

  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  trades.current = data.trades;

  const runLookup = useCallback(async (addr: string) => {
    if (!FULL_ADDR.test(addr)) return;
    const target = addr.toLowerCase();
    if (inflight.current === target || lookupHeld.current?.addr === target) return;

    lookupAc.current?.abort();
    const next = new AbortController();
    lookupAc.current = next;
    inflight.current = target;
    setLookupBusy(true);
    setLookupError(null);
    setProgress("Positions");
    try {
      const res = await lookupAddress(target, trades.current, next.signal);
      if (next.signal.aborted) return;
      lookupHeld.current = res;
      setLookup(res);
      setProgress(tapeDone.current ? "Live" : "Positions");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setLookupError((e as Error).message ?? "Lookup failed");
    } finally {
      if (!next.signal.aborted) {
        inflight.current = null;
        setLookupBusy(false);
      }
    }
  }, []);

  const loadAll = useCallback(async (addr?: string) => {
    ac.current?.abort();
    lookupAc.current?.abort();
    const next = new AbortController();
    ac.current = next;
    tapeDone.current = false;
    setBusy(true);
    setError(null);
    setLookupError(null);

    const target = addr && FULL_ADDR.test(addr) ? addr.toLowerCase() : undefined;
    let phase: "positions" | "tape" = target ? "positions" : "tape";

    try {
      if (target) {
        inflight.current = target;
        setLookupBusy(true);
        setProgress("Positions");
        const res = await lookupAddress(target, trades.current, next.signal);
        if (next.signal.aborted) return;
        lookupHeld.current = res;
        setLookup(res);
        setLookupBusy(false);
        phase = "tape";
      } else {
        lookupHeld.current = null;
        setLookup(null);
      }

      setProgress("Markets");
      const tape = await loadTape(
        setProgress,
        next.signal,
        ({ markets, oi, vlm }) => {
          if (next.signal.aborted) return;
          setData((prev) => ({ ...prev, markets, oi, vlm }));
        },
      );
      if (next.signal.aborted) return;
      tapeDone.current = true;
      setData(tape);
      if (lookupHeld.current) {
        const scored = attachTape(lookupHeld.current, tape.trades);
        lookupHeld.current = scored;
        setLookup(scored);
      }
      setProgress("Live");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = (e as Error).message ?? "Fetch failed";
      if (phase === "positions") setLookupError(msg);
      else setError(msg);
      setProgress("Error");
    } finally {
      if (!next.signal.aborted) {
        setBusy(false);
        setLookupBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      ac.current?.abort();
      lookupAc.current?.abort();
    };
  }, []);

  const clearLookup = useCallback(() => {
    lookupAc.current?.abort();
    lookupHeld.current = null;
    inflight.current = null;
    setLookup(null);
    setLookupError(null);
    setLookupBusy(false);
  }, []);

  const loadFees = useCallback(async (root: string) => {
    try {
      const fees = await fetchUserFees(root);
      setData((prev) => ({
        ...prev,
        clusters: prev.clusters.map((c) =>
          c.root === root
            ? { ...c, vol15: fees.vol15, makerPct: fees.makerPct, addBps: fees.addBps }
            : c,
        ),
      }));
    } catch {
      /* leave blank */
    }
  }, []);

  return {
    data, progress, error, busy, lookupBusy, loadAll, runLookup, loadFees,
    lookup, lookupError, clearLookup,
  };
}
