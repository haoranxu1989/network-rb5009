import type { PingPoint } from './types';
import { durations, type Rate } from './data';
export const qualityLabels = ['无采样', '正常', '延迟或丢包升高', '不可达'] as const;
export const qualityTones = ['', 'ok', 'warn', 'bad'] as const;
type Level = 0 | 1 | 2 | 3;

export function qualityLevel(rtt: Rate, loss: Rate): Level {
  if (rtt === null && loss === null) return 0;
  if (loss !== null && loss >= 100) return 3;
  if ((loss ?? 0) > 0 || (rtt ?? 0) >= 80) return 2;
  return 1;
}

// Each segment shows the worst observed sample. An unsampled segment stays grey.
export function qualityBands(points: PingPoint[], end: number): Level[] {
  const count = 48;
  const start = end - durations['24h'];
  const span = durations['24h'] / count;
  const levels = Array<Level>(count).fill(0);
  for (const p of points) {
    if (p.permissionDenied || p.ts < start || p.ts > end) continue;
    const i = Math.min(count - 1, Math.floor((p.ts - start) / span));
    const level = qualityLevel(p.rtt, p.loss);
    if (level > levels[i]!) levels[i] = level;
  }
  return levels;
}
