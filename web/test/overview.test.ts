import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactUptime, emptyOverview, type Range } from '../data';
import { demoHistory, demoHistoryActions, demoOverview } from '../demo';
import { storedHistoryActions } from '../history-reset';
import { physicalPorts, portDetail, portLegend, portLink, portMap, portRows } from '../ports';
import { facePower, powerSummary, powerText } from '../portpower';
import { sampleIndexAt } from '../rate-cursor';
import { beginGateway, expireGateway, gatewayAccepted, gatewayTarget, observeGateway, readyToReboot, singleGatewayUpdate, syncGatewayProgress } from '../maintenance';
import { qualityBands, qualityLevel } from '../quality';
import { clientDetailRates, clientVolume, clientWave, clientWindowMs, presenceText } from '../clients';
import { ratePlot, rateScale } from '../rate-plot';
import { liveOverview, mergeSnapshot } from '../live';

test('incremental history replaces changing buckets, expires points, and preserves client gaps', () => {
  const previous = emptyOverview();
  const client = {...demoOverview().clients[0]!, id: 'c1', samples: [
    {ts: 18000, down: 1, up: 1, gap: true}, {ts: 27000, down: 2, up: 2, gap: false},
    {ts: 3_600_000, down: 3, up: 3, gap: true},
  ]};
  previous.clients = [client, {...client, id: 'removed'}];
  previous.history.points = [
    {ts: 14000, rx_mbps: 1, tx_mbps: 1}, {ts: 22000, rx_mbps: 2, tx_mbps: 2},
    {ts: 3_600_000, rx_mbps: 3, tx_mbps: 3},
  ];
  previous.pings = [{ts: -82_790_000, rtt: 10, loss: 0}, {ts: 3_600_000, rtt: 8, loss: 0}];
  const incoming = {
    ...emptyOverview(), end: 3_620_000, clientsAsOf: 3_620_000, progress: null,
    history: {points: [
      {ts: 22000, rx_mbps: 1.5, tx_mbps: 1.5}, {ts: 3_605_000, rx_mbps: 4, tx_mbps: 4},
      {ts: 3_620_000, rx_mbps: 5, tx_mbps: 5},
    ], downMB: 20, upMB: 30, message: ''},
    clients: [{...client, samples: [{ts: 3_620_000, down: 4, up: 5, gap: false}]}],
    pings: [{ts: 3_620_000, rtt: 9, loss: 0}],
    sync: {cursor: 'session:0:1h:3620000', incremental: true, bucketMs: 15000},
  };
  const merged = mergeSnapshot(previous, incoming, '1h');
  assert.deepEqual(merged.history, incoming.history);
  assert.deepEqual(merged.clients.map(c => c.id), ['c1']);
  assert.deepEqual(merged.clients[0]!.samples, [
    {ts: 27000, down: 2, up: 2, gap: true}, {ts: 3_600_000, down: 3, up: 3, gap: true},
    {ts: 3_620_000, down: 4, up: 5, gap: false},
  ]);
  assert.deepEqual(merged.pings, [previous.pings[1], incoming.pings[0]]);
  assert.equal(previous.clients[0]!.samples[1]!.gap, false);
  assert.deepEqual(mergeSnapshot({...previous, ...merged}, incoming, '1h'), merged);
  const reset = {...emptyOverview(), progress: null, sync: {...incoming.sync, incremental: false}};
  assert.deepEqual(mergeSnapshot({...previous, ...merged}, reset, '24h'), reset);
});

