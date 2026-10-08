import { ActionTools, AutomationToolbar, LocatorEditor } from '../components/Automation';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  GripVertical,
  Info,
  Play,
  Plus,
  Redo2,
  Save,
  Search,
  Settings2,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { Empty, NodeIcon } from '../components/ui';
import ApplicationIcon from '../components/ApplicationIcon';
import WorkflowNodeIcon from '../components/WorkflowNodeIcon';
import {
  createNode,
  duplicateNode,
  moveNode,
  removeNode,
  validateNode,
  withSequence,
} from '../domain/editor';
import type { FieldDefinition, Scene, ValidationIssue, WorkflowNode } from '../domain/types';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
const AdvancedCanvas = lazy(() => import('../components/AdvancedCanvas'));
import SceneAdvancedSettings, { JsonInput } from '../components/SceneAdvancedSettings';
import { isSequence, sequenceNodes } from '../domain/graph';

export default function Editor() {
  const { data, selectedScene, setPage, edit, run, refresh, notify } = useWorkspace();
  const [draft, setDraft] = useState<Scene | null>(selectedScene);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [saveStatus, setSaveStatus] = useState('已保存');
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [showSceneSettings, setShowSceneSettings] = useState(false);
  const [history, setHistory] = useState<{ past: Scene[]; future: Scene[] }>({
    past: [],
    future: [],
  });
  const latest = useRef<Scene | null>(selectedScene);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const persist = (scene: Scene) => {
    writes.current = writes.current.catch(() => {}).then(() => api.saveDraft(scene));
    return writes.current;
  };
  useEffect(() => {
    let alive = true;
    if (selectedScene) {
      api
        .getDraft(selectedScene.id)
        .then((saved) => {
          if (!alive) return;
          if (saved && saved.version === selectedScene.version) {
            latest.current = saved;
            setDraft(saved);
            dirty.current = true;
            setSaveStatus('已恢复草稿');
          } else if (saved) {
            notify('检测到旧版本草稿，当前使用最新场景版本');
          }
          setLoaded(true);
        })
        .catch((e) => {
          if (alive) {
            notify(String(e), true);
            setLoaded(true);
          }
        });
    } else {
      setLoaded(true);
    }
    return () => {
      alive = false;
      clearTimeout(timer.current);
      if (dirty.current && latest.current)
        void persist(latest.current).catch((e) => notify(`草稿保存失败：${String(e)}`, true));
    };
    // An editor instance is keyed by scene ID; saving a new revision must not reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!loaded || !draft) return;
    let alive = true;
    const handle = setTimeout(() => {
      void api
        .validate(draft)
        .then((v) => {
          if (alive) setIssues(v);
        })
        .catch((e) => {
          if (alive) notify(String(e), true);
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [draft, loaded, notify]);
  const change = (scene: Scene, track = true) => {
    scene = { ...scene, version: latest.current?.version ?? scene.version };
    if (track && latest.current) {
      const previous = structuredClone(latest.current);
      setHistory((h) => ({ past: [...h.past.slice(-49), previous], future: [] }));
    }
    latest.current = scene;
    dirty.current = true;
    setDraft(scene);
    setSaveStatus('正在保存草稿…');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void persist(scene)
        .then(() => setSaveStatus('草稿已保存'))
        .catch((e) => {
          setSaveStatus('草稿保存失败');
          notify(String(e), true);
        });
    }, 700);
  };
  const undo = () => {
    if (history.past.length && draft) {
      const previous = history.past[history.past.length - 1];
      setHistory({ past: history.past.slice(0, -1), future: [draft, ...history.future] });
      change(previous, false);
    }
  };
  const redo = () => {
    if (history.future.length && draft) {
      const next = history.future[0];
      setHistory({ past: [...history.past, draft], future: history.future.slice(1) });
      change(next, false);
    }
  };
  const save = async (shouldRun = false) => {
    if (!latest.current || saving) return;
    setSaving(true);
    clearTimeout(timer.current);
    try {
      await writes.current;
      const scene = await api.saveScene(latest.current);
      latest.current = scene;
      dirty.current = false;
      setDraft(scene);
      edit(scene);
      setSaveStatus('已保存');
      await refresh();
      if (shouldRun) await run(scene);
      else notify('场景已保存');
    } catch (e) {
      setSaveStatus('保存失败 · 草稿保留');
      notify(String(e), true);
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  if (!draft)
    return (
      <div className="page">
        <Empty
          title="选择一个场景开始编辑"
          description="简单的顺序卡片，也可以编排出可靠的工作环境。"
        >
          <button className="button primary" onClick={() => setPage('scenes')}>
            查看场景
          </button>
        </Empty>
      </div>
    );
  const node = draft.workflow.nodes.find((n) => n.id === selected);
  const definition = data.definitions.find((d) => d.nodeType === node?.type);
  const updateNode = (patch: Partial<WorkflowNode>) => {
    if (node)
      change({
        ...draft,
        workflow: {
          ...draft.workflow,
          nodes: draft.workflow.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)),
        },
      });
  };
  const addNode = (nodeType: string) => {
    const definition = data.definitions.find((d) => d.nodeType === nodeType);
    if (!definition) return;
    const next = createNode(definition);
    const useCanvas = advanced || !isSequence(draft) || nodeType.startsWith('flow.');
    if (useCanvas) {
      next.position = {
        x: 80 + (draft.workflow.nodes.length % 3) * 300,
        y: 80 + Math.floor(draft.workflow.nodes.length / 3) * 155,
      };
      change({ ...draft, workflow: { ...draft.workflow, nodes: [...draft.workflow.nodes, next] } });
      setAdvanced(true);
    } else change(withSequence(draft, [...sequenceNodes(draft), next]));
    setSelected(next.id);
    setShowSceneSettings(false);
  };
  const nodeErrors = node ? validateNode(node, definition) : [];
  return (
    <div className="editor-page">
      <div className="editor-heading">
        <button className="icon-button" aria-label="返回场景" onClick={() => setPage('scenes')}>
          <ArrowLeft size={19} />
        </button>
        <div className="editor-title">
          <h1>{draft.name}</h1>
          <span>
            <span className="live-dot" />
            {saveStatus} · v{draft.version}
          </span>
        </div>
        <div className="spacer" />
        <div className="segmented mode-label">
          <button
            className={!advanced && isSequence(draft) ? 'active' : ''}
            disabled={!isSequence(draft)}
            title={!isSequence(draft) ? '分支流程请在高级画布编辑' : ''}
            onClick={() => setAdvanced(false)}
          >
            简单编排
          </button>
          <button
            className={advanced || !isSequence(draft) ? 'active' : ''}
            onClick={() => setAdvanced(true)}
          >
            高级画布
          </button>
        </div>
        <button
          className="button secondary"
          disabled={saving || !loaded}
          onClick={() => void save()}
        >
          <Save size={15} />
          保存
        </button>
        <button
          className="button primary"
          disabled={saving || !loaded || !draft.workflow.nodes.length}
          onClick={() => void save(true)}
        >
          <Play size={15} />
          保存并运行
        </button>
      </div>
      <AutomationToolbar scene={draft} onChange={change} />
      <div className="editor-workspace">
        <aside className="node-palette">
          <div className="palette-heading">
            <h2>添加步骤</h2>
            <Plus size={17} />
          </div>
          <label className="search-input compact">
            <Search size={15} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索步骤"
              aria-label="搜索步骤"
            />
          </label>
          {(['application', 'wait', 'system', 'flow', 'gui', 'workspace'] as const).map(
            (category) => (
              <div className="palette-category" key={category}>
                <h3>
                  {
                    {
                      application: '应用与文件',
                      wait: '就绪检测',
                      system: '系统',
                      flow: '流程控制',
                      gui: 'GUI Automation',
                      workspace: '工作区',
                    }[category]
                  }
                </h3>
                {data.definitions
                  .filter(
                    (d) => d.category === category && `${d.name} ${d.description}`.includes(query),
                  )
                  .map((d) => (
                    <button
                      className={`palette-item ${d.category}`}
                      key={d.nodeType}
                      disabled={!loaded || saving}
                      title={d.description}
                      onClick={() => addNode(d.nodeType)}
                    >
                      <span>
                        <NodeIcon type={d.nodeType} size={16} />
                      </span>
                      <div>{d.name}</div>
                      <Plus size={13} />
                    </button>
                  ))}
              </div>
            ),
          )}
          <div className="palette-tip">
            <Info size={17} />
            <p>启动应用后，使用进程或端口检测确认就绪，再执行下一步。</p>
          </div>
        </aside>
        {advanced || !isSequence(draft) ? (
          <Suspense fallback={<section className="sequence-canvas">正在载入画布…</section>}>
            <AdvancedCanvas
              scene={draft}
              onChange={change}
              selected={selected}
              onSelect={(id) => {
                setSelected(id);
                setShowSceneSettings(false);
              }}
              onSettings={() => {
                setShowSceneSettings(true);
                setSelected(null);
              }}
              undo={undo}
              redo={redo}
              canUndo={!!history.past.length}
              canRedo={!!history.future.length}
              disabled={saving || !loaded}
            />
          </Suspense>
        ) : (
          <section className="sequence-canvas">
            <div className="canvas-toolbar">
              <span>{draft.workflow.nodes.length} 个步骤 · 顺序执行</span>
              <div>
                <button
                  className="icon-button"
                  aria-label="撤销"
                  title="撤销"
                  disabled={!history.past.length || saving}
                  onClick={undo}
                >
                  <Undo2 size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="重做"
                  title="重做"
                  disabled={!history.future.length || saving}
                  onClick={redo}
                >
                  <Redo2 size={16} />
                </button>
                <button
                  className={`icon-button ${showSceneSettings ? 'selected' : ''}`}
                  aria-label="场景设置"
                  title="场景设置"
                  onClick={() => {
                    setShowSceneSettings(true);
                    setSelected(null);
                  }}
                >
                  <Settings2 size={16} />
                </button>
              </div>
            </div>
            <div className="sequence-start">
              <span className="start-dot" />
              <span>开始场景</span>
            </div>
            {!draft.workflow.nodes.length && (
              <div className="canvas-empty">
                <div>
                  <Plus size={26} />
                </div>
                <h3>把第一步放在这里</h3>
                <p>点击左侧节点，构建你的工作流。</p>
                <button
                  className="button secondary"
                  disabled={!loaded}
                  onClick={() => addNode('application.launch')}
                >
                  添加启动应用
                </button>
              </div>
            )}
            {sequenceNodes(draft).map((n, index) => (
              <div
                className="sequence-step"
                key={n.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!saving)
                    change(moveNode(draft, e.dataTransfer.getData('text/launchflow-node'), index));
                }}
              >
                <div className="sequence-line" />
                <div
                  className={`node-card ${selected === n.id ? 'selected' : ''} ${!n.enabled ? 'disabled' : ''}`}
                  onClick={() => {
                    setSelected(n.id);
                    setShowSceneSettings(false);
                  }}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setSelected(n.id);
                      setShowSceneSettings(false);
                    }
                  }}
                  role="button"
                  aria-label={`编辑步骤 ${n.name}`}
                >
                  <div
                    className="node-card-header"
                    draggable={!saving}
                    onDragStart={(e) => e.dataTransfer.setData('text/launchflow-node', n.id)}
                  >
                    <GripVertical size={15} className="grip" />
                    <span className={`node-symbol ${n.type.split('.')[0]}`}>
                      <WorkflowNodeIcon node={n} />
                    </span>
                    <div className="node-card-copy">
                      <strong>{n.name}</strong>
                      <small>
                        {data.definitions.find((d) => d.nodeType === n.type)?.name}{' '}
                        {!n.enabled && '· 已禁用'}
                      </small>
                    </div>
                    <span className="step-number">{(index + 1).toString().padStart(2, '0')}</span>
                  </div>
                  <div className="node-preview">
                    {n.type.startsWith('gui.')
                      ? guiPreview(n)
                      : n.type === 'application.launch'
                        ? data.profiles.find((p) => p.id === n.config.applicationId)?.displayName ||
                          '选择要启动的应用'
                        : n.type === 'wait.port'
                          ? `${n.config.host}:${n.config.port}`
                          : n.type === 'system.delay'
                            ? `${Number(n.config.durationMs) / 1000} 秒`
                            : String(
                                n.config.target ||
                                  n.config.processName ||
                                  n.config.program ||
                                  '待配置',
                              )}
                  </div>
                  <div className="node-card-controls">
                    <span>超时 {n.timeoutMs / 1000}s</span>
                    <div>
                      <button
                        className="icon-button"
                        title="上移"
                        aria-label={`上移步骤 ${n.name}`}
                        disabled={index === 0 || saving}
                        onClick={(e) => {
                          e.stopPropagation();
                          change(moveNode(draft, n.id, index - 1));
                        }}
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        className="icon-button"
                        title="下移"
                        aria-label={`下移步骤 ${n.name}`}
                        disabled={index === draft.workflow.nodes.length - 1 || saving}
                        onClick={(e) => {
                          e.stopPropagation();
                          change(moveNode(draft, n.id, index + 1));
                        }}
                      >
                        <ArrowDown size={13} />
                      </button>
                      <button
                        className="icon-button"
                        title="复制节点"
                        aria-label={`复制步骤 ${n.name}`}
                        disabled={saving}
                        onClick={(e) => {
                          e.stopPropagation();
                          change(duplicateNode(draft, n.id));
                        }}
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        className="icon-button danger-hover"
                        title="删除节点"
                        aria-label={`删除步骤 ${n.name}`}
                        disabled={saving}
                        onClick={(e) => {
                          e.stopPropagation();
                          change(removeNode(draft, n.id));
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {draft.workflow.nodes.length > 0 && (
              <div className="sequence-end">
                <div className="sequence-line" />
                <span>
                  <Check size={14} />
                  完成
                </span>
              </div>
            )}
          </section>
        )}
        <aside className="inspector">
          <div className="inspector-heading">
            <h2>{showSceneSettings ? '场景设置' : node ? '步骤配置' : '工作流检查'}</h2>
            {node && (
              <button
                className="icon-button"
                aria-label="关闭步骤配置"
                onClick={() => setSelected(null)}
              >
                <X size={16} />
              </button>
            )}
          </div>
          <fieldset disabled={saving || !loaded} className="inspector-fields">
            {showSceneSettings ? (
              <div className="form-stack">
                <label>
                  场景名称
                  <input
                    value={draft.name}
                    onChange={(e) => change({ ...draft, name: e.target.value })}
                    maxLength={200}
                  />
                </label>
                <label>
                  描述
                  <textarea
                    value={draft.description}
                    rows={3}
                    onChange={(e) => change({ ...draft, description: e.target.value })}
                  />
                </label>
                <label>
                  图标
                  <select
                    value={draft.icon}
                    onChange={(e) => change({ ...draft, icon: e.target.value })}
                  >
                    <option value="code">代码</option>
                    <option value="terminal">终端</option>
                    <option value="globe">浏览器</option>
                    <option value="folder">文件夹</option>
                  </select>
                </label>
                <label>
                  颜色
                  <select
                    value={draft.color}
                    onChange={(e) => change({ ...draft, color: e.target.value })}
                  >
                    <option value="green">绿色</option>
                    <option value="blue">蓝色</option>
                    <option value="violet">紫色</option>
                    <option value="orange">橙色</option>
                  </select>
                </label>
                <p className="form-note">
                  命令与 GUI
                  输入统一由下方敏感操作策略控制。旧版场景升级后，请重新核对登录执行权限。
                </p>
                <SceneAdvancedSettings
                  scene={draft}
                  change={change}
                  definitions={data.triggerDefinitions ?? []}
                  statuses={data.triggerStatuses ?? []}
                />
              </div>
            ) : node && definition ? (
              <div className="form-stack">
                <div className="inspector-node-type">
                  <WorkflowNodeIcon node={node} />
                  <div>
                    <strong>{definition.name}</strong>
                    <small>{definition.description}</small>
                  </div>
                </div>
                <label>
                  步骤名称
                  <input value={node.name} onChange={(e) => updateNode({ name: e.target.value })} />
                </label>
                {node.type.startsWith('gui.') && (
                  <ActionTools key={node.id} scene={draft} node={node} />
                )}
                {definition.fields
                  .filter(
                    (field) =>
                      node.type !== 'flow.condition' ||
                      conditionFields(String(node.config.kind)).includes(field.key),
                  )
                  .map((field) => (
                    <ConfigField
                      key={`${node.id}-${field.key}`}
                      field={field}
                      value={node.config[field.key]}
                      onChange={(value) =>
                        updateNode({ config: { ...node.config, [field.key]: value } })
                      }
                    />
                  ))}
                <div className="form-divider" />
                <label>
                  超时（毫秒）
                  <input
                    type="number"
                    min={1}
                    max={86400000}
                    value={node.timeoutMs}
                    onChange={(e) => updateNode({ timeoutMs: Number(e.target.value) })}
                  />
                  <small>每次尝试的超时，包含应用启动和 Ready 检测。</small>
                </label>
                <label>
                  失败策略
                  <select
                    value={node.failurePolicy}
                    onChange={(e) =>
                      updateNode({ failurePolicy: e.target.value as WorkflowNode['failurePolicy'] })
                    }
                  >
                    <option value="stopWorkflow">停止工作流</option>
                    <option value="skipAndContinue">跳过并继续</option>
                    <option value="askUser">暂停并询问</option>
                    <option value="failureBranch">走 failure 分支</option>
                  </select>
                </label>
                <label>
                  重试次数
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={node.retryPolicy.maxRetries}
                    onChange={(e) =>
                      updateNode({
                        retryPolicy: { ...node.retryPolicy, maxRetries: Number(e.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  重试间隔（毫秒）
                  <input
                    type="number"
                    min={0}
                    max={3600000}
                    value={node.retryPolicy.delayMs}
                    onChange={(e) =>
                      updateNode({
                        retryPolicy: { ...node.retryPolicy, delayMs: Number(e.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  运行平台
                  <select
                    value={node.platformConstraint.length === 1 ? node.platformConstraint[0] : ''}
                    onChange={(e) =>
                      updateNode({ platformConstraint: e.target.value ? [e.target.value] : [] })
                    }
                  >
                    <option value="">Windows 与 macOS</option>
                    <option value="windows">仅 Windows</option>
                    <option value="macos">仅 macOS</option>
                  </select>
                  <small>约束只检查被条件分支选中的节点。</small>
                </label>
                <label>
                  节点输出引用
                  <code className="variable-reference">{'${node.' + node.id + '.output}'}</code>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={node.enabled}
                    onChange={(e) => updateNode({ enabled: e.target.checked })}
                  />
                  <span>启用此步骤</span>
                </label>
                {nodeErrors.length > 0 && (
                  <div className="field-errors">
                    {nodeErrors.map((e, i) => (
                      <p key={i}>{e}</p>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="inspector-intro">
                <Settings2 size={27} />
                <h3>每一步，都可掌控</h3>
                <p>选择工作流中的步骤，配置应用、参数和等待条件。</p>
                <button className="button secondary" onClick={() => setShowSceneSettings(true)}>
                  编辑场景信息
                </button>
              </div>
            )}
          </fieldset>
          <div className={`validation-panel ${issues.length ? 'has-issues' : ''}`}>
            <strong>{issues.length ? `${issues.length} 项需要配置` : '配置检查通过'}</strong>
            {issues.slice(0, 6).map((i, index) => (
              <button
                key={index}
                onClick={() => {
                  setSelected(i.nodeId);
                  setShowSceneSettings(false);
                }}
              >
                <ChevronDown size={12} />
                <span>{i.message}</span>
              </button>
            ))}
            {!issues.length && <p>保存后即可执行。</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
function ConfigField({
  field,
  value,
  onChange,
}: {
  field: FieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { data, perform, setPage } = useWorkspace();
  const text = typeof value === 'string' ? value : '';
  const browse = () =>
    void perform(async () => {
      const path = await open({ directory: field.kind === 'folder', multiple: false });
      if (path) onChange(path);
    });
  if (field.kind === 'boolean')
    return (
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {field.label}
          <small>{field.hint}</small>
        </span>
      </label>
    );
  return (
    <label>
      {field.label}
      {field.required && <span className="required"> *</span>}
      {field.kind === 'locators' ? (
        <LocatorEditor value={value} onChange={onChange} />
      ) : field.kind === 'json' ? (
        <JsonInput value={value} label={field.label} onChange={onChange} />
      ) : field.kind === 'scene' ? (
        <select value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">选择子场景…</option>
          {data.scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      ) : field.kind === 'application' ? (
        <>
          <span className="application-select">
            <ApplicationIcon profile={data.profiles.find((p) => p.id === text)} size={24} />
            <select value={text} onChange={(e) => onChange(e.target.value)}>
              <option value="">选择应用…</option>
              {data.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </span>
          {!data.profiles.length && (
            <button type="button" className="text-link" onClick={() => setPage('applications')}>
              先去应用库添加应用 →
            </button>
          )}
        </>
      ) : field.kind === 'arguments' ? (
        <textarea
          rows={3}
          value={Array.isArray(value) ? value.join('\n') : ''}
          onChange={(e) => onChange(e.target.value ? e.target.value.split('\n') : [])}
        />
      ) : field.kind === 'select' ? (
        <select value={text} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {({ skip: '跳过重复启动', newInstance: '启动新实例' } as Record<string, string>)[
                option
              ] || option}
            </option>
          ))}
        </select>
      ) : field.kind === 'number' ? (
        <input
          type="text"
          value={typeof value === 'number' || typeof value === 'string' ? value : ''}
          onChange={(e) =>
            onChange(
              e.target.value.trim() !== '' && Number.isFinite(Number(e.target.value))
                ? Number(e.target.value)
                : e.target.value,
            )
          }
        />
      ) : ['file', 'folder'].includes(field.kind) ? (
        <div className="input-with-action">
          <input value={text} onChange={(e) => onChange(e.target.value)} />
          <button
            type="button"
            className="icon-button"
            aria-label={`浏览${field.label}`}
            onClick={browse}
          >
            <FolderOpen size={16} />
          </button>
        </div>
      ) : (
        <input value={text} onChange={(e) => onChange(e.target.value)} />
      )}
      <small>{field.hint}</small>
    </label>
  );
}
function conditionFields(kind: string): string[] {
  return [
    'kind',
    ...((
      {
        os: ['value'],
        process: ['value'],
        window: ['value'],
        file: ['value'],
        directory: ['value'],
        environment: ['value'],
        power: ['value'],
        tcp: ['host', 'port'],
        network: ['host', 'port'],
        http: ['url', 'expectedStatus'],
        command: ['program', 'arguments', 'exitCode'],
        time: ['start', 'end'],
        weekday: ['weekdays'],
        monitors: ['count'],
      } as Record<string, string[]>
    )[kind] ?? []),
  ];
}

function guiPreview(node: WorkflowNode): string {
  const locator = (
    node.config.locators as
      | {
          name?: string;
          automationId?: string;
          text?: string;
          window?: { title?: string; application?: string };
        }[]
      | undefined
  )?.[0];
  return (
    locator?.name ||
    locator?.automationId ||
    locator?.text ||
    locator?.window?.title ||
    locator?.window?.application ||
    '选择目标窗口与元素'
  );
}
