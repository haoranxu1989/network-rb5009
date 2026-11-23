import { esc } from './format';
import { clientRateChart, drawChart } from './chart';
import { clock, compactUptime, dataSize, defaultTrafficRange, durations, emptyOverview, numberText, type Client, type OverviewPage, type Range } from './data';
import { clientVolume, clientWave, confirmedStart, presenceText } from './clients';
import { demoGateway, demoHistoryActions, demoOverview } from './demo';
import { historyResetPanel, storedHistoryActions } from './history-reset';
import { gatewayPanel } from './gateway-panel';
import { actionNames, bareVersion, gatewayTarget, gatewayTaskLabel, isPending, readyToReboot, singleGatewayUpdate, type GatewayJob, type SubmitGateway } from './maintenance';
import { icon, mountIcons, type IconName } from './icons';
import { liveOverview } from './live';
import { logPage } from './logs';
import { portDetail, portKey, portLegend, portMap, portRows } from './ports';
import { powerSummary } from './portpower';
import { qualityBands, qualityLabels, qualityLevel, qualityTones } from './quality';
import { trafficMetric } from './traffic-metric';

mountIcons();
const demo = location.protocol === 'file:' || location.pathname === '/demo';
const state = demo ? demoOverview(new URLSearchParams(location.search).get('demo') === 'poe') : emptyOverview();
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
if (demo) {
  const link = $<HTMLAnchorElement>('port-demo-link');
  link.hidden = false;
  if (state.model === 'RB5009UPr+S+IN') {
    link.href = '?demo=gateway#ports';
    link.textContent = '网关示例';
  }
}
const dialog = $<HTMLDialogElement>('details');
const content = $('drawer-content');
const clientSearch = $<HTMLInputElement>('client-search');
let range: Range = defaultTrafficRange;
let page: OverviewPage = 'overview';
const demoHistory = demo ? demoHistoryActions(state) : null;
let historyCleared = (_id: string, _at: number): void => {};
const historyActions = demoHistory ?? storedHistoryActions((id, at) => historyCleared(id, at));
const renderHistoryActions = historyResetPanel(state, {
  preview: historyActions.preview,
  async clear(id, confirmation) { await historyActions.clear(id, confirmation); schedule(); },
});
const renderLogs = logPage(state);
let screen: 'client' | 'port' | 'gateway' = 'client';
let selectedPort = '', expandedPorts = false;
let clientId = '', expandedClients = false;
let drawClientRates: ReturnType<typeof clientRateChart> | undefined;
let refreshLive = (): void => {};
let setLivePage = (_next: OverviewPage): void => {};
let submitGateway: SubmitGateway = demo ? demoGateway(state, schedule) : () => false;
const gateway = gatewayPanel(state, (target, typed) => submitGateway(target, typed), () => {
  if (dialog.open) dialog.close();
  requestAnimationFrame(() => $('task-open').focus({preventScroll:true}));
});
let frame = 0;
const text = (id: string, value: string): void => {
  const node = $(id);
  if (node.textContent !== value) node.textContent = value;
};
function paintHTML(node: HTMLElement, html: string): void {
  if (painted.get(node) === html) return;
  node.innerHTML = html;
  painted.set(node, html);
}
const painted = new WeakMap<HTMLElement, string>();
function deviceIcon(name: IconName): string { return '<span class="device-icon">' + icon(name) + '</span>'; }
function clientMetric(c: Client, dir: 'down' | 'up', volume: ReturnType<typeof clientVolume>): string {
  const secs = Math.floor(volume.coveredMs / 1000);
  const span = secs >= 3600 ? '1 小时' : secs >= 60 ? Math.floor(secs / 60) + ' 分钟' : secs + ' 秒';
  const amount = dir === 'down' ? volume.downMB : volume.upMB;
  return trafficMetric(c[dir], volume.coveredMs ? amount : null, volume.coveredMs ? span + '约' : '近 1 小时',
    volume.coveredMs ? '近 1 小时内按连续采样速率估算，有效采样 ' + Math.floor(secs / 60) + ' 分 ' + secs % 60 + ' 秒。' : '近 1 小时内缺少连续采样。');
}