test('live refresh keeps its cadence and resets history cursors on range changes, failures and clearing', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const timers = new Map<number, number>();
  let timerId = 0;
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {
    setTimeout: (_fn: () => void, delay: number) => { timers.set(++timerId, delay); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  }});
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const calls: URLSearchParams[] = [];
  let span: Range = '1h';
  let failed = false;
  const response = {...emptyOverview(), historyRouterId: 'r1', online: true, progress: null,
    sync: {cursor: 'session:0:1h:100', incremental: false, bucketMs: 15000}};
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(new URL(url, 'http://localhost').searchParams);
    if (failed) throw new Error('fixture disconnect');
    return Response.json(response);
  });
  const state = emptyOverview();
  const live = liveOverview(state, () => span, () => {});
  await live.refreshHistory();
  assert.equal(calls.at(-1)!.get('cursor'), null);
  assert.deepEqual([...timers.values()], [3000]);
  await live.refreshHistory();
  assert.equal(calls.at(-1)!.get('cursor'), response.sync.cursor);
  span = '24h';
  response.sync.cursor = 'session:0:24h:100';
  await live.refreshHistory();
  assert.equal(calls.at(-1)!.get('cursor'), null);
  failed = true;
  await live.refreshHistory();
  assert.equal(state.clients.length, 0);
  failed = false;
  await live.refreshHistory();
  assert.equal(calls.at(-1)!.get('cursor'), null);
  live.historyCleared('r1', 100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1)!.get('cursor'), null);
  live.setPage('logs');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1)!.get('page'), 'logs');
  assert.deepEqual([...timers.values()], [5000]);

  let resolveOld!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => { resolveOld = resolve; });
  const pending = t.mock.method(globalThis, 'fetch', () => delayed);
  const oldRequest = live.refreshHistory();
  pending.mock.mockImplementation(async () => Response.json({...response, cpu: 77}));
  await live.refreshHistory();
  resolveOld(Response.json({...response, cpu: 12}));
  await oldRequest;
  assert.equal(state.cpu, 77);
});

test('client times use the saved start until confirmation expires, then the last actual sighting', () => {
  assert.equal(compactUptime('7209s'), '2 小时 0 分');
  assert.equal(compactUptime('1w2d03:04:05'), '9 天 3 小时');
  const now = 10_000_000;
  const record = { connectedAt: now - 3_661_000, lastSeen: now - 5000, validUntil: now + 60_000 };
  assert.equal(presenceText(record, now), '已连接 1 小时 1 分');
  assert.equal(presenceText(record, now + 60_000), '1 分钟前在线');
  assert.equal(presenceText({lastSeen: now - 28_000}, now), '刚刚在线');
  assert.equal(presenceText({lastSeen: now - 720_000}, now), '12 分钟前在线');
  assert.equal(presenceText(null, now), '暂无记录');
});

test('client volume integrates only sampled intervals within one hour, independently by direction', () => {
  const h = 3_600_000;
  const samples = [
    {ts: 0, down: 0, up: 8}, {ts: h, down: 8, up: 8},
    {ts: h + 1000, down: 0, up: 0, gap: true}, {ts: h + 2000, down: 0, up: 0},
  ];
  assert.deepEqual(clientVolume(samples, h), {downMB: 1800, upMB: 3600, coveredMs: h});
  assert.deepEqual(clientVolume(samples, h * 1.5), {downMB: 1350, upMB: 1800, coveredMs: h / 2 + 1000});
  assert.deepEqual(clientVolume(samples.slice(2), h + 2000), {downMB: 0, upMB: 0, coveredMs: 1000});
  assert.equal(clientVolume(samples.slice(0, 1), h).coveredMs, 0);

});

test('internet quality keeps a 24-hour window and the latest reading apart', () => {
  const end = 2 * 86400000, start = end - 86400000;
  const levels = qualityBands([
    { ts: start - 1, rtt: null, loss: 100 },
    { ts: start, rtt: 10, loss: 0 },
    { ts: start + 1800000, rtt: null, loss: 100 },
    { ts: start + 3600000, rtt: null, loss: null, permissionDenied: true },
    { ts: end - 1, rtt: 89, loss: 0 },
    { ts: end, rtt: 8, loss: 0 },
    { ts: end + 1, rtt: null, loss: 100 },
  ], end);
  assert.equal(levels.length, 48);
  assert.deepEqual(levels.slice(0, 3), [1, 3, 0]);
  assert.equal(levels[47], 2);
  assert.equal(qualityLevel(8, 0), 1);
  assert.equal(qualityLevel(null, null), 0);
});

