import { esc } from './format';
import { type Port, numberText } from './data';
import { icon, type IconName } from './icons';
import { facePower, powerLabels, powerState, powerText } from './portpower';
import { trafficMetric } from './traffic-metric';

const byNumber = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const physicalType = /^(?:ether|ethernet|(?:q?sfp)(?:[-a-z0-9+]*))$/i;
export function physicalPorts(rows: readonly Port[]): Port[] {
  return rows.filter(p => !!p.name && (p.defaultName || physicalType.test(p.type))).sort((a, b) =>
    Number(isOptical(a)) - Number(isOptical(b)) || byNumber.compare(a.defaultName || a.name, b.defaultName || b.name));
}
function isOptical(p: Port): boolean {
  return /^(?:sfp|qsfp)/i.test(p.defaultName || p.name) || /sfp/i.test(p.type);
}
export function portLink(p: Port): {label: string; tone: string} {
  if (p.disabled) return {label: '已禁用', tone: 'disabled'};
  if (!p.running) return {label: '未连接', tone: 'down'};
  const raw = p.linkRate?.trim();
  const match = raw && /^(\d+(?:\.\d+)?)\s*([kmg]?)(?:bps|b\/s)?$/i.exec(raw);
  if (!match) return {label: '速率未知', tone: 'unrated'};
  const scales: Record<string, number> = { '': .000001, k: .001, m: 1, g: 1000 };
  const mbps = Number(match[1]) * scales[match[2]!.toLowerCase()]!;
  if (!Number.isFinite(mbps) || mbps <= 0) return {label: '速率未知', tone: 'unrated'};
  const label = mbps >= 1000 ? numberText(mbps / 1000, 2) + ' GbE' : numberText(mbps, 2) + ' Mbps';
  const tone = mbps >= 25000 ? 'ultra' : mbps >= 10000 ? 'ten' : mbps > 1000 ? 'multi' : mbps === 1000 ? 'giga' : 'fast';
  return {label, tone};
}
function portState(p: Port): string { return p.disabled ? '已禁用' : p.running ? '已连接' : '未连接'; }
export function portKey(p: Port): string { return p.id || p.name; }
export function zeroPortTotals(p: Port): Port {
  return { ...p, panelBytes: {rx: p.rxBytes == null ? null : 0, tx: p.txBytes == null ? null : 0} };
}
function shortSlot(p: Port): string {
  const factory = p.defaultName || p.name;
  const m = /^(?:ether(?:net)?|(?:q?sfp)[a-z0-9+-]*?)(\d+)$/i.exec(factory);
  return m ? (isOptical(p) ? 'S' : '') + m[1] : '';
}
function socketFace(p: Port): string {
  const jack = isOptical(p)
    ? '<path d="M3 6h26v13H3z M7 10h18v5H7z M13 19v2h6v-2"/>'
    : '<path d="M3 5h26v12h-6v4H9v-4H3z M7 5v5m3-5v5m3-5v5m3-5v5m3-5v5m3-5v5m3-5v5"/>';
  return '<span class="port-face port-' + portLink(p).tone + '"><span class="port-slot">' + esc(shortSlot(p)) +
    '</span><svg class="port-jack" aria-hidden="true" viewBox="0 0 32 26" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round" stroke-linecap="round">' + jack + '</svg>' + facePower(p) + '</span>';
}
const demoDevices: Record<string, IconName> = {
  ether1: 'globe', ether2: 'router', ether3: 'drive', ether4: 'tv', ether5: 'console', ether6: 'camera', 'sfp-sfpplus1': 'router',
};
function tile(p: Port, wan: string, demo: boolean): string {
  const link = portLink(p);
  const caption = p.comment || (p.name === wan ? 'WAN' : '');
  const captionIcon = caption && (demo ? demoDevices[p.name] : p.name === wan ? 'globe' : 'port');
  const stamp = p.name === wan ? '<small class="port-wan">WAN</small>' : '';
  const power = powerState(p);
  const label = [p.name, caption, portState(p), p.running && !p.disabled ? link.label : '', p.name === wan ? 'WAN' : '',
    power && powerLabels[power], powerText(p)].filter(Boolean).join('，');
  return '<button type="button" class="port-tile" data-port="' + esc(portKey(p)) + '" aria-haspopup="dialog" aria-label="' + esc(label) + '" title="' + esc(label) + '">' +
    '<span class="port-peer" title="' + esc(caption) + '">' + (captionIcon ? icon(captionIcon) : '') + '<span>' + esc(caption) + '</span></span>' +
    '<i class="port-stem' + (caption ? '' : ' blank') + '"></i>' + socketFace(p) +
    '<span class="port-alias" title="' + esc(p.name) + '">' + esc(p.name) + '</span>' +
    '<span class="port-footer-label">' + esc(link.label) + stamp + '</span></button>';
}
export function portMap(ports: Port[], wan: string, demo: boolean): string {
  return ports.map(p => tile(p, wan, demo)).join('');
}
export function portLegend(ports: Port[]): string {
  const links = [...new Map(ports.map(p => { const l = portLink(p); return [l.label, l] as const; })).values()];
  const order = ['fast', 'giga', 'multi', 'ten', 'ultra', 'unrated', 'down', 'disabled'];
  const speed = links.sort((a, b) => order.indexOf(a.tone) - order.indexOf(b.tone) || byNumber.compare(a.label, b.label))
    .map(l => '<span><i class="port-' + l.tone + '"></i>' + esc(l.label) + '</span>').join('');
  const states = new Set(ports.map(powerState));
  const power = (['supplying', 'capable'] as const).filter(s => states.has(s))
    .map(s => '<span class="power-key ' + s + '">' + icon('bolt') + powerLabels[s] + '</span>').join('');
  return speed + power;
}
function portMetric(p: Port, dir: 'rx' | 'tx'): string {
  const speed = dir === 'rx' ? p.rxMbps : p.txMbps;
  const bytes = p.panelBytes ? p.panelBytes[dir] : dir === 'rx' ? p.rxBytes : p.txBytes;
  const mbps = p.running && !p.disabled && !p.ratesUnavailable && Number.isFinite(speed) ? speed : null;
  const scope = p.panelBytes ? '上次清除面板历史后，按端口字节采样累计。' : 'RouterOS 接口字节计数，自上次计数器清零起。';
  return trafficMetric(mbps, bytes == null ? null : bytes / 1e6, '累计', scope);
}
export function portRows(ports: Port[]): string {
  const showPower = ports.some(p => p.poe?.output);
  return ports.map(p => '<tr data-port="' + esc(portKey(p)) + '"><td><button type="button" class="device-cell" aria-label="查看 ' + esc(p.name) + ' 端口详情">' +
    esc(p.name) + '</button></td><td class="port-note">' + esc(p.comment || '—') + '</td><td>' + portState(p) + '</td><td>' +
    (p.running && !p.disabled ? portLink(p).label : '—') + '</td>' +
    (showPower ? '<td class="poe-cell">' + powerText(p) + '</td>' : '') +
    '<td class="numeric">' + portMetric(p, 'rx') + '</td><td class="numeric">' + portMetric(p, 'tx') + '</td></tr>').join('');
}
export function portDetail(p: Port, wan: string): string {
  const link = portLink(p);
  const power = powerText(p);
  const pairs: Array<[string, string]> = [
    ['出厂端口名', p.defaultName || '—'], ['接口备注', p.comment || '—'],
    ['链路状态', portState(p)], ['协商速率', p.running && !p.disabled ? link.label : '—'],
    ...(power ? [['PoE 输出', power] as [string, string]] : []),
    ['错误 / 丢弃', numberText(p.errors, 0) + ' / ' + numberText(p.drops, 0)], ['链路中断次数', numberText(p.linkDowns, 0)],
    ['端口 MAC', p.macAddr || '—'], ['接口 IP', p.ips?.join('、') || '—'],
  ];
  return '<div class="port-detail-title">' + socketFace(p) + '<div><h3>' + esc(p.name) + '</h3><span class="subtle">' +
    [isOptical(p) ? 'SFP 接口' : '以太网接口', p.name === wan ? '当前 WAN' : ''].filter(Boolean).join(' · ') + '</span></div></div>' +
    '<div class="port-traffic-pair"><div><span>接收速率</span>' + portMetric(p, 'rx') + '</div><div><span>发送速率</span>' +
    portMetric(p, 'tx') + '</div></div><dl class="drawer-specs">' + pairs.map(([k, v]) =>
      '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl>';
}
