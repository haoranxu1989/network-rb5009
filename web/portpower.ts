import type { Port } from './data';
import { icon } from './icons';

export const powerLabels = { supplying: 'PoE 供电中', capable: 'PoE 输出口' } as const;

export function powerState(p: Port): keyof typeof powerLabels | null {
  if (!p.poe?.output) return null;
  return p.poe.status === 'powered-on' ? 'supplying' : 'capable';
}

export function measuredWatts(p: Port): number | null {
  const watts = p.poe?.watts;
  return powerState(p) === 'supplying' && typeof watts === 'number' && Number.isFinite(watts) && watts >= 0 ? watts : null;
}

export function powerText(p: Port): string {
  const watts = measuredWatts(p);
  return watts === null ? '' : watts.toFixed(1) + ' W';
}

export function facePower(p: Port): string {
  const state = powerState(p);
  if (!state) return '';
  const mark = '<span class="port-power-mark ' + state + '" role="img" aria-label="' + powerLabels[state] + '">' + icon('bolt') + '</span>';
  const watts = measuredWatts(p);
  return watts === null ? mark : mark + '<span class="port-watts">' + watts.toFixed(1) + ' <small>W</small></span>';
}

export function powerSummary(ports: Port[]): string {
  const active = ports.filter(p => powerState(p) === 'supplying');
  const readings = active.map(measuredWatts).filter((w): w is number => w !== null);
  if (!readings.length) return '';
  const label = readings.length === active.length ? 'PoE 输出' : 'PoE 已测输出';
  const total = readings.reduce((sum, w) => sum + w, 0);
  return '<span class="poe-summary-label">' + icon('bolt') + label + '</span><strong>' + total.toFixed(1) +
    ' W</strong><span class="poe-active">' + active.length + ' 口供电</span>';
}