test('the review snapshot has one WAN counter and nested history windows', () => {
  const data = demoOverview();
  assert.equal(data.ports!.length, 9);
  assert.equal(data.ports!.filter(p => p.running && !p.disabled).length, 6);
  for (const client of data.clients) {
    assert.match(client.connection, /ether\d/);
    if (client.down === null) {
      assert.equal(presenceText(client.presence, data.clientsAsOf), '12 分钟前在线');
      assert.equal(client.samples.length, 0);
      continue;
    }
    assert.equal(!!client.presence?.connectedAt, client.connection.includes('PPPoE'));
    assert.equal(client.samples[0]!.ts, data.clientsAsOf - clientWindowMs);
    assert.deepEqual(client.samples.at(-1), { ts: data.clientsAsOf, down: client.down, up: client.up });
  }
  assert.ok(data.logs!.length && data.logs!.every(e => !/Wi-Fi|无线|关联至/.test(e.message + e.topics)));
  assert.ok(data.ports!.every(p => !/无线/.test(p.comment)));
  const latest = data.history.points.at(-1)!;
  assert.equal(latest.ts, data.end);
  assert.equal(latest.rx_mbps, data.down);
  assert.equal(latest.tx_mbps, data.up);
  assert.deepEqual(data.history, demoHistory('1h'));
  const day = demoHistory('24h'), week = demoHistory('7d');
  for (const direction of ['down', 'up'] as const) {
    const key = direction === 'down' ? 'downMB' : 'upMB';
    assert.ok(data.history[key]! < day[key]!);
    assert.ok(day[key]! < week[key]!);
    const sum = data.clients.reduce((n, c) => n + (c[direction] ?? 0), 0);
    assert.ok(Math.abs(sum - data[direction]!) < 1e-6);
  }
});

test('history review scopes HTTP to one gateway and only a confirmed response clears the view', async t => {
  const result = t.mock.fn();
  const api = storedHistoryActions(result);
  const calls: Array<[string, string]> = [];
  const request = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    calls.push([url, options.method ?? 'GET']);
    if (options.method === 'POST') assert.equal(options.body, JSON.stringify({confirm: '确认'}));
    return Response.json(options.method === 'POST' ? {routerId:'r2', deleted:7, ts:123} : {routerId:'r2', total:7});
  });
  await assert.rejects(api.preview('  '));
  await assert.rejects(api.clear('r2', ''));
  assert.equal(calls.length, 0);
  assert.equal(await api.preview('r2'), 7);
  assert.equal(result.mock.callCount(), 0);
  await api.clear('r2', '确认');
  assert.deepEqual(result.mock.calls[0]!.arguments, ['r2',123]);
  assert.deepEqual(calls, [['/api/gateway/r2/history','GET'],['/api/gateway/r2/history','POST']]);
  request.mock.mockImplementation(async () => new Response(null, {status:403}));
  await assert.rejects(api.preview('r2'), /权限/);
  await assert.rejects(api.clear('r2', '确认'), /权限/);
  assert.equal(result.mock.callCount(), 1);
});

test('a cleared demo stays empty on reload and range changes, independently for each gateway', async t => {
  const saved = new Map<string,string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {configurable:true, value: {
    getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value),
  }});
  t.after(() => { if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  const state = demoOverview(true), actions = demoHistoryActions(state);
  const ports = state.ports, logs = state.logs;
  await assert.rejects(actions.clear('other', '确认'));
  await actions.clear(state.historyRouterId, '确认');
  assert.equal(await actions.preview(state.historyRouterId), 0);
  assert.ok(state.clients.length && state.clients.every(c => !c.presence && !c.samples.length));
  assert.equal(portRows(state.ports!).match(/累计 0 B/g)?.length, 2 * ports!.length);
  assert.deepEqual(state.ports!.map(p => [p.rxMbps, p.txMbps]), ports!.map(p => [p.rxMbps, p.txMbps]));
  assert.equal(state.logs, logs);
  const reopened = demoOverview(true), again = demoHistoryActions(reopened);
  assert.equal(portDetail(reopened.ports![0]!, '').match(/累计 0 B/g)?.length, 2);
  for (const range of ['1h','24h','7d'] as const) {
    again.selectRange(range);
    assert.equal(reopened.history.points.length, 0);
  }
  const other = demoOverview(); demoHistoryActions(other);
  assert.ok(other.history.points.length && other.pings.length);
  assert.match(portRows(other.ports!), /累计 4\.23 TB/);
});

