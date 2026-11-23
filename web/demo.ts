import { defaultTrafficRange, durations, emptyHistory, emptyOverview, type Client, type Overview, type Port, type Range, type History } from './data';
import type { GatewayHistoryActions } from './history-reset';
import { zeroPortTotals } from './ports';
import type { IconName } from './icons';
import type { TrafficPoint } from './types';
import { clientWindowMs } from './clients';
import { beginGateway, gatewayAccepted, gatewayTarget, observeGateway, syncGatewayProgress, type SubmitGateway } from './maintenance';

// A fixed local snapshot makes file previews reproducible in any timezone.
const end = new Date(2026, 10, 17, 10, 0, 0).getTime();
const minute = 60000;
const day = durations['24h'];
const clientRows: Array<[string, IconName, string, number, number]> = [
  ['Mac mini', 'display', '下游交换机 · ether2', 82.4, 12.6],
  ['Synology NAS', 'drive', '以太网 · ether3', 56.8, 18.2],
  ['Apple TV 4K', 'tv', '以太网 · ether4', 24.3, 1.8],
  ['工作站', 'display', 'PPPoE · 下游交换机 · ether2', 12.6, 2.5],
  ['家庭服务器', 'drive', '下游交换机 · ether2', 5.4, 0.7],
  ['PlayStation 5', 'console', '以太网 · ether5', 3.4, 0.6],
  ['影音播放器', 'tv', '下游交换机 · ether2', 1.1, 0.3],
  ['客厅显示屏', 'display', '下游交换机 · ether2', 0.4, 0.1],
];
const hostNumbers = [24, 10, 38, 42, 51, 63, 67, 71];
const trafficProfiles = [
  [0.34, 0.46, 1.3, 0.88, 0.4, 0.48, 1.21, 0.7, 1],
  [0.84, 0.82, 0.86, 1.12, 1.13, 0.7, 0.81, 0.99, 1],
  [0.2, 1.3, 0.28, 0.25, 1.18, 0.22, 1.3, 0.29, 1],
  [0.28, 0.32, 0.99, 0.43, 0.25, 0.44, 1.38, 0.78, 1],
  [0.51, 0.39, 0.4, 0.71, 0.56, 0.42, 0.57, 1.25, 1],
  [0.62, 0.57, 0.88, 0.67, 1.32, 0.89, 1.12, 1.13, 1],
  [0.48, 0.64, 0.51, 0.68, 0.55, 0.64, 0.72, 0.88, 1],
  [0.16, 0.25, 1.05, 0.17, 0.22, 1.08, 0.28, 0.2, 1],
];
function demoClientSamples(index: number, down: number, up: number) {
  const profile = trafficProfiles[index]!;
  return Array.from({ length: 121 }, (_, j) => {
    const k = Math.floor(j / 15), t = j % 15 / 15;
    const level = profile[k]! * (1 - t) + (profile[k + 1] ?? 1) * t;
    const ripple = Math.sin(j * 1.8 + index) * 0.065;
    return { ts: end - clientWindowMs + j * clientWindowMs / 120,
      down: j === 120 ? down : down * (level + ripple),
      up: j === 120 ? up : up * (0.55 + level * 0.3 + Math.sin(j * 0.7 + index) * 0.25) };
  });
}
const clients: Client[] = clientRows.map(([name, icon, connection, down, up], i) => ({
  id: String(i + 1), name, icon, connection, down, up, status: i === 3 ? 'PPPoE 已连接' : '最近有网络活动',
  ip: '192.168.88.' + hostNumbers[i], mac: '02:50:09:00:00:' + String(11 + i),
  presence: i === 3 ? { lastSeen: end, connectedAt: end - 152 * minute, validUntil: end + minute, sessionKind: 'pppoe' } : { lastSeen: end },
  samples: demoClientSamples(i, down, up),
}));
clients.push({ id: '9', name: '笔记本电脑', icon: 'display', connection: '下游交换机 · ether2',
  mac: '02:50:09:00:00:19', ip: '192.168.88.79', status: '有在线记录',
  presence: { lastSeen: end - 12 * minute }, down: null, up: null, samples: [] });

