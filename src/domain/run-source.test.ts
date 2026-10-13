import { describe, expect, it } from 'vitest';
import { runSource } from './run-source';
const make = (source: string, triggerId?: string) =>
  ({
    source,
    triggerId,
    sceneSnapshot: {
      triggers: [
        {
          id: 'first',
          kind: 'cron',
          enabled: true,
          parameters: {},
          config: { expression: '0 9 * * MON' },
        },
        {
          id: 'second',
          kind: 'cron',
          enabled: true,
          parameters: {},
          config: { expression: '*/5 * * * *' },
        },
      ],
    },
  }) as Parameters<typeof runSource>[0];
describe('run trigger labels', () => {
  it('shows the saved appointment in one-time run history', () => {
    const run = make('once', 'appointment');
    run.sceneSnapshot.triggers = [
      {
        id: 'appointment',
        kind: 'once',
        enabled: true,
        config: { dateTime: '2026-10-13 12:30:45' },
        parameters: {},
      },
    ];
    expect(runSource(run)).toEqual({ label: '指定时间', detail: '2026-10-13 12:30:45' });
  });
  it('uses the recorded trigger ID from the run snapshot rather than guessing among triggers', () => {
    expect(runSource(make('cron', 'second'))).toEqual({
      label: 'Cron 定时',
      detail: '*/5 * * * *',
    });
    expect(runSource(make('cron')).detail).toBe('');
  });
  it('supports old records and distinguishes quick launch, startup, tray and recovery', () => {
    for (const [source, label] of [
      ['manual', '手动运行'],
      ['quickLaunch', '快捷启动'],
      ['startup', '系统登录 / 默认场景'],
      ['tray', '托盘启动'],
      ['recovery', '手动恢复 / 重试'],
    ])
      expect(runSource(make(source)).label).toBe(label);
    expect(runSource(make('unknown')).label).toContain('unknown');
  });
});