test('port status, negotiated speed and traffic rate remain independent', () => {
  const fixture = demoOverview().ports!;
  const copper = {...fixture[0]!, name: 'fiber alias', defaultName: 'ether10', linkRate: undefined};
  assert.deepEqual(portLink(copper), {label: '速率未知', tone: 'unrated'});
  assert.equal(portLink({...copper, linkRate: '2500000000'}).label, '2.5 GbE');
  assert.equal(portLink({...copper, disabled: true, linkRate: '10Gbps'}).label, '已禁用');
  assert.equal(portLink({...copper, running: false, linkRate: '10Gbps'}).label, '未连接');
  assert.equal(portLink({...copper, linkRate: '0bps'}).label, '速率未知');
  const sorted = physicalPorts([fixture[8]!, copper, fixture[1]!, fixture[0]!]);
  assert.deepEqual(sorted.map(p => p.defaultName), ['ether1', 'ether2', 'ether10', 'sfp-sfpplus1']);
  const label = {...copper, name: 'WAN & LAN', comment: 'A "note"'};
  assert.ok(portMap([label], label.name, false).includes('WAN &amp; LAN'));
  assert.ok(portMap([label], label.name, false).includes('A &quot;note&quot;'));
  const missing = portDetail({...copper, ratesUnavailable: true, txBytes: null}, '');
  assert.match(missing, /接收速率<\/span><strong[^>]*>—<\/strong><small[^>]*>累计 4\.23 TB/);
  assert.match(missing, /累计 —/);
  assert.match(portRows([{...copper, rxMbps: 0, rxBytes: 0}]), />0 Mbps<\/strong><small[^>]*>累计 0 B/);
});

test('PoE marks output capability and delivery separately and shows only measured watts', () => {
  const sample = demoOverview(true).ports!;
  const active = sample[1]!, waiting = sample[0]!;
  const rendered = portMap(sample, 'ether1', true);
  for (const text of ['光猫', 'ether1', '2.5 GbE', 'WAN', '门口摄像机', '8.4', '5.2']) assert.ok(rendered.includes(text));
  assert.ok(powerSummary(sample).includes('13.6 W'));
  const whole = {...active, poe: {...active.poe, watts: 6}};
  assert.equal(powerText(whole), '6.0 W');
  assert.match(facePower(whole), /port-power-mark supplying/);
  assert.match(facePower(whole), /class="port-watts">6\.0 /);
  assert.match(portLegend(sample), /power-key supplying[\s\S]*power-key capable/);
  assert.ok(portRows([whole]).includes('<td class="poe-cell">6.0 W</td>'));
  assert.ok(portDetail(whole, '').includes('<dd>6.0 W</dd>'));
  assert.equal(powerText({...active, running:false}), '8.4 W');
  for (const status of ['short-circuit', 'waiting-for-load', 'disabled', 'unknown']) {
    const p = {...waiting, poe: {output: true, status, watts: 8.4}};
    assert.match(facePower(p), /port-power-mark capable/);
    assert.doesNotMatch(facePower(p), /port-watts/);
    assert.match(portRows([p]), /<td class="poe-cell"><\/td>/);
    assert.doesNotMatch(portDetail(p, ''), /<dt>PoE 输出<\/dt>/);
    assert.ok(!portMap([p], '', false).includes(status));
  }
  assert.match(portLegend([waiting]), /power-key capable/);
  assert.doesNotMatch(portLegend([waiting]), /power-key supplying/);
  for (const p of [sample.at(-1)!, {...active, poe:{input:true}}]) {
    assert.equal(facePower(p), '');
    assert.doesNotMatch(portLegend([p]), /power-key/);
  }
  const missing = {...active, poe:{output:true, status:'powered-on'}};
  for (const watts of [undefined, null, NaN, Infinity, -1]) {
    const p = {...missing, poe:{...missing.poe, watts}};
    assert.equal(powerText(p), '');
    assert.match(facePower(p), /port-power-mark supplying/);
    assert.doesNotMatch(facePower(p), /port-watts/);
  }
  assert.equal(powerText({...missing, poe:{...missing.poe, watts:0}}), '0.0 W');
  assert.equal(powerSummary([waiting, missing]), '');
  assert.ok(powerSummary([active, missing]).includes('PoE 已测输出'));
});

test('client list uses the last 15 minutes and the detail chart keeps the entire hour', () => {
  const minute = 60_000, end = 60 * minute;
  const samples = [{ts: 1, down: 98, up: 70}, {ts: 45 * minute, down: 4, up: 3}, {ts: end, down: 1, up: 2}];
  assert.match(clientWave(samples, end), /近 15 分钟，下载峰值速率 4 Mbps/);
  const detail = clientDetailRates([{ts: -1, down: 400, up: 0}, ...samples, {ts: end + 1, down: 0, up: 900}], end);
  assert.deepEqual(detail.points, samples);
  assert.equal(detail.start, 0);
  assert.deepEqual(detail.scale.labels, ['100', '75', '50', '25', '0']);
  assert.match(clientWave([samples[0]!], end), /暂无采样/);
});

