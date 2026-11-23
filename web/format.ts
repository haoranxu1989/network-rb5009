const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => entities[ch]!);
}
const clocks = [false, true].map(seconds => new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', ...(seconds ? {second: '2-digit'} as const : {}), hourCycle: 'h23',
}));
export function fmtTime(ts: number, seconds: boolean): string { return clocks[Number(seconds)]!.format(ts); }
export function fmtDataMB(mb: number): string {
  if (mb >= 1e6) return (mb / 1e6).toFixed(2) + ' TB';
  if (mb >= 1000) return (mb / 1000).toFixed(2) + ' GB';
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  if (mb >= .001) return (mb * 1000).toFixed(0) + ' KB';
  return Math.round(mb * 1e6) + ' B';
}
export type SortState = { col: string; dir: 'asc' | 'desc' };
export function sortRows<T extends Record<string, string>>(rows: T[], col: string, dir: SortState['dir']): T[] {
  return [...rows].sort((a,b) => (a[col] ?? '').localeCompare(b[col] ?? '', 'zh-CN') * (dir === 'asc' ? 1 : -1));
}
export function renderSortHeader(id: string, cols: {key: string; label: string}[], sort: SortState, onSort: () => void): void {
  const row = document.getElementById(id)!;
  for (const col of cols) {
    const th = document.createElement('th');
    th.className = 'th-sort';
    th.innerHTML = col.label;
    th.addEventListener('click', () => {
      sort.dir = sort.col === col.key && sort.dir === 'asc' ? 'desc' : 'asc';
      sort.col = col.key;
      onSort();
    });
    row.append(th);
  }
}
