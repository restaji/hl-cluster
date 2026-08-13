export type Market = {
  coin: string;
  name: string;
  oi: number;
  vlm: number;
  ratio: number;
  lev: number;
  fund: number;
  growth: boolean;
};

export type Trade = {
  coin: string;
  px: string;
  sz: string;
  time: number;
  users: [string, string];
};

export type Cluster = {
  root: string;
  size: number;
  tape: number;
  intra: number;
  share: number;
  ntl: number;
  onTape: string[];
  members: string[];
  vol15: number | null;
  makerPct: number | null;
  addBps: number | null;
};

export type Recip = {
  a: string;
  b: string;
  n: number;
  bal: number;
  ntl: number;
  coins: string[];
};

export type Hit = {
  time: number;
  coin: string;
  ntl: number;
  px: string;
  sz: string;
  buyer: string;
  seller: string;
  root: string;
};

export type Fees = {
  vol15: number;
  makerPct: number;
  addBps: number;
};

export type LookupPos = {
  addr: string;
  coin: string;
  long: boolean;
  ntl: number;
  entry: string;
  upnl: number;
  lev: string;
};

export type LookupMember = {
  addr: string;
  av: number;
  ntl: number;
  pos: number;
  tape: number;
  self: boolean;
};

export type Lookup = {
  addr: string;
  role: string;
  root: string;
  mode: string;
  isCluster: boolean;
  clusterSize: number;
  truncated: boolean;
  members: LookupMember[];
  positions: LookupPos[];
  av: number;
  ntl: number;
  vol15: number | null;
  makerPct: number | null;
  addBps: number | null;
  tapeTouch: number;
  intra: number;
  intraRows: Hit[];
  counterparties: { addr: string; n: number; ntl: number }[];
};
