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
  const ac = useRef<AbortController | null>(null);
  const tapeDone = useRef(false);
  const lookupHeld = useRef<Lookup | null>(null);

  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const loadAll = useCallback(async (addr?: string) => {
    ac.current?.abort();
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
        setProgress("Positions");
        const res = await lookupAddress(target, [], next.signal);
        if (next.signal.aborted) return;
        lookupHeld.current = res;
        setLookup(res);
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
      if (!next.signal.aborted) setBusy(false);
    }
  }, []);

  useEffect(() => {
    return () => ac.current?.abort();
  }, []);

  const clearLookup = useCallback(() => {
    lookupHeld.current = null;
    setLookup(null);
    setLookupError(null);
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
    data, progress, error, busy, loadAll, loadFees,
    lookup, lookupError, clearLookup,
  };
}
