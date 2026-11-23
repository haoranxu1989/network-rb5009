import { physicalPorts } from './ports';
import { durations, emptyOverview, emptyHistory, type Overview, type OverviewPage, type Range } from './data';
import { beginGateway, expireGateway, gatewayAccepted, gatewayFailure, isPending, observeGateway, syncGatewayProgress, type SubmitGateway } from './maintenance';
import type { PackageUpgradeProgress } from './types';

type Snapshot = Omit<Overview, 'demo' | 'gatewayJob'> & {
  progress: PackageUpgradeProgress | null;
  sync?: { cursor: string; incremental: boolean; bucketMs: number };
};

function mergePoints<T extends {ts: number}>(previous: T[], incoming: T[], start: number, bucket = 1): T[] {
  const points = new Map<number, T>();
  for (const point of [...previous, ...incoming]) {
    if (point.ts >= start) points.set(Math.floor(point.ts / bucket), point);
  }
  return [...points.values()].sort((a, b) => a.ts - b.ts);
}

export function mergeSnapshot(previous: Overview, incoming: Snapshot, span: Range): Snapshot {
  if (!incoming.sync?.incremental) return incoming;
  const clients = new Map(previous.clients.map(client => [client.id, client]));
  return {
    ...incoming,
    history: {...incoming.history, points: mergePoints(previous.history.points, incoming.history.points,
      incoming.end - durations[span] + 1, incoming.sync.bucketMs)},
    pings: mergePoints(previous.pings, incoming.pings, incoming.end - durations['24h']),
    clients: incoming.clients.map(client => {
      const samples = mergePoints(clients.get(client.id)?.samples ?? [], client.samples, incoming.clientsAsOf - durations['1h']);
      // The first visible sample begins a segment even after older points expire.
      if (samples[0]) samples[0] = {...samples[0], gap: true};
      return {...client, samples};
    }),
  };
}

export function liveOverview(state: Overview, range: () => Range, render: () => void) {
  let page: OverviewPage = 'overview', generation = 0, timer = 0;
  let cursor = '', cachedRange: Range | undefined;
  let current: AbortController | undefined;
  async function refresh() {
    const version = ++generation;
    current?.abort();
    const controller = new AbortController();
    current = controller;
    window.clearTimeout(timer);
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const span = range();
    const query = new URLSearchParams({range: span, page});
    if (cursor && cachedRange === span) query.set('cursor', cursor);
    try {
      const res = await fetch('/api/overview?' + query, {
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const incoming: Snapshot = await res.json();
      if (version !== generation) return;
      const {progress, sync, ...snapshot} = mergeSnapshot(state, incoming, span);
      cursor = sync?.cursor ?? '';
      cachedRange = span;
      Object.assign(state, snapshot, { ports: snapshot.ports && physicalPorts(snapshot.ports) });
      if (!state.online && isPending(state.gatewayJob)) state.gatewayJob!.wentOffline = true;
      syncGatewayProgress(state, progress);
      observeGateway(state);
    } catch {
      if (version !== generation) return;
      cursor = '';
      const job = state.gatewayJob;
      if (job && isPending(job)) job.wentOffline = true;
      Object.assign(state, emptyOverview(), { gatewayJob: job, source: '暂时无法连接 Network 服务' });
    } finally {
      window.clearTimeout(timeout);
      if (version === generation) {
        expireGateway(state);
        render();
        timer = window.setTimeout(refresh, page === 'overview' ? 3000 : 5000);
      }
    }
  }
  const submitGateway: SubmitGateway = (target, typed) => {
    if (!beginGateway(state, target, typed)) return false;
    const job = state.gatewayJob!;
    render();
    void (async () => {
      try {
        const res = await fetch('/api/gateway/action', {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({target, confirm: typed ?? '确认'}), credentials: 'same-origin'});
        const reply = await res.json();
        if (state.gatewayJob !== job) return;
        if (!res.ok) { job.phase = 'error'; job.message = gatewayFailure(reply.error); }
        else gatewayAccepted(state);
      } catch { job.phase = 'unknown'; job.message = '未收到提交结果，请核对网关状态。'; }
      render();
      void refresh();
    })();
    return true;
  };
  return {
    refreshHistory: refresh, setPage(next: OverviewPage) { page = next; void refresh(); }, submitGateway,
    historyCleared(id: string, _at: number) {
      if (state.historyRouterId !== id) return;
      cursor = '';
      state.history = emptyHistory(); state.clients = []; state.pings = [];
      void refresh();
    },
  };
}
