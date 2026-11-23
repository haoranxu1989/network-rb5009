import { durations, numberText, type ClientSample, type ClientPresence } from './data';
import { rateScale } from './rate-plot';

export const clientWindowMs = durations['1h'];
export function confirmedStart(p: ClientPresence | null, now: number): number | undefined {
  if (p?.connectedAt && p.connectedAt <= now && p.validUntil && p.validUntil > now) return p.connectedAt;
}

export function presenceText(p: ClientPresence | null, now: number): string {
  if (!p?.lastSeen) return '暂无记录';
  const start = confirmedStart(p, now);
  const seconds = Math.max(0, Math.floor((now - (start ?? p.lastSeen)) / 1000));
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (start) {
    if (days) return '已连接 ' + days + ' 天' + (hours % 24 ? ' ' + hours % 24 + ' 小时' : '');
    if (hours) return '已连接 ' + hours + ' 小时' + (minutes % 60 ? ' ' + minutes % 60 + ' 分' : '');
    return '已连接 ' + (minutes ? minutes + ' 分钟' : seconds + ' 秒');
  }
  if (days) return days + ' 天前在线';
  if (hours) return hours + ' 小时前在线';
  return minutes ? minutes + ' 分钟前在线' : '刚刚在线';
}

// Integrate Mbps over contiguous, observed intervals. A lone point gives a rate but no volume.
export function clientVolume(samples: ClientSample[], end: number) {
  let downMB = 0, upMB = 0, coveredMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!, b = samples[i]!;
    const left = Math.max(end - clientWindowMs, a.ts), right = Math.min(end, b.ts);
    if (b.gap || right <= left) continue;
    // The average of a linear segment equals its value at the midpoint, including clipped segments.
    const fraction = ((left - a.ts) + (right - left) / 2) / (b.ts - a.ts);
    const mbPerMbps = (right - left) / 8000;
    downMB += (a.down + fraction * (b.down - a.down)) * mbPerMbps;
    upMB += (a.up + fraction * (b.up - a.up)) * mbPerMbps;
    coveredMs += right - left;
  }
  return { downMB, upMB, coveredMs };
}

export function clientDetailRates(samples: readonly ClientSample[], end: number) {
  const start = end - clientWindowMs;
  const points = samples.filter(p => p.ts >= start && p.ts <= end && Number.isFinite(p.down) && Number.isFinite(p.up));
  return {start, points, scale: rateScale(points, true)};
}

export function clientWave(samples: ClientSample[], end: number): string {
  const duration = 15 * 60_000;
  const start = end - duration;
  const points = samples.filter(p => p.ts >= start && p.ts <= end);
  if (!points.length) return '<span class="wave-empty">暂无采样</span>';
  const w = 128, h = 26;
  const peakDown = Math.max(...points.map(p => p.down)), peakUp = Math.max(...points.map(p => p.up));
  const scale = Math.max(peakDown, peakUp) || 1;
  const desc = '近 15 分钟，下载峰值速率 ' + numberText(peakDown, 2) + ' Mbps，上传峰值速率 ' + numberText(peakUp, 2) + ' Mbps';
  const inset = 2;
  function series(key: 'down' | 'up'): string {
    const path: string[] = [], dots: string[] = [];
    points.forEach((p, i) => {
      const x = (inset + (p.ts - start) / duration * (w - 2 * inset)).toFixed(2);
      const y = (h - 3 - p[key] / scale * (h - 6)).toFixed(2);
      const first = i === 0 || p.gap;
      path.push((first ? 'M' : 'L') + x + ' ' + y);
      if (first && (!points[i + 1] || points[i + 1]!.gap)) dots.push('<circle cx="' + x + '" cy="' + y + '" r="1.6"/>');
    });
    return '<g class="wave-' + key + '"><path d="' + path.join(' ') + '"/>' + dots.join('') + '</g>';
  }
  return '<svg class="client-wave" role="img" aria-label="' + desc + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<title>' + desc + '</title><path class="wave-baseline" d="M' + inset + ' ' + (h - 3) + 'H' + (w - inset) + '"/>' + series('down') + series('up') + '</svg>';
}