function renderQuality(): void {
  const target = $('quality-target');
  text('quality-target', state.pingTarget);
  target.hidden = !state.pingTarget;
  target.title = 'Ping 探测目标 ' + state.pingTarget;
  const end = Math.max(state.end, state.lastSample ?? 0, state.pings[state.pings.length - 1]?.ts ?? 0);
  const start = end - durations['24h'];
  const levels = qualityBands(state.pings, end);
  const span = durations['24h'] / levels.length;
  const counts = qualityLabels.map((label, i) => label + ' ' + levels.filter(level => level === i).length + ' 段');
  $('health').setAttribute('aria-label', '近 24 小时连通性，每格 30 分钟。' + counts.join('，') + '。');
  paintHTML($('health'), levels.map((level, i) => '<i class="' + qualityTones[level] + '" title="' +
    clock(start + span * i) + ' – ' + clock(start + span * (i + 1)) + ' · ' + qualityLabels[level] + '"></i>').join(''));
}
function observedDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function presenceCell(c: Client): string {
  const start = confirmedStart(c.presence, state.clientsAsOf);
  const tip = start ? '本次上线于 ' + observedDate(start) : c.presence ? '最近在线于 ' + observedDate(c.presence.lastSeen) : '后台还没有这台设备的在线记录';
  return '<span class="session-time" title="' + esc(tip) + '">' + presenceText(c.presence, state.clientsAsOf) + '</span>';
}
function paintClientRows(node: HTMLElement, html: string): void {
  const id = node.contains(document.activeElement) ? document.activeElement?.closest<HTMLElement>('[data-client]')?.dataset.client : undefined;
  paintHTML(node, html);
  if (id && !node.contains(document.activeElement)) {
    const row = node.querySelector<HTMLElement>('[data-client="' + CSS.escape(id) + '"]');
    (row?.matches('button') ? row : row?.querySelector('button'))?.focus({ preventScroll: true });
  }
}
function renderClients(): void {
  text('client-count', state.clientReady ? String(state.clients.length) : '—');
  const toggle = $('clients-toggle');
  toggle.hidden = !expandedClients && state.clients.length <= 5;
  toggle.setAttribute('aria-expanded', String(expandedClients));
  text('clients-toggle-label', expandedClients ? '收起明细' : '展开明细');
  $('client-filter').hidden = !expandedClients;
  const term = clientSearch.value.trim().toLowerCase();
  const visible = expandedClients ? state.clients.filter(c =>
    !term || [c.name, c.ip, c.mac].some(v => v.toLowerCase().includes(term))) : state.clients.slice(0, 5);
  const rows = visible.map(c => {
    const id = esc(c.id);
    const volume = clientVolume(c.samples, state.clientsAsOf);
    return '<tr data-client="' + id + '"><td><button class="device-cell" aria-label="查看 ' + esc(c.name) + ' 详情">' + deviceIcon(c.icon) + '<span class="client-name"><span class="name">' + esc(c.name) + '</span><small class="mobile-presence">' + presenceText(c.presence, state.clientsAsOf) + '</small></span></button></td>' +
      '<td class="client-ip">' + esc(c.ip || '—') + '</td><td class="session-col">' + presenceCell(c) + '</td>' +
      '<td class="wave-col"><span class="row-wave">' + clientWave(c.samples, state.clientsAsOf) + '</span></td>' +
      '<td class="numeric client-rate">' + clientMetric(c, 'down', volume) + '</td><td class="numeric client-rate">' + clientMetric(c, 'up', volume) + '</td></tr>';
  }).join('');
  paintClientRows($('client-rows'), rows || '<tr><td class="empty" colspan="6">' + (expandedClients && term ? '没有匹配的设备' : state.clientReady ? '暂无可显示的客户端' : '等待客户端数据') + '</td></tr>');
}
function renderPorts(): void {
  const ports = state.ports;
  const hasPorts = !!ports?.length;
  const expanded = hasPorts && expandedPorts;
  const toggle = $('port-table-toggle');
  toggle.hidden = !hasPorts;
  toggle.setAttribute('aria-expanded', String(expanded));
  text('port-toggle-label', expanded ? '收起明细' : '展开明细');
  text('ports-count', hasPorts ? ports.filter(p => p.running && !p.disabled).length + ' / ' + ports.length + ' 已连接' : '');
  $('port-table').hidden = !expanded;
  $('port-key').hidden = !hasPorts;
  $('port-poe-col').hidden = !ports?.some(p => p.poe?.output);
  const total = $('port-power-total'), summary = hasPorts ? powerSummary(ports) : '';
  total.hidden = !summary;
  paintHTML(total, summary);
  const fallback = state.online === false ? '网关已离线' : ports === null ? '暂无可读的端口数据' : '未检测到物理端口';
  const map = $('port-map');
  const focusedTile = map.contains(document.activeElement) ? document.activeElement?.closest<HTMLElement>('[data-port]')?.dataset.port : undefined;
  paintHTML(map, hasPorts ? portMap(ports, state.wanPort || state.iface, demo) : '<p class="empty">' + fallback + '</p>');
  if (focusedTile && !map.contains(document.activeElement)) {
    map.querySelector<HTMLButtonElement>('[data-port="' + CSS.escape(focusedTile) + '"]')?.focus({preventScroll: true});
  }
  paintHTML($('port-legend'), hasPorts ? portLegend(ports) : '');
  const rows = $('port-rows');
  const focused = rows.contains(document.activeElement) ? document.activeElement?.closest<HTMLElement>('[data-port]')?.dataset.port : undefined;
  paintHTML(rows, expanded ? portRows(ports) : '');
  if (focused && !rows.contains(document.activeElement)) {
    rows.querySelector<HTMLButtonElement>('tr[data-port="' + CSS.escape(focused) + '"] button')?.focus({preventScroll: true});
  }
}
function specRows(rows: Array<[string, string]>): string {
  return '<dl class="drawer-specs">' + rows.map(([label, value]) => '<div><dt>' + esc(label) + '</dt><dd>' + esc(value || '—') + '</dd></div>').join('') + '</dl>';
}
function renderDrawer(): void {
  if (!dialog.open) return;
  const managing = screen === 'gateway';
  content.hidden = managing;
  $('gateway-panel').hidden = !managing;
  if (managing) {
    text('drawer-title', '网关管理');
    gateway.render();
  } else if (screen === 'client') {
    text('drawer-title', '客户端详情');
    const c = state.clients.find(row => row.id === clientId);
    if (!c) { paintHTML(content, '<p class="empty">此设备已离开当前客户端列表</p>'); return; }
    const start = confirmedStart(c.presence, state.clientsAsOf);
    const specs: Array<[string, string]> = [['IP 地址', c.ip], ['MAC 地址', c.mac], ['连接', c.connection]];
    if (start) specs.push(['连接时长', presenceText(c.presence, state.clientsAsOf)], ['本次上线', observedDate(start)]);
    specs.push(['最近在线', c.presence?.lastSeen ? observedDate(c.presence.lastSeen) : '暂无记录']);
    const volume = clientVolume(c.samples, state.clientsAsOf);
    if (!$('client-rate-chart')) {
      const template = $<HTMLTemplateElement>('client-detail-template');
      content.replaceChildren(template.content.cloneNode(true));
      painted.delete(content);
      drawClientRates = clientRateChart($('client-rate-chart'));
    }
    paintHTML($('client-identity'), '<div class="detail-device">' + deviceIcon(c.icon) + '<div><h3>' + esc(c.name) + '</h3><span class="subtle">' + esc(c.status) + '</span></div></div>' + specRows(specs));
    paintHTML($('client-detail-rates'), '<div><span class="wave-down">↓ 下载速率</span>' + clientMetric(c, 'down', volume) +
      '</div><div><span class="wave-up">↑ 上传速率</span>' + clientMetric(c, 'up', volume) + '</div>');
    drawClientRates?.(c.samples, state.clientsAsOf);
  } else if (screen === 'port') {
    text('drawer-title', '端口详情');
    const port = state.ports?.find(p => portKey(p) === selectedPort);
    paintHTML(content, port ? portDetail(port, state.wanPort || state.iface) : '<p class="empty">当前没有这个端口的采样</p>');
  }
}
function openDrawer(next: typeof screen): void {
  screen = next;
  if (!dialog.open) dialog.showModal();
  renderDrawer();
  $('drawer-close').focus();
}