function demoPorts(poe: boolean): Port[] {
  // Client downloads leave the gateway as TX on the switch uplink.
  const switched = clients.filter(c => c.connection.endsWith('ether2'));
  const switchRx = switched.reduce((n, c) => n + c.up!, 0);
  const switchTx = switched.reduce((n, c) => n + c.down!, 0);
  const rows: Array<[name: string, note: string, speed: string, rx: number, tx: number, rxGB: number, txGB: number]> = [
    ['ether1', '光猫', '2.5Gbps', 186.4, 36.8, 4230.8, 1608.2],
    ['ether2', '接入交换机', '1Gbps', switchRx, switchTx, 870.4, 2142.9],
    ['ether3', 'Synology NAS', '1Gbps', 18.2, 56.8, 530.8, 1380.1],
    ['ether4', 'Apple TV 4K', '100Mbps', 1.8, 24.3, 45.2, 556.7],
    ['ether5', 'PlayStation 5', '1Gbps', 0.6, 3.4, 21.9, 204.5],
    poe ? ['ether6', '门口摄像机', '100Mbps', 4.6, 0.1, 62.7, 1.4] : ['ether6', '', '', 0, 0, 0, 0],
    ['ether7', '', '', 0, 0, 0, 0], ['ether8', '', '', 0, 0, 0, 0],
    ['sfp-sfpplus1', '汇聚交换机', '10Gbps', 0, 0, 123.7, 98.4],
  ];
  return rows.map(([name, comment, linkRate, rxMbps, txMbps, rxGB, txGB], i) => ({
    id: '*' + (i + 1), type: 'ether', name, defaultName: name, comment, linkRate,
    running: !!linkRate, disabled: name === 'ether8', rxMbps, txMbps,
    rxBytes: Math.round(rxGB * 1e9), txBytes: Math.round(txGB * 1e9),
    macAddr: '02:50:09:11:00:' + String(i + 1).padStart(2, '0'), ips: i === 0 ? ['203.0.113.24/24'] : [],
    errors: 0, drops: 0, linkDowns: 0,
    ...(poe && i < 8 ? { poe: demoOutput(name) } : {}),
  }));
}

function demoOutput(name: string): NonNullable<Port['poe']> {
  if (name === 'ether2') return { input: true, output: true, status: 'powered-on', watts: 8.4 };
  if (name === 'ether6') return { input: true, output: true, status: 'powered-on', watts: 5.2 };
  return { input: true, output: true, status: name === 'ether8' ? 'disabled' : 'waiting-for-load' };
}

