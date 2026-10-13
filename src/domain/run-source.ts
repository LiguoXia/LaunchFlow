import type { Run } from './types';

export function runSource(
  run: Pick<Run, 'source' | 'triggerId'> & {
    sceneSnapshot: Pick<Run['sceneSnapshot'], 'triggers'>;
  },
) {
  const labels: Record<string, string> = {
    manual: '手动运行',
    quickLaunch: '快捷启动',
    tray: '托盘启动',
    startup: '系统登录 / 默认场景',
    systemLogin: '系统登录',
    appStarted: 'LaunchFlow 启动',
    cron: 'Cron 定时',
    once: '指定时间',
    schedule: '每日定时',
    weekday: '每周定时',
    globalHotkey: '全局快捷键',
    networkAvailable: '网络恢复',
    wifiSsid: '连接 Wi-Fi',
    monitorChanged: '显示器变化',
    powerState: '电源状态',
    recovery: '手动恢复 / 重试',
    subflow: '子流程调用',
    actionTest: '单步测试',
  };
  const matches = run.sceneSnapshot.triggers?.filter((t) => t.kind === run.source) ?? [];
  const trigger = run.triggerId
    ? run.sceneSnapshot.triggers?.find((t) => t.id === run.triggerId)
    : matches.length === 1
      ? matches[0]
      : undefined;
  const config = trigger?.config ?? {};
  let detail = '';
  if (run.source === 'cron') detail = String(config.expression ?? '');
  if (run.source === 'once') detail = String(config.dateTime ?? '');
  if (['schedule', 'weekday'].includes(run.source)) {
    detail = String(config.time ?? '');
    if (run.source === 'weekday' && Array.isArray(config.days))
      detail +=
        ' · ' +
        config.days
          .map(
            (day) =>
              ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'][Number(day)] ?? day,
          )
          .join('、');
  }
  if (run.source === 'globalHotkey') detail = String(config.shortcut ?? '');
  if (run.source === 'networkAvailable')
    detail = config.host ? `${config.host}:${config.port}` : '';
  if (run.source === 'wifiSsid') detail = String(config.ssid ?? '');
  if (run.source === 'powerState')
    detail = config.state === 'ac' ? '接通电源' : config.state === 'battery' ? '使用电池' : '';
  return {
    label: labels[run.source] ?? (run.source ? `其他触发（${run.source}）` : '未记录'),
    detail,
  };
}
