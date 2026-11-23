import { numberText, type ClientSample } from './data';

const width = 900, height = 160;
const grid = Array.from({length: 5}, (_, i) =>
  '<path d="M0 ' + (i * height / 4) + 'H' + width + '" stroke="#e7ebef" fill="none" vector-effect="non-scaling-stroke"/>').join('');

export function rateUnit(mbps: number) {
  if (mbps >= 1000) return {label: 'Gbps', multiplier: .001};
  if (mbps > 0 && mbps < .001) return {label: 'bps', multiplier: 1e6};
  if (mbps > 0 && mbps < 1) return {label: 'kbps', multiplier: 1000};
  return {label: 'Mbps', multiplier: 1};
}

export function rateScale(points: readonly ClientSample[], adaptiveUnits = false) {
  const peak = points.reduce((max, p) => Math.max(max, p.down, p.up), 0);
  const unit = rateUnit(adaptiveUnits ? peak : 0);
  const rough = peak * unit.multiplier / 4 || (adaptiveUnits ? .25 : 1);
  const base = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find(v => v >= rough / base) ?? 10) * base;
  return {unit, top: 4 * step / unit.multiplier,
    labels: Array.from({length: 5}, (_, i) => points.length ? numberText((4 - i) * step, 2) : '—')};
}
export type RateScale = ReturnType<typeof rateScale>;

export function ratePlot(points: readonly ClientSample[], start: number, duration: number, top: number, id: 'wan' | 'client'): string {
  const groups: ClientSample[][] = [];
  for (const p of points) {
    if (!groups.length || p.gap) groups.push([]);
    groups[groups.length - 1]!.push(p);
  }
  const x = (p: ClientSample) => ((p.ts - start) / duration * width).toFixed(2);
  function series(key: 'down' | 'up', color: string, fill: string, weight: number): string {
    const gradient = id + '-' + key;
    const y = (p: ClientSample) => (height * (1 - Math.max(0, p[key]) / top)).toFixed(2);
    const paths = groups.map(group => {
      const first = group[0]!, last = group[group.length - 1]!;
      if (group.length === 1) return '<path d="M' + x(first) + ',' + y(first) + 'h0" stroke="' + color + '" stroke-width="3.5" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
      const line = group.map((p, i) => (i ? 'L' : 'M') + x(p) + ',' + y(p)).join(' ');
      return '<path d="' + line + ' L' + x(last) + ',' + height + ' L' + x(first) + ',' + height + ' Z" fill="url(#' + gradient + ')"/>' +
        '<path d="' + line + '" stroke="' + color + '" stroke-width="' + weight + '" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" fill="none"/>';
    });
    return '<defs><linearGradient id="' + gradient + '" x1="0" y1="0" x2="0" y2="1"><stop stop-color="' + fill + '" stop-opacity="' + (key === 'down' ? '.30' : '.27') + '"/><stop offset="1" stop-color="' + fill + '" stop-opacity="' + (key === 'down' ? '.025' : '.045') + '"/></linearGradient></defs>' + paths.join('');
  }
  return grid + series('down', '#2185ef', '#419cff', 1.9) + series('up', '#9970e9', '#a98aef', 1.6);
}
