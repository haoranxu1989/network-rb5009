import { uptimeSeconds, type Overview } from './data';
import type { PackageUpgradeProgress } from './types';

export type GatewayAction = 'upgrade' | 'fwupgrade' | 'reboot';
export type GatewayTarget = { action: GatewayAction; id: string; name: string; from: string; to: string; preparedAt?: number };
export type GatewayJob = {
  target: GatewayTarget; phase: 'sending' | 'waiting' | 'done' | 'error' | 'unknown';
  started: number; uptime: number | null; wentOffline: boolean; message: string;
  progress?: PackageUpgradeProgress;
  observedAt?: number;
  rebooting?: boolean;
};
export type SubmitGateway = (target: GatewayTarget, typed?: string) => boolean;
export const actionNames = {upgrade: '下载 RouterOS 更新', fwupgrade: '升级 RouterBOOT', reboot: '重启网关'};
export const bareVersion = (raw = ''): string => raw.trim().split(/\s+/)[0] || '';
export const isPending = (job: GatewayJob | null): boolean => job?.phase === 'sending' || job?.phase === 'waiting';
export const readyToReboot = (job: GatewayJob | null): boolean => isPending(job) && !job?.rebooting &&
  (job?.progress?.stage === 'downloaded' || job?.progress?.stage === 'staged');

// One offered update can go straight to review. Two offers need an explicit choice.
export function singleGatewayUpdate(m: Overview['maintenance']): 'upgrade' | 'fwupgrade' | null {
  if (m.available && !m.boot?.available) return 'upgrade';
  if (m.boot?.available && !m.available) return 'fwupgrade';
  return null;
}

export function gatewayTarget(s: Overview, action: GatewayAction): GatewayTarget | null {
  const m = s.maintenance;
  if (s.online !== true || !m.canWrite || !m.routerId || !m.routerName) return null;
  if (isPending(s.gatewayJob)) {
    const job = s.gatewayJob!;
    if (action !== 'reboot' || !readyToReboot(job)) return null;
    return {action, id:m.routerId, name:m.routerName, from:job.target.from, to:job.target.to, preparedAt:job.progress!.startedAt};
  }
  if (action === 'upgrade' && !(m.available && s.version && m.latest)) return null;
  if (action === 'fwupgrade' && !(m.boot?.available && m.boot.current && m.boot.latest)) return null;
  const from = action === 'fwupgrade' ? m.boot!.current : bareVersion(s.version);
  const to = action === 'fwupgrade' ? m.boot!.latest : action === 'upgrade' ? m.latest : '';
  return { action, id: m.routerId, name: m.routerName, from, to };
}

export function stillOffered(s: Overview, t: GatewayTarget): boolean {
  const now = gatewayTarget(s, t.action);
  return !!now && now.id === t.id && now.name === t.name && now.from === t.from && now.to === t.to && now.preparedAt === t.preparedAt;
}
export function canConfirm(s: Overview, target: GatewayTarget, typed = ''): boolean {
  return stillOffered(s, target) && (target.action === 'reboot' || typed.trim() === '确认');
}
export function beginGateway(s: Overview, target: GatewayTarget, typed = ''): boolean {
  if (!canConfirm(s, target, typed)) return false;
  if (target.preparedAt && s.gatewayJob) {
    s.gatewayJob.rebooting = true;
    s.gatewayJob.observedAt = Date.now();
    s.gatewayJob.message = '已请求重启，等待网关上线后核对运行版本。';
    return true;
  }
  s.gatewayJob = {target, phase:'sending', started:Date.now(), uptime:uptimeSeconds(s.uptime), wentOffline:false, message:'正在提交请求…'};
  return true;
}
export function gatewayAccepted(s: Overview): void {
  const job = s.gatewayJob;
  if (!job || !isPending(job)) return;
  job.phase = 'waiting';
  if (!job.progress) job.message = job.target.action === 'reboot' ? '已提交重启，等待网关重新上线。' :
    job.target.action === 'upgrade' ? '下载请求已提交，等待网关回报进度。' : '正在写入引导固件。';
}

const stageLabels: Readonly<Record<string, string>> = {
  requested:'等待下载状态', downloading:'下载 RouterOS', downloaded:'已下载，待重启', staged:'固件已写入，待重启',
  installing:'正在安装', restarting:'网关重启中', verifying:'正在核对版本',
};
export function gatewayTaskLabel(job: GatewayJob): string {
  if (job.phase === 'done') return job.target.action === 'reboot' ? '网关已重启' : '升级完成';
  if (job.phase === 'error') return '操作失败';
  if (job.phase === 'unknown') return '结果待确认';
  if (job.wentOffline) return '等待网关上线';
  if (job.rebooting) return '网关重启中';
  if (job.target.action === 'fwupgrade' && job.progress?.stage === 'requested') return '写入引导固件';
  if (job.progress) return stageLabels[job.progress.stage] || '等待网关回报';
  if (job.phase === 'sending') return '正在提交';
  if (job.target.action === 'upgrade') return '等待下载状态';
  return job.target.action === 'fwupgrade' ? '写入引导固件' : '网关重启中';
}

