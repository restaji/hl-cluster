export const HL_WALLET = (addr: string) =>
  `https://hl.eco/w/${addr.toLowerCase()}#all`;

export function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function usdShort(v: number) {
  const n = Math.abs(v);
  if (n >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

export function usdM(v: number) {
  return `$${(v / 1e6).toFixed(1)}M`;
}

export function vol15Label(v: number | null) {
  if (v == null) return "—";
  return usdShort(v);
}

export function fmtTime(ms: number) {
  return `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}
