import type { Scene, Parameter, Trigger, TriggerDefinition, TriggerEvent } from '../domain/types';
import { ParameterInput } from './RunConfiguration';
import CronInput from './CronInput';
import OnceScheduleInput from './OnceScheduleInput';
import SearchSelect from './SearchSelect';
export function JsonInput({
  value,
  onChange,
  label,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  label?: string;
}) {
  return (
    <textarea
      aria-label={label}
      rows={4}
      spellCheck={false}
      value={typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)}
      onChange={(e) => {
        try {
          onChange(JSON.parse(e.target.value));
        } catch {
          onChange(e.target.value);
        }
      }}
    />
  );
}
export default function SceneAdvancedSettings({
  scene,
  change,
  definitions,
  statuses,
}: {
  scene: Scene;
  change: (s: Scene) => void;
  definitions: TriggerDefinition[];
  statuses: TriggerEvent[];
}) {
  const updateParameter = (i: number, patch: Partial<Parameter>) =>
    change({
      ...scene,
      parameters: (scene.parameters ?? []).map((p, j) => (i === j ? { ...p, ...patch } : p)),
    });
  const updateTrigger = (i: number, patch: Partial<Trigger>) =>
    change({
      ...scene,
      triggers: (scene.triggers ?? []).map((t, j) => (i === j ? { ...t, ...patch } : t)),
    });
  return (
    <>
      <div className="form-divider" />
      <label>
        敏感操作策略
        <SearchSelect
          label="敏感操作策略"
          value={scene.sensitiveActionPolicy ?? 'blockAtStartup'}
          onChange={(value) =>
            change({
              ...scene,
              sensitiveActionPolicy: value as Scene['sensitiveActionPolicy'],
            })
          }
          options={[
            { value: 'askEveryTime', label: '每次执行确认' },
            { value: 'allowForThisScene', label: '允许此场景执行' },
            { value: 'blockAtStartup', label: '登录时阻止敏感操作' },
          ]}
        />
        <small>适用于命令、Secret 输入和可修改应用内容的 GUI 操作；不会绕过系统授权。</small>
      </label>
      <label>
        重复运行策略
        <SearchSelect
          label="重复运行策略"
          value={scene.concurrentRunPolicy ?? 'ignore'}
          onChange={(value) =>
            change({
              ...scene,
              concurrentRunPolicy: value as Scene['concurrentRunPolicy'],
            })
          }
          options={[
            { value: 'ignore', label: '忽略重复触发' },
            { value: 'queue', label: '按顺序排队' },
            { value: 'restart', label: '取消当前并重启' },
          ]}
        />
      </label>
      <label>
        最大并行节点
        <input
          type="number"
          min={1}
          max={32}
          value={scene.maxParallel ?? 8}
          onChange={(e) => change({ ...scene, maxParallel: Number(e.target.value) })}
        />
      </label>
      <div className="form-divider" />
      <h3>场景参数</h3>
      {(scene.parameters ?? []).map((p, i) => (
        <details className="config-block" key={i} open>
          <summary>
            {p.name || '新参数'} · {p.kind}
          </summary>
          <label>
            参数名称
            <input value={p.name} onChange={(e) => updateParameter(i, { name: e.target.value })} />
          </label>
          <label>
            类型
            <SearchSelect
              label="类型"
              value={p.kind}
              onChange={(value) =>
                updateParameter(i, {
                  kind: value as Parameter['kind'],
                  defaultValue: null,
                })
              }
              options={[
                'string',
                'number',
                'boolean',
                'select',
                'file',
                'directory',
                'secretReference',
              ].map((value) => ({ value, label: value }))}
            />
          </label>
          <label>
            说明
            <input
              value={p.description}
              onChange={(e) => updateParameter(i, { description: e.target.value })}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={p.required}
              onChange={(e) => updateParameter(i, { required: e.target.checked })}
            />
            必填
          </label>
          {p.kind === 'select' && (
            <label>
              选项（每行一个）
              <textarea
                value={p.options.join('\n')}
                onChange={(e) =>
                  updateParameter(i, { options: e.target.value.split('\n').filter(Boolean) })
                }
              />
            </label>
          )}
          <label>
            默认值
            <ParameterInput
              parameter={{ ...p, required: false }}
              value={p.defaultValue}
              onChange={(v) => updateParameter(i, { defaultValue: v })}
            />
          </label>
          <label>
            最小值 / 最短长度
            <input
              type="number"
              value={p.validation.min ?? ''}
              onChange={(e) =>
                updateParameter(i, {
                  validation: {
                    ...p.validation,
                    min: e.target.value === '' ? null : Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            最大值 / 最长长度
            <input
              type="number"
              value={p.validation.max ?? ''}
              onChange={(e) =>
                updateParameter(i, {
                  validation: {
                    ...p.validation,
                    max: e.target.value === '' ? null : Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            匹配规则（正则）
            <input
              value={p.validation.pattern ?? ''}
              onChange={(e) =>
                updateParameter(i, {
                  validation: { ...p.validation, pattern: e.target.value || null },
                })
              }
            />
          </label>
          <button
            className="text-link danger-text"
            onClick={() =>
              change({ ...scene, parameters: scene.parameters?.filter((_, j) => j !== i) })
            }
          >
            删除参数
          </button>
        </details>
      ))}
      <button
        className="button secondary"
        onClick={() =>
          change({
            ...scene,
            parameters: [
              ...(scene.parameters ?? []),
              {
                name: `param${(scene.parameters?.length ?? 0) + 1}`,
                kind: 'string',
                description: '',
                required: false,
                defaultValue: null,
                options: [],
                validation: {},
              },
            ],
          })
        }
      >
        添加参数
      </button>
      <div className="form-divider" />
      <h3>触发器</h3>
      <p className="form-note">
        手动运行始终可用。系统登录仅运行默认场景。定时任务按本机时间执行；指定时间错过后补执行一次，其他定时触发不补发。
      </p>
      {(scene.triggers ?? []).map((t, i) => {
        const definition = definitions.find((d) => d.kind === t.kind);
        const status = statuses.find((s) => s.sceneId === scene.id && s.triggerId === t.id);
        return (
          <details key={t.id} className="config-block" open>
            <summary>{definition?.name ?? t.kind}</summary>
            <label>
              触发方式
              <SearchSelect
                label="触发方式"
                value={t.kind}
                onChange={(value) =>
                  updateTrigger(i, {
                    kind: value,
                    config: structuredClone(
                      definitions.find((d) => d.kind === value)?.defaults ?? {},
                    ),
                  })
                }
                options={definitions.map((d) => ({ value: d.kind, label: d.name }))}
              />
            </label>
            <small>{definition?.description}</small>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={t.enabled}
                onChange={(e) => updateTrigger(i, { enabled: e.target.checked })}
              />
              启用
            </label>
            {t.kind === 'cron' && (
              <CronInput
                value={String(t.config.expression ?? '')}
                onChange={(expression) => updateTrigger(i, { config: { expression } })}
              />
            )}
            {t.kind === 'once' && (
              <OnceScheduleInput
                value={String(t.config.dateTime ?? '')}
                onChange={(dateTime) => updateTrigger(i, { config: { dateTime } })}
              />
            )}
            {Object.entries(t.config)
              .filter(([key]) => t.kind !== 'cron' || key !== 'expression')
              .filter(([key]) => t.kind !== 'once' || key !== 'dateTime')
              .map(([key, value]) => (
                <label key={key}>
                  {(
                    {
                      time: '时间 HH:mm',
                      days: '星期 [1–7]',
                      shortcut: '快捷键',
                      host: '检测主机',
                      port: '端口',
                      ssid: 'Wi-Fi 名称',
                      state: '电源 ac / battery',
                    } as Record<string, string>
                  )[key] ?? key}
                  {Array.isArray(value) ? (
                    <JsonInput
                      value={value}
                      onChange={(v) => updateTrigger(i, { config: { ...t.config, [key]: v } })}
                    />
                  ) : (
                    <input
                      value={String(value ?? '')}
                      onChange={(e) =>
                        updateTrigger(i, {
                          config: {
                            ...t.config,
                            [key]: key === 'port' ? Number(e.target.value) : e.target.value,
                          },
                        })
                      }
                    />
                  )}
                </label>
              ))}
            {(scene.parameters?.length ?? 0) > 0 && (
              <label>
                触发参数（JSON）
                <JsonInput
                  value={t.parameters}
                  onChange={(v) => updateTrigger(i, { parameters: v as Record<string, unknown> })}
                />
              </label>
            )}
            {status && (
              <p className={status.kind === 'error' ? 'danger-text' : 'form-note'}>
                {status.message}
              </p>
            )}
            <button
              className="text-link danger-text"
              onClick={() =>
                change({ ...scene, triggers: scene.triggers?.filter((x) => x.id !== t.id) })
              }
            >
              删除触发器
            </button>
          </details>
        );
      })}
      <button
        className="button secondary"
        onClick={() =>
          change({
            ...scene,
            triggers: [
              ...(scene.triggers ?? []),
              {
                id: crypto.randomUUID(),
                kind: 'manual',
                enabled: true,
                config: {},
                parameters: {},
              },
            ],
          })
        }
      >
        添加触发器
      </button>
    </>
  );
}
