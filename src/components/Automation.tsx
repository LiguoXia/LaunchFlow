import { useEffect, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Crosshair, Eye, Play, Plus, Trash2 } from 'lucide-react';
import {
  automation,
  errorText,
  stableWindow,
  type Diagnostic,
  type Locator,
  type NativeWindow,
  type Session,
  type WindowTarget,
} from '../lib/automation';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import type { Run, Scene, WorkflowNode } from '../domain/types';
import { createNode, withSequence } from '../domain/editor';
import { isSequence, sequenceNodes } from '../domain/graph';
import { JsonInput } from './SceneAdvancedSettings';
import { Modal, Status } from './ui';

export function useAutomationSession() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    let alive = true;
    let receivedEvent = false;
    let cleanup: (() => void) | undefined;
    void automation
      .onSession((s) => {
        receivedEvent = true;
        if (alive) setSession(s);
      })
      .then((fn) => {
        if (alive) cleanup = fn;
        else fn();
        return automation.current();
      })
      .then((s) => {
        if (alive && !receivedEvent) setSession(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
      cleanup?.();
    };
  }, []);
  return session;
}
const active = (s: Session | null) =>
  !!s && ['starting', 'picking', 'recording', 'paused'].includes(s.status);
export function AutomationStatus() {
  const s = useAutomationSession();
  const [error, setError] = useState('');
  if (!active(s)) return null;
  const control = (op: string) => void automation.control(op).catch((e) => setError(errorText(e)));
  return (
    <div className="automation-live" role="status">
      <span className="record-dot" />
      <strong>
        {s?.mode === 'record'
          ? s.status === 'paused'
            ? 'Recording 已暂停'
            : 'Recording 录制中'
          : 'Picker · 单击选择 / Esc 取消'}
      </strong>
      {s?.mode === 'record' && (
        <button onClick={() => control(s.status === 'paused' ? 'resume' : 'pause')}>
          {s.status === 'paused' ? '继续录制' : 'Pause Recording'}
        </button>
      )}
      <button onClick={() => control('stop')}>Stop</button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

function WindowChooser({
  value,
  onChange,
}: {
  value: WindowTarget;
  onChange: (v: WindowTarget) => void;
}) {
  const [windows, setWindows] = useState<NativeWindow[]>([]);
  const [error, setError] = useState('');
  const refresh = () =>
    void automation
      .windows()
      .then(setWindows)
      .catch((e) => setError(errorText(e)));
  useEffect(refresh, []);
  return (
    <div className="window-chooser">
      <div className="row">
        <select
          aria-label="当前桌面窗口"
          value=""
          onChange={(e) => {
            const w = windows.find((w) => w.handle === e.target.value);
            if (w) onChange(stableWindow(w));
          }}
        >
          <option value="">选择当前桌面窗口…</option>
          {windows.map((w) => (
            <option value={w.handle} key={w.handle}>
              {w.application} · {w.title}
            </option>
          ))}
        </select>
        <button type="button" className="text-link" onClick={refresh}>
          刷新
        </button>
      </div>
      <label>
        Application
        <input
          value={value.application ?? ''}
          onChange={(e) => onChange({ ...value, application: e.target.value })}
        />
      </label>
      <label>
        Window title
        <input
          value={value.title ?? ''}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
      </label>
      {error && <small className="danger-text">{error}</small>}
    </div>
  );
}

export function LocatorEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: Locator[]) => void;
}) {
  const locators = Array.isArray(value) ? (value as Locator[]) : [];
  const [error, setError] = useState('');
  const [picking, setPicking] = useState<{ id: string; index: number } | null>(null);
  const session = useAutomationSession();
  const picked = useRef('');
  const update = (i: number, l: Locator) => onChange(locators.map((v, j) => (i === j ? l : v)));
  useEffect(() => {
    if (
      picking &&
      session?.id === picking.id &&
      session.status === 'selected' &&
      session.locator &&
      picked.current !== session.id
    ) {
      picked.current = session.id;
      update(picking.index, session.locator);
      setPicking(null);
    }
  }, [session, picking]);
  const pick = async (index: number) => {
    try {
      setError('');
      const s = await automation.start('pick', locators[index]?.window ?? {});
      setPicking({ id: s.id, index });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const asset = async (i: number, l: Locator) => {
    try {
      const path = await open({
        filters: [{ name: 'Template image', extensions: ['png', 'jpg', 'jpeg'] }],
      });
      if (typeof path === 'string') {
        const a = await automation.importAsset(path);
        update(i, { ...l, assetId: a.id });
      }
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="locator-editor">
      <p className="form-note">
        按 Accessibility → 文字 → OCR → 图像 → 相对位置 → 绝对坐标尝试。同类按列表顺序。
      </p>
      {locators.map((l, i) => (
        <div className="locator-card" key={i}>
          <div className="row">
            <strong>{i === 0 ? 'Primary' : `Fallback ${i}`}</strong>
            <button
              className="icon-button"
              title="删除 Locator"
              onClick={() => onChange(locators.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <select
            aria-label={`Locator ${i + 1} 类型`}
            value={l.kind === 'text' && l.ocr ? 'ocr' : l.kind}
            onChange={(e) => {
              const kind = e.target.value;
              update(i, {
                kind: kind === 'ocr' ? 'text' : kind,
                window: l.window,
                ...(kind === 'accessibility'
                  ? { role: 'Button', name: '', automationId: '', ancestorPath: [] }
                  : kind === 'text' || kind === 'ocr'
                    ? { text: '', ocr: kind === 'ocr' }
                    : kind === 'image'
                      ? { assetId: '', threshold: 0.94, scales: [1] }
                      : kind.includes('Coordinate')
                        ? { x: 0.5, y: 0.5 }
                        : {}),
              });
            }}
          >
            {[
              ['accessibility', 'Accessibility'],
              ['text', 'Accessible Text'],
              ['ocr', 'OCR Text'],
              ['image', 'Template Image'],
              ['relativeCoordinate', 'Relative Position'],
              ['absoluteCoordinate', 'Absolute Coordinate'],
              ['window', 'Window'],
            ].map(([k, n]) => (
              <option key={k} value={k}>
                {n}
              </option>
            ))}
          </select>
          <WindowChooser value={l.window} onChange={(window) => update(i, { ...l, window })} />
          {l.kind === 'accessibility' && (
            <>
              {(['role', 'name', 'automationId', 'className', 'frameworkId'] as const).map(
                (key) => (
                  <label key={key}>
                    {key}
                    <input
                      value={l[key] ?? ''}
                      onChange={(e) => update(i, { ...l, [key]: e.target.value })}
                    />
                  </label>
                ),
              )}
              <details>
                <summary>Ancestor hierarchy</summary>
                <JsonInput
                  value={l.ancestorPath ?? []}
                  label="ancestorPath"
                  onChange={(v) => update(i, { ...l, ancestorPath: v as unknown[] })}
                />
              </details>
            </>
          )}
          {l.kind === 'text' && (
            <label>
              匹配文字
              <input
                value={l.text ?? ''}
                onChange={(e) => update(i, { ...l, text: e.target.value })}
              />
            </label>
          )}
          {l.kind === 'image' && (
            <>
              <button className="button secondary" onClick={() => void asset(i, l)}>
                导入模板图片
              </button>
              <small className="asset-id">{l.assetId || '尚未选择模板'}</small>
              <label>
                Similarity threshold
                <input
                  type="number"
                  min="0.5"
                  max="1"
                  step="0.01"
                  value={l.threshold ?? 0.94}
                  onChange={(e) => update(i, { ...l, threshold: Number(e.target.value) })}
                />
              </label>
              <label>
                Scale tolerance
                <JsonInput
                  label="scales"
                  value={l.scales ?? [1]}
                  onChange={(v) => update(i, { ...l, scales: v as number[] })}
                />
              </label>
            </>
          )}
          {(l.kind === 'image' || (l.kind === 'text' && l.ocr)) && (
            <>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!l.region}
                  onChange={(e) =>
                    update(i, {
                      ...l,
                      region: e.target.checked
                        ? { x: 0, y: 0, width: 200, height: 100 }
                        : undefined,
                    })
                  }
                />
                限定窗口内区域
              </label>
              {l.region && (
                <>
                  <JsonInput
                    label="region"
                    value={l.region}
                    onChange={(v) => update(i, { ...l, region: v as Locator['region'] })}
                  />
                  {l.kind === 'image' && (
                    <button
                      className="button secondary"
                      onClick={() =>
                        void automation
                          .captureAsset(l.window, l.region!)
                          .then((a) => update(i, { ...l, assetId: a.id }))
                          .catch((e) => setError(errorText(e)))
                      }
                    >
                      截取区域作为模板
                    </button>
                  )}
                </>
              )}
            </>
          )}
          {l.kind.includes('Coordinate') && (
            <div className="form-grid">
              {(['x', 'y'] as const).map((k) => (
                <label key={k}>
                  {k}
                  {l.kind === 'relativeCoordinate' ? ' (0–1)' : ''}
                  <input
                    type="number"
                    step="0.01"
                    value={l[k] ?? 0}
                    onChange={(e) => update(i, { ...l, [k]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
          )}
          <button
            className="button secondary"
            disabled={active(session)}
            onClick={() => void pick(i)}
          >
            <Crosshair size={15} />
            Pick Element
          </button>
        </div>
      ))}
      <button
        className="button secondary"
        disabled={locators.length >= 8}
        onClick={() =>
          onChange([
            ...locators,
            {
              kind: 'accessibility',
              window: locators[0]?.window ?? {},
              role: 'Button',
              name: '',
              automationId: '',
            },
          ])
        }
      >
        <Plus size={15} />
        添加 Fallback
      </button>
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
      {picking && session?.id === picking.id && (
        <Modal
          title="Element Picker · 单击选择 / Esc 取消"
          onClose={() => {
            void automation.control('stop').catch(() => {});
            setPicking(null);
          }}
        >
          <div className="modal-body">
            <p>{session.status}</p>
            <ElementInfo element={session.element} />
            {session.error && <p role="alert">{session.error.message}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ElementInfo({ element }: { element: unknown }) {
  return (
    <pre className="element-info">
      {element ? JSON.stringify(element, null, 2) : '将鼠标移到目标应用中的元素上…'}
    </pre>
  );
}
export function AutomationDiagnostic({ value }: { value: unknown }) {
  const d = value as Diagnostic;
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  if (!d) return null;
  return (
    <div className="automation-diagnostic">
      <strong>Automation Debugger</strong>
      <p>
        {d.application} · {d.window?.title}
      </p>
      <small>
        Duration {d.durationMs} ms · Locator used{' '}
        {d.locatorUsed === undefined
          ? '—'
          : d.locatorUsed === 0
            ? 'Primary'
            : `Fallback ${d.locatorUsed}`}
      </small>
      <ol>
        {d.locatorAttempts?.map((a, i) => (
          <li key={i} className={a.success ? 'success-text' : 'danger-text'}>
            #{a.index + 1} {a.kind} · {a.durationMs} ms ·{' '}
            {a.success ? 'Matched' : `${a.error?.code}: ${a.error?.message}`}
          </li>
        ))}
      </ol>
      {d.error && (
        <p className="danger-text" role="alert">
          {d.error.code}: {d.error.message}
        </p>
      )}
      <details>
        <summary>Matched Element</summary>
        <ElementInfo element={d.matchedElement} />
      </details>
      {d.screenshot && (
        <button
          className="text-link"
          onClick={() =>
            void automation
              .image(d.screenshot!)
              .then(setImage)
              .catch((e) => setError(errorText(e)))
          }
        >
          查看 Screenshot
        </button>
      )}
      {image && (
        <img className="diagnostic-image" src={image} alt="GUI action diagnostic screenshot" />
      )}
      {error && <p>{error}</p>}
    </div>
  );
}

export function ActionTools({ scene, node }: { scene: Scene; node: WorkflowNode }) {
  const { confirm } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Run | null>(null);
  const [highlight, setHighlight] = useState<Diagnostic | null>(null);
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let alive = true;
    void api
      .onRun((e) => {
        if (alive) setResult((old) => (old?.id === e.run.id ? e.run : old));
      })
      .then((fn) => {
        if (alive) cleanup = fn;
        else fn();
      });
    return () => {
      alive = false;
      cleanup?.();
    };
  }, []);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const running = result && ['running', 'queued', 'paused'].includes(result.status);
  return (
    <div className="action-tools">
      {['gui.click', 'gui.doubleClick', 'gui.rightClick'].includes(node.type) &&
        !!(node.config.locators as Locator[] | undefined)?.length &&
        (node.config.locators as Locator[] | undefined)?.every(
          (l) => l.kind === 'window' || (l.kind === 'accessibility' && l.role === 'Window'),
        ) && (
          <p className="danger-text" role="alert">
            此点击只定位到整个窗口，缺少具体位置。请重新录制该点击，或用 Pick Element 重新拾取。
          </p>
        )}
      {!!scene.parameters?.length && (
        <details>
          <summary>Test Action 参数</summary>
          <JsonInput
            label="test parameters"
            value={parameters}
            onChange={(v) => setParameters(v as Record<string, unknown>)}
          />
        </details>
      )}
      <div className="row">
        <button
          className="button secondary"
          disabled={busy || !!running}
          onClick={() =>
            void action(async () =>
              setHighlight(await automation.highlight(node.config.locators as Locator[])),
            )
          }
        >
          <Eye size={14} />
          Highlight
        </button>
        <button
          className="button primary"
          disabled={busy || !!running}
          onClick={() =>
            void action(async () => {
              let run;
              try {
                run = await automation.test(scene, node.id, parameters);
              } catch (error) {
                if (!String(error).includes('sensitiveApprovalRequired:')) throw error;
                if (
                  !(await confirm(
                    '确认单步敏感操作',
                    `将测试 ${node.name}。请核对目标窗口与输入；此授权仅限本次测试。`,
                  ))
                )
                  return;
                run = await automation.test(scene, node.id, parameters, true);
              }
              setResult(run);
              const current = await api.bootstrap();
              setResult(current.runs.find((r) => r.id === run.id) ?? run);
            })
          }
        >
          <Play size={14} />
          Test Action
        </button>
      </div>
      {running && (
        <button
          className="text-link"
          onClick={() => void api.stopRun(result.id).catch((e) => setError(errorText(e)))}
        >
          Cancel Test Action
        </button>
      )}
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
      {highlight && (
        <details>
          <summary>Highlight 已完成</summary>
          <AutomationDiagnostic value={highlight} />
        </details>
      )}
      {result && (
        <>
          <Status status={result.status} />
          <p>{result.error}</p>
          <AutomationDiagnostic
            value={(result.nodeRuns[0]?.output as { automation?: unknown })?.automation}
          />
        </>
      )}
    </div>
  );
}

export function AutomationToolbar({
  scene,
  onChange,
}: {
  scene: Scene;
  onChange: (s: Scene) => void;
}) {
  const { data, notify } = useWorkspace();
  const [setup, setSetup] = useState(false);
  const [target, setTarget] = useState<WindowTarget>({});
  const [review, setReview] = useState<Record<string, unknown>[] | null>(null);
  const [reviewWarnings, setReviewWarnings] = useState<string[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const reviewGate = useRef(false);
  const session = useAutomationSession();
  const finished = useRef('');
  useEffect(() => {
    if (
      session?.mode === 'record' &&
      session.status === 'stopped' &&
      !session.reviewed &&
      // Native recorders prepend activateWindow even when no user action was recorded.
      (session.actions.some((action) => action.kind !== 'activateWindow') ||
        !!session.warnings?.length) &&
      finished.current !== session.id
    ) {
      finished.current = session.id;
      setReview(session.actions);
      setReviewWarnings(session.warnings ?? []);
    }
  }, [session]);
  const safely = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      notify(errorText(e), true);
    }
  };
  const finishReview = async (apply?: () => void) => {
    if (reviewGate.current) return;
    reviewGate.current = true;
    setReviewBusy(true);
    try {
      await automation.acknowledgeRecording(finished.current);
      apply?.();
      setReview(null);
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      reviewGate.current = false;
      setReviewBusy(false);
    }
  };
  return (
    <>
      <div className="automation-toolbar">
        <button
          className="button secondary"
          disabled={active(session)}
          onClick={() => setSetup(true)}
        >
          Start Recording
        </button>
        <button className="text-link" onClick={() => void safely(() => automation.harness())}>
          打开 Test Harness
        </button>
        <button
          className="text-link"
          onClick={() =>
            void safely(async () => {
              const path = await save({
                defaultPath: `${scene.name}.launchflow.zip`,
                filters: [{ name: 'LaunchFlow + assets', extensions: ['zip'] }],
              });
              if (path) {
                await automation.export(scene, path);
                notify('Scene 与图片资产已导出');
              }
            })
          }
        >
          导出 Scene + Assets
        </button>
      </div>
      {setup && (
        <Modal title="Start Recording" onClose={() => setSetup(false)}>
          <div className="modal-body form-stack">
            <p>选择一个目标窗口。开始后才记录操作；密码字段生成待绑定的 Secret 引用。</p>
            <p>
              中文输入记录输入法提交后的文字，请完成候选词选择再停止录制。若目标应用未公开输入框，会提示文字未能捕获。
            </p>
            <WindowChooser value={target} onChange={setTarget} />
          </div>
          <div className="modal-footer">
            <button
              className="button primary"
              onClick={() =>
                void safely(async () => {
                  await automation.start('record', target);
                  setSetup(false);
                })
              }
            >
              Start Recording
            </button>
          </div>
        </Modal>
      )}
      {review && (
        <Modal title="审阅录制 Actions" canClose={!reviewBusy} onClose={() => void finishReview()}>
          <div className="modal-body recording-review">
            {reviewWarnings.map((message) => (
              <p className="danger-text" role="alert" key={message}>
                {message}
              </p>
            ))}
            <p>
              可编辑、删除或调整动作顺序。
              {isSequence(scene)
                ? '确认后追加到顺序流程末尾。'
                : '确认后插入独立分支；请在画布连接依赖。'}
            </p>
            {review.map((a, i) => (
              <div className="locator-card" key={i}>
                <div className="row">
                  <strong>
                    {i + 1}. {String(a.kind)}
                  </strong>
                  <button
                    className="text-link"
                    disabled={i === 0}
                    onClick={() => {
                      const next = [...review];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      setReview(next);
                    }}
                  >
                    上移
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`删除录制动作 ${i + 1}`}
                    onClick={() => setReview(review.filter((_, j) => i !== j))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <JsonInput
                  label={`Action ${i + 1}`}
                  value={a}
                  onChange={(v) =>
                    setReview(review.map((a, j) => (i === j ? (v as Record<string, unknown>) : a)))
                  }
                />
                {a.kind === 'inputText' && (
                  <label>
                    录制文字
                    <textarea
                      aria-label={`录制文字 ${i + 1}`}
                      value={String(a.text ?? '')}
                      onChange={(e) =>
                        setReview(
                          review.map((action, j) =>
                            i === j ? { ...action, text: e.target.value } : action,
                          ),
                        )
                      }
                    />
                  </label>
                )}
              </div>
            ))}
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              disabled={reviewBusy}
              onClick={() => void finishReview()}
            >
              放弃录制
            </button>
            <button
              className="button primary"
              disabled={reviewBusy || !review.length}
              onClick={() => {
                try {
                  const nodes = review.map((a) => {
                    const { kind, ...config } = a;
                    const definition = data.definitions.find((d) => d.nodeType === `gui.${kind}`);
                    if (!definition) throw new Error(`未知动作 ${String(kind)}`);
                    const node = createNode(definition);
                    return { ...node, config: { ...node.config, ...config } };
                  });
                  let next: Scene;
                  if (isSequence(scene)) {
                    next = withSequence(scene, [...sequenceNodes(scene), ...nodes]);
                  } else {
                    next = {
                      ...scene,
                      workflow: {
                        ...scene.workflow,
                        nodes: [...scene.workflow.nodes, ...nodes],
                        edges: [
                          ...scene.workflow.edges,
                          ...nodes.slice(1).map((n, i) => ({
                            id: crypto.randomUUID(),
                            from: nodes[i].id,
                            to: n.id,
                            outlet: 'success' as const,
                          })),
                        ],
                      },
                    };
                  }
                  void finishReview(() => {
                    onChange(next);
                    notify('录制动作已插入，可在步骤配置中继续编辑');
                  });
                } catch (e) {
                  notify(errorText(e), true);
                }
              }}
            >
              确认并插入 Workflow
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function AutomationPermissions() {
  const [permissions, setPermissions] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const refresh = () =>
    void automation
      .permissions()
      .then(setPermissions)
      .catch((e) => setError(errorText(e)));
  useEffect(refresh, []);
  return (
    <section className="settings-section">
      <h2>GUI Automation 权限</h2>
      <p>
        Windows 目标应用应与 LaunchFlow 具有相同权限级别。macOS 需授权辅助功能；截图 / OCR
        还需要屏幕录制权限。
      </p>
      {Object.entries(permissions).map(([key, value]) => (
        <div className="permission-row" key={key}>
          <span>{key}</span>
          <strong>{value}</strong>
          {value !== 'notRequired' && (
            <button
              className="text-link"
              onClick={() => void automation.settings(key).catch((e) => setError(errorText(e)))}
            >
              Open System Settings
            </button>
          )}
        </div>
      ))}
      <button className="button secondary" onClick={refresh}>
        重新检查权限
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