test('client axes cover both directions with legible numbers for small and large rates', () => {
  const scale = (down: number, up: number) => rateScale([{ts: 1, down, up}], true);
  assert.deepEqual(scale(2, 55).labels, ['60', '45', '30', '15', '0']);
  for (const [peak, unit] of [[0.0002, 'bps'], [.42, 'kbps'], [1, 'Mbps'], [1250, 'Gbps']] as const) {
    const {top, labels, unit: actual} = scale(peak, 0);
    assert.equal(actual.label, unit);
    assert.ok(top >= peak);
    assert.equal(new Set(labels).size, 5);
  }
  assert.equal(scale(0, 0).top, 1);
  assert.deepEqual(rateScale([], true).labels, Array(5).fill('—'));
});

test('hour chart leaves gaps between segments and draws an isolated measurement as a dot', () => {
  const series = [0, 10, 60, 70, 100].map((ts, i) => ({ts, down: 2, up: 3, gap: i === 2 || i === 4}));
  const svg = ratePlot(series, 0, 100, 4, 'client');
  assert.equal(svg.match(/fill="url\(#client-down\)"/g)?.length, 2);
  assert.equal(svg.match(/fill="url\(#client-up\)"/g)?.length, 2);
  assert.equal(svg.match(/h0" stroke=/g)?.length, 2);
});

test('chart cursor selects an actual sample and skips unobserved time', () => {
  const p = (ts: number, gap = false) => ({ts, down: 1, up: 2, gap});
  const samples = [p(100, true), p(110), p(200, true), p(210)];
  assert.equal(sampleIndexAt([], 100, 2), -1);
  assert.equal(sampleIndexAt(samples, 106, 2), 1);
  assert.equal(sampleIndexAt(samples, 105, 2), 0);
  assert.equal(sampleIndexAt(samples, 155, 2), -1);
  assert.equal(sampleIndexAt(samples, 199, 2), 2);
  assert.equal(sampleIndexAt(samples, 95, 2), -1);
  assert.equal(sampleIndexAt(samples, 220, 2), -1);
  assert.equal(sampleIndexAt(samples, 101, 0), 0);
  assert.equal(sampleIndexAt(samples, 200, 0), 2);
});

test('the version icon opens a single upgrade or lets the user choose between two', () => {
  const s = demoOverview();
  assert.equal(singleGatewayUpdate(s.maintenance), 'upgrade');
  s.maintenance.boot = {current:'7.20.3', latest:'7.20.4', available:true};
  assert.equal(singleGatewayUpdate(s.maintenance), null);
  s.maintenance.available = false;
  assert.equal(singleGatewayUpdate(s.maintenance), 'fwupgrade');
  s.maintenance.boot = null;
  assert.equal(singleGatewayUpdate(s.maintenance), null);
});

test('a reboot or firmware update is complete only after fresh router evidence', () => {
  const s = demoOverview();
  const reboot = gatewayTarget(s, 'reboot')!;
  assert.ok(beginGateway(s, reboot));
  gatewayAccepted(s); observeGateway(s);
  assert.equal(s.gatewayJob!.phase, 'waiting');
  s.uptime = '14s'; observeGateway(s);
  assert.equal(s.gatewayJob!.phase, 'done');
  s.maintenance.boot = {current:'7.20.4',latest:'7.20.5',available:true};
  assert.ok(beginGateway(s, gatewayTarget(s, 'fwupgrade')!, '确认'));
  s.version = '7.20.5'; observeGateway(s);
  assert.equal(s.gatewayJob!.phase, 'sending');
  s.maintenance.boot.current = '7.20.5'; observeGateway(s);
  assert.equal(s.gatewayJob!.phase, 'done');
});

test('a fresh view restores a staged update and lets the operator restart even days later', () => {
  const s = demoOverview(), now = Date.now() - 3 * 86_400_000;
  const update = {kind:'routeros',from:'7.20.4',target:'7.20.5',startedAt:now,updatedAt:now,stage:'downloaded'};
  syncGatewayProgress(s, {...update, stage:'verified'});
  assert.equal(s.gatewayJob, null);
  syncGatewayProgress(s, update);
  s.gatewayJob!.observedAt = now;
  assert.equal(expireGateway(s), false);
  assert.equal(gatewayTarget(s,'upgrade'), null);
  assert.equal(gatewayTarget(s,'reboot')?.preparedAt, now);
  syncGatewayProgress(s, {...update,updatedAt:now-1,stage:'downloading',percent:99});
  assert.ok(readyToReboot(s.gatewayJob));
  s.maintenance.canWrite = false;
  assert.equal(gatewayTarget(s,'reboot'), null);
});
