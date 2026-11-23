import type { TrafficPoint } from './types';
import { rateCursor } from './rate-cursor';
import { ratePlot, rateScale } from './rate-plot';
import { clock, durations, type ClientSample, type Overview, type Range } from './data';
import { clientDetailRates, clientWindowMs } from './clients';

const chart = document.querySelector<HTMLElement>('#chart')!;
const plot = chart.querySelector<HTMLElement>('.plot')!;
const svg = document.querySelector<SVGElement>('#plot-svg')!;
const empty = document.querySelector<HTMLElement>('#chart-empty')!;
const setCursor = rateCursor(chart, plot, '流量图');
let previousPoints: TrafficPoint[] | undefined;
let previousRange: Range | undefined;
let previousEnd = 0, previousMessage = '';

function tick(ts: number, wide: boolean): string {
  const d = new Date(ts);
  return wide ? (d.getMonth() + 1) + '/' + d.getDate() : clock(ts);
}

export function drawChart(state: Overview, range: Range): void {
  if (state.history.points === previousPoints && previousRange === range && previousEnd === state.end && previousMessage === state.history.message) return;
  previousPoints = state.history.points; previousRange = range; previousEnd = state.end; previousMessage = state.history.message;
  const length = durations[range], start = state.end - length;
  const points = state.history.points.filter(p => p.ts >= start && p.ts <= state.end && Number.isFinite(p.rx_mbps) && Number.isFinite(p.tx_mbps));
  const delta = points.slice(1).map((p, i) => p.ts - points[i]!.ts).sort((a, b) => a - b);
  const gap = Math.max(30000, (delta[Math.floor(delta.length / 2)] ?? length) * 3);
  const samples = points.map((p, i) => ({ts: p.ts, down: p.rx_mbps, up: p.tx_mbps, gap: i > 0 && p.ts - points[i - 1]!.ts > gap}));
  const scale = rateScale(samples);
  svg.innerHTML = ratePlot(samples, start, length, scale.top, 'wan');
  document.getElementById('y-ticks')!.innerHTML = scale.labels.map(value => '<span>' + value + '</span>').join('');
  const n = range === '7d' ? 7 : 6;
  document.getElementById('x-ticks')!.innerHTML = Array.from({ length: n + 1 }, (_, i) => '<span>' + tick(start + length * i / n, range === '7d') + '</span>').join('');
  empty.hidden = points.length > 0;
  empty.textContent = state.history.message || '此时间段暂无流量样本';
  setCursor(samples, start, state.end);
}

export function clientRateChart(root: HTMLElement) {
  const plot = root.querySelector<HTMLElement>('.plot')!;
  const svg = plot.querySelector('svg')!;
  const unit = root.querySelector<HTMLElement>('.axis-unit')!;
  const yTicks = root.querySelector<HTMLElement>('.y-ticks')!;
  const xTicks = root.querySelector<HTMLElement>('.client-time-axis')!;
  const empty = plot.querySelector<HTMLElement>('.empty-chart')!;
  const cursor = rateCursor(root, plot, '客户端近 1 小时速率图', {seconds: true, respectGaps: true});
  return (samples: readonly ClientSample[], end: number): void => {
    const {start, points, scale} = clientDetailRates(samples, end);
    unit.textContent = points.length ? scale.unit.label : '';
    yTicks.innerHTML = points.length ? scale.labels.map(label => '<span>' + label + '</span>').join('') : '';
    xTicks.innerHTML = Array.from({length: 5}, (_, i) => '<span style="left:' + i * 25 + '%">' + clock(start + clientWindowMs * i / 4) + '</span>').join('');
    svg.innerHTML = ratePlot(points, start, clientWindowMs, scale.top, 'client');
    empty.hidden = points.length > 0;
    cursor(points, start, end, scale);
  };
}
