import { clock, numberText, type ClientSample } from './data';
import { rateUnit, type RateScale } from './rate-plot';

// The arrays are ordered by timestamp. Inside an unobserved interval only a
// point close enough to the pointer to be hit may be selected.
export function sampleIndexAt(points: readonly ClientSample[], ts: number, gapTolerance = Infinity): number {
  if (!points.length) return -1;
  let low = 0, high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid]!.ts < ts) low = mid + 1; else high = mid;
  }
  const right = points[low], left = points[low - 1];
  const index = left && (!right || ts - left.ts <= right.ts - ts) ? low - 1 : low;
  if ((!left || !right || right.gap) && Math.abs(points[index]!.ts - ts) > gapTolerance) return -1;
  return index;
}

export function rateCursor(root: HTMLElement, plot: HTMLElement, label: string, options: { seconds?: boolean; respectGaps?: boolean } = {}) {
  const line = plot.querySelector<HTMLElement>('.crosshair')!;
  const tip = plot.querySelector<HTMLElement>('.chart-tip')!;
  const downDot = line.querySelector<HTMLElement>('.wave-down');
  const upDot = line.querySelector<HTMLElement>('.wave-up');
  let scale: RateScale | undefined;
  let points: readonly ClientSample[] = [], start = 0, duration = 1, selected = -1;
  function hide(): void {
    selected = -1;
    line.hidden = tip.hidden = true;
    root.setAttribute('aria-label', label + '，使用左右方向键查看采样点');
  }
  function rateText(value: number): string {
    const unit = scale && value > 0 ? rateUnit(value) : scale?.unit ?? rateUnit(0);
    return numberText(value * unit.multiplier, options.seconds ? 2 : 1) + ' ' + unit.label;
  }
  function show(index: number): void {
    const p = points[index];
    if (!p) return hide();
    selected = index;
    const fraction = (p.ts - start) / duration;
    const date = new Date(p.ts);
    const timestamp = (date.getMonth() + 1) + '/' + date.getDate() + ' ' + clock(p.ts, options.seconds);
    const down = '下载速率 ' + rateText(p.down);
    const up = '上传速率 ' + rateText(p.up);
    line.style.left = fraction * 100 + '%';
    if (scale && downDot && upDot) {
      downDot.style.top = (1 - p.down / scale.top) * 100 + '%';
      upDot.style.top = (1 - p.up / scale.top) * 100 + '%';
    }
    line.hidden = tip.hidden = false;
    tip.innerHTML = '<b>' + timestamp + '</b><div class="tip-down">' + down + '</div><div class="tip-up">' + up + '</div>';
    const x = plot.clientWidth * fraction, width = tip.offsetWidth;
    const left = x + 9 + width <= plot.clientWidth ? x + 9 : x - width - 9;
    tip.style.left = Math.max(0, Math.min(plot.clientWidth - width, left)) + 'px';
    root.setAttribute('aria-label', [label, timestamp, down, up].join('，'));
  }
  function inspect(ev: PointerEvent): void {
    const rect = plot.getBoundingClientRect();
    if (!rect.width) return;
    const ts = start + (ev.clientX - rect.left) / rect.width * duration;
    show(sampleIndexAt(points, ts, options.respectGaps ? 4 * duration / rect.width : Infinity));
  }
  plot.addEventListener('pointermove', inspect);
  plot.addEventListener('pointerdown', inspect);
  plot.addEventListener('pointerleave', ev => { if (ev.pointerType !== 'touch') hide(); });
  plot.addEventListener('pointercancel', hide);
  root.addEventListener('blur', hide);
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape' && selected >= 0) { e.preventDefault(); hide(); return; }
    if (!points.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Home') show(0);
    else if (e.key === 'End' || selected < 0) show(points.length - 1);
    else show(Math.max(0, Math.min(points.length - 1, selected + (e.key === 'ArrowLeft' ? -1 : 1))));
  });
  return (next: readonly ClientSample[], from: number, until: number, nextScale?: RateScale): void => {
    const selectedTime = points[selected]?.ts;
    points = next; start = from; duration = until - from; scale = nextScale;
    if (selectedTime === undefined || selectedTime < from || selectedTime > until) return hide();
    show(sampleIndexAt(next, selectedTime, options.respectGaps ? 0 : Infinity));
  };
}