// A minute-resolution series is shared by all three ranges. Wider windows use
// bucket means to preserve their daily patterns and trapezoids for byte totals.
function generateWeek(): TrafficPoint[] {
  const points: TrafficPoint[] = [];
  let seed = 56317;
  let ripple = 0;
  for (let ts = end - 7 * day, i = 0; ts <= end; ts += minute, i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 4294967296;
    ripple = ripple * 0.77 + (noise - .45) * 26;
    const d = new Date(ts);
    const h = d.getHours() + d.getMinutes() / 60;
    const peak = (center: number, spread: number) => Math.exp(-Math.pow((h - center) / spread, 2));
    const base = 18 + 0.92 * (38 * peak(11.4, 2.3) + 72 * peak(15.5, 1.35) + 140 * peak(20.65, 2.25) + 108 * peak(8.8, 1.65));
    const burst = Math.max(0, Math.sin(i * .063) * Math.cos(i * .02)) * (.55 * base + 24);
    const down = Math.max(4, base + burst + ripple + 11 * Math.sin(i * .021) + 9 * Math.cos(i * .009));
    const up = Math.max(1, 4 + down * .16 + 22 * peak(22.2, .8) + burst * .12 + ripple * .2);
    points.push({ ts, rx_mbps: down, tx_mbps: up });
  }
  // The last minutes ramp up to the same instant shown by the WAN counters.
  for (let j = 0; j <= 14; j++) {
    const p = points[points.length - 15 + j]!;
    const f = j / 14;
    p.rx_mbps += (186.4 - p.rx_mbps) * f;
    p.tx_mbps += (36.8 - p.tx_mbps) * f;
  }
  return points;
}
let week: TrafficPoint[] | undefined;
export function demoHistory(range: Range): History {
  week ??= generateWeek();
  const raw = week.filter(p => p.ts >= end - durations[range]);
  const size = Math.ceil(raw.length / 240);
  const points: TrafficPoint[] = [];
  let downMB = 0, upMB = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1]!, b = raw[i]!;
    downMB += (a.rx_mbps + b.rx_mbps) * 60 / 16;
    upMB += (a.tx_mbps + b.tx_mbps) * 60 / 16;
  }
  for (let i = 0; i < raw.length; i += size) {
    const bucket = raw.slice(i, i + size);
    points.push({
      ts: bucket[0]!.ts,
      rx_mbps: bucket.reduce((n, p) => n + p.rx_mbps, 0) / bucket.length,
      tx_mbps: bucket.reduce((n, p) => n + p.tx_mbps, 0) / bucket.length,
    });
  }
  if (points[points.length - 1]!.ts !== end) points.push(raw[raw.length - 1]!);
  return { points, downMB, upMB, message: '' };
}
export function demoOverview(poe = false): Overview {
  const pings = Array.from({ length: 24 * 12 }, (_, i) => ({
    ts: end - day + (i + 1) * 5 * minute, rtt: i === 214 ? 89 : 8 + 2 * Math.sin(i / 3), loss: 0,
  }));
  pings[pings.length - 1]!.rtt = 8;
  return {
    ...emptyOverview(), demo: true, source: '演示数据', site: '家庭网络', end, lastSample: end, online: true,
    historyRouterId: poe ? 'demo-rb5009-poe' : 'demo-rb5009',
    model: poe ? 'RB5009UPr+S+IN' : 'RB5009UG+S+IN', version: '7.20.4', uptime: '2w3d6h12m', cpu: 12, memory: 34,
    maintenance: {routerId:'demo-rb5009', routerName:'家庭网关', canWrite:true, latest:'7.20.5', available:true,
      channel:'stable', status:'New version is available', boot:{current:'7.20.4',latest:'7.20.4',available:false}},
    iface: 'ether1', address: '203.0.113.24', down: 186.4, up: 36.8, latency: 8, loss: 0, pingTarget: '223.5.5.5',
    clients, clientReady: true, clientsAsOf: end, pings, history: demoHistory(defaultTrafficRange), ports: demoPorts(poe),
    logs: [
      { time: '2026-11-17 09:46:12', topics: 'dhcp,info', message: 'defconf assigned 192.168.88.24 for 02:50:09:00:00:11 Mac-mini', severity: 'info' },
      { time: '2026-11-17 09:32:08', topics: 'system,info,account', message: 'user admin logged out from 192.168.88.24 via winbox', severity: 'info' },
      { time: '2026-11-17 09:28:41', topics: 'system,info,account', message: 'user admin logged in from 192.168.88.24 via winbox', severity: 'info' },
      { time: '2026-11-17 09:14:23', topics: 'dhcp,info', message: 'defconf assigned 192.168.88.10 for 02:50:09:00:00:12 Synology-NAS', severity: 'info' },
      { time: '2026-11-17 09:14:21', topics: 'interface,info', message: 'ether3 link up (speed 1G, full duplex)', severity: 'info' },
      { time: '2026-11-17 09:14:18', topics: 'interface,info', message: 'ether3 link down', severity: 'info' },
      { time: '2026-11-17 08:52:06', topics: 'dhcp,warning', message: 'Detected conflict by ARP response for 192.168.88.80 from 02:50:09:00:00:20', severity: 'warning' },
      { time: '2026-11-17 08:37:19', topics: 'dhcp,info', message: 'defconf assigned 192.168.88.38 for 02:50:09:00:00:13 Apple-TV', severity: 'info' },
      { time: '2026-11-17 08:37:16', topics: 'interface,info', message: 'ether4 link up (speed 100M, full duplex)', severity: 'info' },
      { time: '2026-11-16 23:50:03', topics: 'interface,info', message: 'ether4 link down', severity: 'info' },
    ],
  };
}

