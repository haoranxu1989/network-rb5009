import { compactUptime, type Overview } from './data';
import { icon } from './icons';
import { actionNames, bareVersion, canConfirm, gatewayTarget, isPending, stillOffered, type GatewayAction, type GatewayTarget, type SubmitGateway } from './maintenance';

const channels: Readonly<Record<string, string>> = {stable:'稳定通道', 'long-term':'长期支持通道', testing:'测试通道', development:'开发通道'};

export function gatewayPanel(s: Overview, submit: SubmitGateway, onSubmitted: () => void) {
  const panel = document.getElementById('gateway-panel')!;
  const modal = document.querySelector<HTMLDialogElement>('#gw-action-dialog')!;
  const form = modal.querySelector<HTMLFormElement>('#gw-confirm')!;
  const input = form.querySelector<HTMLInputElement>('#gw-typed')!;
  const confirm = form.querySelector<HTMLButtonElement>('#gw-submit')!;
  const buttons = panel.querySelectorAll<HTMLButtonElement>('[data-gw-action]');
  const feedback = panel.querySelector<HTMLElement>('#gw-feedback')!;
  let review: GatewayTarget | null = null;
  function text(id: string, value: string): void {
    const el = document.getElementById(id)!;
    if (el.textContent !== value) el.textContent = value;
  }
  function render(): void {
    const m = s.maintenance, boot = m.boot;
    text('gw-name', m.routerName || s.site);
    text('gw-model', s.model || '等待设备信息');
    document.getElementById('gw-demo')!.hidden = !s.demo;
    const version = bareVersion(s.version || '') || '—';
    text('gw-os-version', version + (m.available && m.latest ? ' → ' + m.latest : ''));
    const channel = channels[m.channel] || m.channel;
    const osStatus = /error|fail|unavailab|cannot/i.test(m.status) ? '检查更新暂不可用' : m.available ? '有新版本' :
      (m.latest || /already up to date/i.test(m.status)) ? '当前没有更新' : '等待更新检查结果';
    text('gw-os-status', [channel, osStatus].filter(Boolean).join(' · '));
    document.getElementById('gw-boot-row')!.hidden = !boot;
    if (boot) {
      text('gw-boot-version', (boot.current || '—') + (boot.available ? ' → ' + boot.latest : ''));
      text('gw-boot-status', boot.available ? '当前系统已包含新版引导固件' : boot.current && boot.latest ? '当前没有更新' : '等待固件版本');
    }
    text('gw-uptime', compactUptime(s.uptime || ''));
    for (const button of buttons) {
      const action = button.dataset.gwAction as GatewayAction;
      button.hidden = !gatewayTarget(s, action);
    }
    const hint = s.online === false ? '网关离线' : m.canWrite === false ? '当前账号仅可查看版本信息。' :
      m.canWrite === null ? '尚未取得维护权限。' : '';
    const permission = document.getElementById('gw-permission')!;
    permission.hidden = !hint || isPending(s.gatewayJob);
    text('gw-permission', hint);
    const job = s.gatewayJob;
    const msg = job?.message || '';
    feedback.hidden = !msg;
    feedback.dataset.phase = job?.phase || '';
    text('gw-feedback', msg);
  }
  function renderConfirmation(): void {
    if (!modal.open || !review) return;
    const stale = !stillOffered(s, review);
    const error = document.getElementById('gw-review-error')!;
    error.hidden = !stale;
    if (stale) error.textContent = '网关状态已变化，请取消后重新查看。';
    confirm.disabled = stale || !canConfirm(s, review, input.value);
  }
  function reviewAction(action: GatewayAction): void {
    const target = gatewayTarget(s, action);
    if (!target || modal.open) return;
    review = target;
    const reboot = action === 'reboot';
    modal.dataset.action = action;
    document.getElementById('gw-symbol')!.innerHTML = icon(reboot ? 'restart' : action === 'upgrade' ? 'download' : 'upgrade');
    const prepared = !!target.preparedAt;
    const subject = s.gatewayJob?.target.action === 'fwupgrade' ? 'RouterBOOT' : 'RouterOS';
    text('gw-confirm-title', prepared ? '重启并应用更新？' : reboot ? '重启网关？' : actionNames[action]);
    text('gw-target', [target.name, s.model].filter(Boolean).join(' · '));
    text('gw-impact', prepared ? '网关将重启并应用 ' + subject + ' ' + target.to + '，期间网络会短暂中断。' :
      reboot ? '重启期间，此网关的网络连接会短暂中断。' : action === 'upgrade' ?
      '更新包将下载到网关。下载完成后，你可以在方便时重启安装。' :
      '将当前系统附带的引导固件写入网关。写入完成后，你可以在方便时重启生效。');
    document.getElementById('gw-version-pair')!.hidden = reboot && !prepared;
    text('gw-from', target.from); text('gw-to', target.to);
    document.getElementById('gw-name-field')!.hidden = reboot;
    document.getElementById('gw-simulation')!.hidden = !s.demo;
    input.disabled = reboot; input.required = !reboot; input.value = '';
    text('gw-submit', reboot ? '确认重启' : action === 'upgrade' ? '开始下载' : '写入固件');
    modal.showModal(); renderConfirmation();
    if (reboot) document.getElementById('gw-cancel')!.focus(); else input.focus();
  }
  panel.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (button?.dataset.gwAction) reviewAction(button.dataset.gwAction as GatewayAction);
  });
  document.getElementById('gw-cancel')!.addEventListener('click', () => modal.close());
  modal.addEventListener('close', () => { review = null; input.value = ''; });
  input.addEventListener('input', renderConfirmation);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!review || !canConfirm(s, review, input.value)) return;
    if (!submit(review, review.action === 'reboot' ? undefined : input.value)) {
      const error = document.getElementById('gw-review-error')!;
      error.hidden = false; error.textContent = '网关连接或版本已变化，请取消后重新查看。';
      confirm.disabled = true;
      return;
    }
    modal.close(); onSubmitted();
  });
  return {render, renderConfirmation, reviewAction};
}