// The system feed replays the router's active installation when a tab reconnects.
export function syncGatewayProgress(s: Overview, p?: PackageUpgradeProgress | null): void {
  const m = s.maintenance;
  if (!p || !m.routerId || (!p.target && p.kind !== 'reboot')) return;
  const terminal = p.stage === 'verified' || p.stage === 'failed' || p.stage === 'unknown';
  let job = s.gatewayJob;
  if (job?.progress && job.progress.startedAt > p.startedAt) return;
  const action = p.kind === 'routerboot' ? 'fwupgrade' : p.kind === 'reboot' ? 'reboot' : 'upgrade';
  const subject = action === 'fwupgrade' ? 'RouterBOOT' : 'RouterOS';
  const matches = job?.target.id === m.routerId && job.target.action === action &&
    job.target.to === p.target && (!job.progress || job.progress.startedAt === p.startedAt);
  if (!job || !matches) {
    if (terminal || (job?.target.action === 'reboot' && isPending(job))) return;
    job = {target:{id:m.routerId, name:m.routerName || s.site, action, from:p.from, to:p.target},
      phase:'waiting', started:Date.now(), uptime:null, wentOffline:false, message:''};
    s.gatewayJob = job;
  }
  if (job.phase === 'done' || (job.progress && job.progress.updatedAt >= p.updatedAt)) return;
  job.progress = p;
  job.observedAt = Date.now();
  job.wentOffline = false;
  job.rebooting = p.stage === 'restarting';
  if (p.stage === 'verified') {
    job.phase = 'done'; job.message = action === 'reboot' ? '网关已重启并重新上线。' : subject + ' 已升级至 ' + p.target + '。';
  } else if (p.stage === 'failed') {
    job.phase = 'error'; job.message = '网关操作未成功，请核对账号权限和 RouterOS 日志。';
  } else if (p.stage === 'unknown') {
    job.phase = 'unknown'; job.message = '尚未确认升级结果，请核对网关运行版本。';
  } else {
    job.phase = 'waiting';
    const transfer = p.stage === 'downloading' ? [p.downloaded && '已下载 ' + p.downloaded, p.percent != null && p.percent + '%'].filter(Boolean) : [];
    job.message = action === 'reboot' ? '已请求重启，等待网关回报运行时间。' : [subject + ' ' + p.target, gatewayTaskLabel(job), ...transfer].join(' · ');
  }
}
export function observeGateway(s: Overview): void {
  const job = s.gatewayJob, m = s.maintenance;
  if (!job || job.target.id !== m.routerId || s.online !== true || (!isPending(job) && job.phase !== 'unknown')) return;
  const t = job.target;
  if (readyToReboot(job)) job.wentOffline = false;
  if (t.action === 'reboot') {
    const now = uptimeSeconds(s.uptime);
    const elapsed = Math.max(0, (Date.now() - job.started) / 1000);
    const reset = now !== null && job.uptime !== null &&
      (now < job.uptime || (job.wentOffline && now < job.uptime + elapsed - 3));
    if (!reset) {
      if (job.wentOffline) job.message = '网关已重新上线，等待确认运行时间。';
      return;
    }
    job.message = '网关已重启并重新上线。';
  } else {
    const actual = t.action === 'upgrade' ? bareVersion(s.version) : m.boot?.current;
    if (actual !== t.to) return;
    job.message = (t.action === 'upgrade' ? 'RouterOS' : 'RouterBOOT') + ' 已升级至 ' + actual + '。';
  }
  job.phase = 'done';
}
export function expireGateway(s: Overview): boolean {
  const job = s.gatewayJob;
  if (!job || !isPending(job) || readyToReboot(job) || Date.now() - (job.observedAt ?? job.started) < (job.progress ? 30 : 5) * 60_000) return false;
  job.phase = 'unknown';
  job.message = '尚未收到网关的完成回报，请核对运行版本和运行时间。';
  return true;
}
export function gatewayFailure(code: string): string {
  switch (code) {
    case 'denied': return '当前账号没有网关维护权限。';
    case 'confirm-mismatch': return '确认内容或网关已变化，请重新确认。';
    case 'target-changed': return '网关或目标版本已变化，请重新查看版本。';
    case 'nothing-to-update': case 'firmware-current': return '网关当前没有可安装的新版本。';
    case 'router-write-policy': return 'RouterOS 连接账号缺少执行此操作的权限。';
    case 'rate-limited': return '操作过于频繁，请稍后再试。';
    case 'upgrade-in-progress': return '这台网关已有升级任务，请查看当前进度。';
    case 'no-routerboard': case 'unsupported': return '此网关不支持该操作。';
    case 'unavailable': return '网关暂时不可用。';
    default: return '网关操作未获确认，请检查版本、连接状态和 RouterOS 日志。';
  }
}