export function demoHistoryActions(state: Overview): GatewayHistoryActions & { selectRange(range: Range): void } {
  const key = 'overview:demo-history-cleared:' + state.historyRouterId;
  let cleared = false;
  try { cleared = sessionStorage.getItem(key) === '1'; } catch { /* Some file previews disable storage. */ }
  function clearSnapshot(): void {
    state.history = emptyHistory('暂无流量历史');
    state.ports = state.ports?.map(zeroPortTotals) ?? null;
    state.pings = []; state.latency = null; state.loss = null;
    state.clients = state.clients.filter(c => c.down !== null || c.up !== null).map(c => ({...c, presence: null, samples: []}));
  }
  if (cleared) clearSnapshot();
  return {
    async preview(id) {
      if (id !== state.historyRouterId) throw new Error('所选网关已变更。');
      return cleared ? 0 : null;
    },
    async clear(id, confirmation) {
      if (id !== state.historyRouterId || confirmation !== '确认') throw new Error('请重新确认网关。');
      cleared = true;
      try { sessionStorage.setItem(key, '1'); } catch { /* The in-memory preview still clears. */ }
      clearSnapshot();
    },
    selectRange(range) { if (!cleared) state.history = demoHistory(range); },
  };
}

// Only the offline fixture uses simulated time and session storage.
export function demoGateway(state: Overview, render: () => void): SubmitGateway {
  type Action = 'upgrade' | 'fwupgrade' | 'reboot';
  type Flow = { action: Action; started: number; rebootAt?: number };
  type Saved = { os?: boolean; boot?: boolean; flow?: Flow };
  const key = 'overview:demo-maintenance:2:' + state.model;
  const m = state.maintenance, latest = m.latest;
  let saved: Saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(key) || '{}') || {}; } catch { /* Storage is optional for file previews. */ }
  function save(): void {
    try { sessionStorage.setItem(key, JSON.stringify(saved)); } catch { /* Still works in this tab. */ }
  }
  function versions(): void {
    if (saved.os) {
      state.version = latest; m.available = false; m.status = 'System is already up to date';
      if (m.boot) { m.boot.latest = latest; m.boot.available = !saved.boot; }
    }
    if (saved.boot && m.boot) m.boot.current = m.boot.latest;
  }
  versions();
  const steps = [[0, undefined], [1400, 18], [3200, 46], [5300, 73], [7100, 100]] as const;
  function advance(): void {
    const flow = saved.flow, job = state.gatewayJob;
    if (!flow || !job) return;
    const now = Date.now(), elapsed = Math.max(0, now - flow.started);
    if (flow.rebootAt != null) {
      const since = now - flow.rebootAt;
      if (since >= 2200) {
        if (flow.action === 'upgrade') saved.os = true;
        if (flow.action === 'fwupgrade') saved.boot = true;
        versions();
        state.online = true; state.uptime = '0s'; state.source = '演示数据';
        observeGateway(state);
        if (flow.action === 'reboot') { job.phase = 'done'; job.message = '网关已重启并重新上线。'; }
        delete saved.flow; save();
      } else {
        job.rebooting = true; job.wentOffline = since >= 450;
        state.online = !job.wentOffline;
        setTimeout(advance, (since < 450 ? 450 : 2200) - since);
      }
    } else {
      const os = flow.action === 'upgrade';
      const stage = os ? elapsed >= 8000 ? 'downloaded' : 'downloading' : elapsed >= 550 ? 'staged' : 'requested';
      const step = [...steps].reverse().find(([at]) => elapsed >= at);
      const percent = stage === 'downloading' ? step?.[1] : undefined;
      syncGatewayProgress(state, {kind:os ? 'routeros' : 'routerboot', startedAt:flow.started, updatedAt:now,
        from:job.target.from, target:job.target.to, stage, percent});
      const next = os ? steps.find(([at]) => at > elapsed)?.[0] ?? 8000 : 550;
      if (next > elapsed) setTimeout(advance, next - elapsed);
    }
    render();
  }
  const flow = saved.flow;
  if (flow && Number.isFinite(flow.started) && ['upgrade', 'fwupgrade', 'reboot'].includes(flow.action)) {
    const target = gatewayTarget(state, flow.action);
    if (target && beginGateway(state, target, '确认')) {
      state.gatewayJob!.started = flow.started;
      gatewayAccepted(state);
      queueMicrotask(advance);
    }
  }
  return (target, typed) => {
    if (!state.demo || !beginGateway(state, target, typed)) return false;
    const now = Date.now();
    if (target.preparedAt && saved.flow) saved.flow.rebootAt = now;
    else saved.flow = {action:target.action, started:now, rebootAt:target.action === 'reboot' ? now : undefined};
    save(); gatewayAccepted(state); advance();
    return true;
  };
}
