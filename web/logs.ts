import { renderSortHeader, sortRows, type SortState } from './format';
import type { Overview, RouterLog } from './data';
import { icon } from './icons';

function logRow(entry: RouterLog): HTMLTableRowElement {
  const row = document.createElement('tr');
  const time = row.insertCell();
  time.textContent = entry.time || '—';
  const topic = document.createElement('span');
  topic.className = 'log-topic';
  topic.dataset.severity = entry.severity;
  topic.textContent = entry.topics || '—';
  row.insertCell().append(topic);
  row.insertCell().textContent = entry.message;
  return row;
}

export function logPage(state: Overview): () => void {
  const body = document.getElementById('log-rows') as HTMLTableSectionElement;
  const header = document.getElementById('log-columns') as HTMLTableRowElement;
  const count = document.getElementById('log-count')!;
  const empty = document.getElementById('log-empty')!;
  document.getElementById('log-demo')!.hidden = !state.demo;
  const sort: SortState = { col: 'time', dir: 'desc' };
  const columns = [
    { key: 'time', label: '时间' }, { key: 'topics', label: '主题' }, { key: 'message', label: '消息' },
  ].map(col => ({ key: col.key, label: '<button type="button">' + col.label + icon('arrow-down') + '</button>' }));
  const nodes = new Map<RouterLog, HTMLTableRowElement>();
  let previous: Overview['logs'] | undefined;

  function render(): void {
    const entries = state.logs;
    const message = entries === null ? (state.online === false ? '网关离线' : state.online === true ? '尚未收到可读取的网关日志' : state.source)
      : entries.length ? '' : '网关日志为空';
    if (empty.textContent !== message) empty.textContent = message;
    empty.hidden = !message;
    if (entries === previous) return;
    previous = entries;
    count.hidden = entries === null;
    count.textContent = entries === null ? '' : entries.length + ' 条';
    // RouterOS may omit the date or change its clock. Keep its buffer order for the time column.
    const rows = entries ?? [];
    const ordered = sort.col !== 'time' ? sortRows(rows, sort.col, sort.dir) : sort.dir === 'desc' ? rows : rows.slice().reverse();
    const retained = new Set(ordered);
    for (const [entry, row] of nodes) {
      if (retained.has(entry)) continue;
      row.remove();
      nodes.delete(entry);
    }
    let cursor = body.firstElementChild;
    for (const entry of ordered) {
      let row = nodes.get(entry);
      if (!row) { row = logRow(entry); nodes.set(entry, row); }
      if (row === cursor) cursor = row.nextElementSibling;
      else body.insertBefore(row, cursor);
    }
  }

  function markSort(): void {
    for (const [i, cell] of Array.from(header.cells).entries()) {
      const selected = columns[i]!.key === sort.col;
      cell.scope = 'col';
      cell.classList.toggle('sort-desc', selected && sort.dir === 'desc');
      cell.classList.toggle('sort-asc', selected && sort.dir === 'asc');
      if (selected) cell.setAttribute('aria-sort', sort.dir === 'desc' ? 'descending' : 'ascending');
      else cell.removeAttribute('aria-sort');
    }
  }
  renderSortHeader('log-columns', columns, sort, () => {
    markSort();
    previous = undefined;
    render();
  });
  markSort();
  return render;
}
