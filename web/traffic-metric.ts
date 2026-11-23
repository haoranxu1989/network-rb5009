import { esc } from './format';
import { dataSize, numberText, type Rate } from './data';

// The first line is the latest rate. The second names the scope of the byte count.
export function trafficMetric(mbps: Rate, volumeMB: Rate, scope: string, description: string): string {
  const speed = mbps === null ? '—' : numberText(mbps, 2) + ' Mbps';
  const size = volumeMB !== null && volumeMB < 0.001 ? Math.round(volumeMB * 1e6) + ' B' : dataSize(volumeMB);
  return '<strong class="traffic-speed" title="最近一次采样速率">' + speed + '</strong>' +
    '<small class="traffic-volume" title="' + esc(description) + '">' + esc(scope) + ' ' + size + '</small>';
}