function renderGatewayActions(): void {
  const { maintenance, gatewayJob, online } = state;
  const running = isPending(gatewayJob) ? gatewayJob?.target.action : undefined;
  const restarting = running === 'reboot' || (!!running && (gatewayJob?.rebooting || gatewayJob?.progress?.stage === 'restarting'));
  const upgrading = running === 'upgrade' || running === 'fwupgrade';
  const status = $('gateway-status');
  status.title = online !== true && !demo ? state.source : '';
  text('gateway-status', restarting ? '重启中' : online === true ? '在线' : online === false ? '离线' : '等待数据');
  status.className = 'dot-label ' + (restarting ? 'busy' : online === true ? 'good' : online === false ? 'bad' : 'neutral');

  const reboot = $<HTMLButtonElement>('gateway-reboot');
  reboot.disabled = !gatewayTarget(state, 'reboot');

  const update = $<HTMLButtonElement>('gateway-update');
  update.hidden = !upgrading && (online !== true || !(maintenance.available || maintenance.boot?.available));
  const action = singleGatewayUpdate(maintenance);
  const target = action && gatewayTarget(state, action);
  const label = upgrading ? '查看升级进度' : target ? actionNames[target.action] + ' 至 ' + target.to : '查看可用更新';
  update.setAttribute('aria-label', label);
  update.title = label;
}
let fadingSuccess: GatewayJob | null = null;
function renderTask(): void {
  const job = state.gatewayJob, container = $('maintenance-task');
  container.hidden = !job;
  if (!job) return;
  if (job.phase === 'done' && job.target.action !== 'reboot' && fadingSuccess !== job) {
    fadingSuccess = job;
    window.setTimeout(() => {
      if (fadingSuccess === job) fadingSuccess = null;
      if (state.gatewayJob === job && job.phase === 'done') { state.gatewayJob = null; render(); }
    }, 2000);
  }
  const pending = isPending(job);
  const downloading = pending && !job.wentOffline && job.progress?.stage === 'downloading';
  const percent = downloading ? job.progress?.percent : null;
  const amount = percent != null ? percent + '%' : downloading ? job.progress?.downloaded || '' : '';
  const phase = gatewayTaskLabel(job);
  const label = (demo ? '模拟 · ' : '') + phase;
  text('task-stage', label);
  text('task-percent', amount);
  $('task-percent').hidden = !amount;
  const bar = $<HTMLProgressElement>('task-progress');
  bar.hidden = !downloading;
  if (percent == null) bar.removeAttribute('value'); else bar.value = percent;
  const symbol: IconName = job.phase === 'done' ? 'check' : job.phase === 'error' || job.phase === 'unknown' ? 'notice' :
    job.wentOffline || job.target.action === 'reboot' ? 'restart' : job.target.action === 'upgrade' ? 'download' : 'upgrade';
  paintHTML($('task-symbol'), icon(symbol));
  container.dataset.phase = job.phase;
  $('task-open').title = job.message;
  $('task-open').setAttribute('aria-label', label + (amount ? ' ' + amount : '') + '，查看详情');
  $('task-dismiss').hidden = pending;
  const restart = $('task-reboot');
  restart.hidden = !readyToReboot(job) || !gatewayTarget(state, 'reboot');
  text('task-reboot', job.target.action === 'fwupgrade' ? '重启生效' : '重启安装');
}
function render(): void {
  renderTask();
  renderHistoryActions();
  gateway.renderConfirmation();
  if (page === 'logs') { renderLogs(); renderDrawer(); return; }
  const latest = qualityLevel(state.latency, state.loss);
  const degraded = (state.loss ?? 0) > 0 ? '最近采样有丢包' : '最近采样延迟偏高';
  text('health-text', ['暂无质量采样', '最近采样正常', degraded, '最近采样不可达'][latest]!);
  $('health-text').className = 'health-status ' + qualityTones[latest];
  renderGatewayActions();
  text('model', state.model || '等待设备信息');
  const photo = $<HTMLImageElement>('product-photo');
  const pictures = document.body.dataset;
  const source = /^RB5009UG\+S\+?(IN)?$/i.test(state.model) ? pictures.gatewayImage :
    /^RB5009UPr\+S\+(?:IN)?$/i.test(state.model) ? pictures.poeGatewayImage : undefined;
  if (source && photo.getAttribute('src') !== source) photo.src = source;
  photo.hidden = !source; $('generic-router').hidden = !!source;
  text('version', state.version ? 'RouterOS ' + bareVersion(state.version) : '—');
  $('version').title = state.version ? '查看版本详情 · RouterOS ' + state.version : '查看版本详情';
  text('uptime', compactUptime(state.uptime));
  for (const [id, value] of [['cpu', state.cpu], ['memory', state.memory]] as const) {
    text(id + '-value', value === null ? '—' : numberText(value, 0) + '%');
    const meter = $<HTMLProgressElement>(id);
    if (value === null) meter.removeAttribute('value'); else meter.value = value;
  }
  text('down', numberText(state.down)); text('up', numberText(state.up));
  text('interface', state.iface ? 'WAN · ' + state.iface : 'WAN');
  text('sample-time', state.lastSample ? '采样于 ' + clock(state.lastSample, true) : '');
  text('down-total', dataSize(state.history.downMB)); text('up-total', dataSize(state.history.upMB));
  text('latency', numberText(state.latency)); text('loss', numberText(state.loss)); text('wan-ip', state.address || '—');
  drawChart(state, range); renderQuality(); renderClients(); renderPorts(); renderDrawer();
}
function schedule(): void {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
}
document.addEventListener('click', ev => {
  const element = ev.target;
  if (!(element instanceof Element)) return;
  const port = element.closest<HTMLElement>('[data-port]');
  if (port) { selectedPort = port.dataset.port!; openDrawer('port'); return; }
  const client = element.closest<HTMLElement>('[data-client]');
  if (client) { clientId = client.dataset.client!; openDrawer('client'); return; }
  const button = element.closest<HTMLButtonElement>('button');
  if (!button) return;
  if (button.id === 'port-table-toggle') { expandedPorts = !expandedPorts; renderPorts(); return; }
  if (button.id === 'clients-toggle') {
    expandedClients = !expandedClients;
    if (!expandedClients) clientSearch.value = '';
    renderClients();
    return;
  }
  if (button.dataset.range) {
    const next = button.dataset.range as Range;
    if (next === range) return;
    range = next;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-range]')) b.setAttribute('aria-pressed', String(b.dataset.range === range));
    if (demoHistory) demoHistory.selectRange(range); else refreshLive();
    render(); return;
  }
  if (button.id === 'gateway-update' || button.id === 'gateway-reboot' || button.id === 'task-reboot') {
    const action = button.id === 'gateway-update' ? singleGatewayUpdate(state.maintenance) : 'reboot';
    if (action && gatewayTarget(state, action)) gateway.reviewAction(action);
    else if (button.id === 'gateway-update') openDrawer('gateway');
    return;
  }
  if (button.id === 'task-dismiss' && !isPending(state.gatewayJob)) { state.gatewayJob = null; render(); return; }
  if (button.dataset.open === 'gateway') { openDrawer('gateway'); return; }
  if (button.id === 'drawer-close') dialog.close();
});
clientSearch.addEventListener('input', renderClients);
dialog.addEventListener('close', () => {
  content.replaceChildren();
  painted.delete(content);
  drawClientRates = undefined;
  if (screen === 'client' && page === 'overview' && document.activeElement === document.body) {
    $('client-rows').querySelector<HTMLButtonElement>('[data-client="' + CSS.escape(clientId) + '"] button')?.focus({preventScroll: true});
  }
});
dialog.addEventListener('click', e => {
  if (e.target !== dialog) return;
  const r = dialog.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
});
function route(navigated: boolean): void {
  page = location.hash === '#logs' ? 'logs' : 'overview';
  if (dialog.open) dialog.close();
  $('overview').hidden = page !== 'overview';
  $('logs').hidden = page !== 'logs';
  document.title = (page === 'logs' ? 'RouterOS 日志' : '网络总览') + ' · Network';
  $<HTMLAnchorElement>('skip-content').hash = page;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.rail-item')) {
    const selected = link.hash === '#' + page;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  setLivePage(page);
  if (!demo && page !== 'logs') renderLogs();
  render();
  if (navigated) {
    const target = document.getElementById(location.hash.slice(1)) ?? $(page);
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}
if (!demo) {
  const live = liveOverview(state, () => range, schedule);
  refreshLive = live.refreshHistory;
  historyCleared = live.historyCleared;
  setLivePage = live.setPage;
  submitGateway = live.submitGateway;
}
route(false);
window.addEventListener('hashchange', () => route(true));
