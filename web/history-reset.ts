import type { Overview } from './data';

export type GatewayHistoryActions = {
  preview: (id: string) => Promise<number | null>;
  clear: (id: string, confirmation: string) => Promise<void>;
};

export function storedHistoryActions(onCleared: (id: string, at: number) => void): GatewayHistoryActions {
  async function request(id: string, confirmation?: string) {
    if (!id.trim()) throw new Error('请先选择网关。');
    const url = '/api/gateway/' + encodeURIComponent(id) + '/history';
    const options: RequestInit = { credentials: 'same-origin', cache: 'no-store' };
    if (confirmation !== undefined) {
      if (confirmation !== '确认') throw new Error('请输入「确认」。');
      Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({confirm: confirmation}) });
    }
    const fail = confirmation === undefined ? '暂时无法读取历史记录，请稍后重试。' : '未收到清除结果，请重新打开窗口核对记录。';
    const response = await fetch(url, options).catch(() => { throw new Error(fail); });
    if (response.status === 403) throw new Error('当前账号没有清除这台网关历史数据的权限。');
    if (response.status === 401) throw new Error('登录已过期，请重新登录。');
    if (response.status === 404) throw new Error('当前服务找不到这台网关的历史数据入口。');
    if (!response.ok) throw new Error(fail);
    const result = await response.json().catch(() => null);
    if (result?.routerId !== id) throw new Error(fail);
    return result;
  }
  return {
    async preview(id) {
      const {total} = await request(id);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('未能读取历史记录数。');
      return total;
    },
    async clear(id, confirmation) {
      const {deleted, ts} = await request(id, confirmation);
      if (!Number.isSafeInteger(deleted) || deleted < 0 || !Number.isSafeInteger(ts) || ts <= 0) throw new Error('未收到有效的清除结果。');
      onCleared(id, ts);
    },
  };
}

export function historyResetPanel(state: Overview, actions: GatewayHistoryActions): () => void {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const trigger = el<HTMLButtonElement>('history-open'), dialog = el<HTMLDialogElement>('history-dialog');
  const input = el<HTMLInputElement>('history-typed'), cancel = el<HTMLButtonElement>('history-cancel');
  const submit = el<HTMLButtonElement>('history-submit'), note = el('history-note'), feedback = el('history-feedback');
  let target = '', revision = 0, ready = false, busy = false, feedbackTimer = 0;
  const updateSubmit = () => { submit.disabled = busy || !ready || target !== state.historyRouterId || input.value.trim() !== '确认'; };
  function error(message: unknown): void {
    note.className = 'action-error';
    note.textContent = message instanceof Error ? message.message : '操作失败，请稍后重试。';
  }
  trigger.addEventListener('click', async () => {
    if (!state.historyRouterId || busy) return;
    const current = ++revision;
    target = state.historyRouterId;
    ready = false;
    input.value = '';
    updateSubmit();
    el('history-target').textContent = [state.maintenance.routerName || state.site, state.model].filter(Boolean).join(' · ');
    note.className = 'action-note';
    note.textContent = '正在读取记录数…';
    dialog.showModal();
    try {
      const count = await actions.preview(target);
      if (current !== revision || !dialog.open || target !== state.historyRouterId) return;
      ready = count !== 0 || !state.demo;
      if (count === 0) note.textContent = state.demo ? '示例历史和端口累计流量均已清零。' : '当前历史记录为 0 条，仍可将物理端口累计流量归零。';
      else note.textContent = count === null ? '此操作仅清除当前预览的示例记录。' : '当前已保存 ' + count.toLocaleString('zh-CN') + ' 条记录。';
      updateSubmit();
    } catch (e) { if (current === revision && dialog.open) error(e); }
  });
  input.addEventListener('input', updateSubmit);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
  dialog.addEventListener('click', e => {
    if (busy || e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    ++revision; target = ''; ready = false;
    if (!trigger.disabled) trigger.focus({preventScroll: true});
  });
  el<HTMLFormElement>('history-form').addEventListener('submit', async e => {
    e.preventDefault();
    updateSubmit();
    if (submit.disabled) return;
    const id = target;
    busy = true; cancel.disabled = true; input.disabled = true; updateSubmit();
    submit.textContent = '正在清除…';
    try {
      await actions.clear(id, input.value.trim());
      if (dialog.open) dialog.close();
      if (id === state.historyRouterId) {
        feedback.textContent = '历史数据已清除';
        window.clearTimeout(feedbackTimer);
        feedbackTimer = window.setTimeout(() => { feedback.textContent = ''; }, 2000);
      }
    } catch (e) { ready = false; if (dialog.open) error(e); }
    finally {
      busy = false; cancel.disabled = false; input.disabled = false; submit.textContent = '清除历史数据'; updateSubmit();
    }
  });
  return () => {
    trigger.disabled = !state.historyRouterId;
    if (dialog.open && target !== state.historyRouterId) dialog.close();
  };
}
