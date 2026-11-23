export type TrafficPoint = { ts: number; rx_mbps: number; tx_mbps: number };
export type PingPoint = { ts: number; rtt: number | null; loss: number | null; permissionDenied?: boolean };
export type ClientPresence = { lastSeen: number; connectedAt?: number; validUntil?: number; sessionKind?: string };
export type RouterLog = { time: string; topics: string; message: string; severity: string };
export type BootUpdate = { current: string; latest: string; available: boolean };
export type PackageUpgradeProgress = {
  kind: string; startedAt: number; updatedAt: number; from: string; target: string;
  stage: string; percent?: number | null; downloaded?: string;
};
export type Port = {
  id: string; name: string; type: string; defaultName?: string; comment: string;
  running: boolean; disabled: boolean; linkRate?: string; macAddr: string; ips: string[];
  rxMbps: number | null; txMbps: number | null; rxBytes: number | null; txBytes: number | null;
  ratesUnavailable?: boolean; panelBytes?: { rx: number | null; tx: number | null };
  errors: number | null; drops: number | null; linkDowns: number | null;
  poe?: { input?: boolean; output?: boolean; status?: string; watts?: number | null } | null;
};
