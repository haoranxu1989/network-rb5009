import type { IconName } from './icons';
import type { BootUpdate, ClientPresence, Port, RouterLog, PingPoint, TrafficPoint } from './types';
import { fmtTime, fmtDataMB } from './format';
export type { ClientPresence, Port, RouterLog } from './types';
import type { GatewayJob } from './maintenance';

export const durations = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
export type Range = keyof typeof durations;
export const defaultTrafficRange: Range = '1h';
export type Rate = number | null;
export type ClientSample = { ts: number; down: number; up: number; gap?: boolean };
export type Client = {
  id: string; name: string; ip: string; mac: string; connection: string;
  status: string; icon: IconName; down: Rate; up: Rate; samples: ClientSample[]; presence: ClientPresence | null;
};
export type OverviewPage = 'overview' | 'logs';
export type History = { points: TrafficPoint[]; downMB: Rate; upMB: Rate; message: string };
export type Overview = {
  demo: boolean; end: number; lastSample: number | null; source: string; site: string; online: boolean | null;
  model: string; version: string; uptime: string; cpu: Rate; memory: Rate;
  iface: string; wanPort: string; address: string; down: Rate; up: Rate; latency: Rate; loss: Rate; pingTarget: string;
  pings: PingPoint[]; clients: Client[]; clientReady: boolean; clientsAsOf: number; logs: RouterLog[] | null; history: History;
  ports: Port[] | null; historyRouterId: string;
  maintenance: {
    routerId: string; routerName: string; canWrite: boolean | null;
    latest: string; available: boolean; channel: string; status: string; boot: BootUpdate | null;
  };
  gatewayJob: GatewayJob | null;
};

export function emptyHistory(message = '等待流量采样'): History {
  return { points: [], downMB: null, upMB: null, message };
}
export function emptyOverview(): Overview {
  return {
    demo: false, end: Date.now(), lastSample: null, source: '连接中', site: '本地站点', online: null,
    model: '', version: '', uptime: '', cpu: null, memory: null, iface: '', wanPort: '', address: '',
    down: null, up: null, latency: null, loss: null, pingTarget: '', pings: [], clients: [], clientReady: false, clientsAsOf: 0,
    logs: null, history: emptyHistory(), ports: null, historyRouterId: '',
    maintenance: {routerId: '', routerName: '', canWrite: null, latest: '', available: false, channel: '', status: '', boot: null},
    gatewayJob: null,
  };
}
export function numberText(value: Rate, digits = 1): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}
export function dataSize(mb: Rate): string {
  return mb === null ? '—' : fmtDataMB(mb);
}
export const clock = (ts: number, seconds = false): string => fmtTime(ts, seconds);
export function uptimeSeconds(raw: string): number | null {
  const parts = /^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(raw);
  const clock = /^(?:(\d+)w)?(?:(\d+)d)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(raw);
  const match = parts ?? clock;
  if (!raw || !match) return null;
  return Math.floor(Number(match[1] || 0) * 604800 + Number(match[2] || 0) * 86400 +
    Number(match[3] || 0) * 3600 + Number(match[4] || 0) * 60 + Number(match[5] || 0));
}
export function compactUptime(raw: string): string {
  const seconds = uptimeSeconds(raw);
  if (seconds === null) return raw || '—';
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds / 3600) % 24, minutes = Math.floor(seconds / 60) % 60;
  if (days > 0) return days + ' 天 ' + hours + ' 小时';
  return hours > 0 ? hours + ' 小时 ' + minutes + ' 分' : minutes + ' 分 ' + seconds % 60 + ' 秒';
}
