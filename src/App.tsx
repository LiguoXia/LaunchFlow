import { AutomationStatus } from './components/Automation';
import './phase3.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppWindow,
  Check,
  ChevronRight,
  CircleHelp,
  Home as HomeIcon,
  LayoutGrid,
  LoaderCircle,
  PanelTop,
  Settings as SettingsIcon,
  ShieldCheck,
  Workflow,
  X,
  History,
  ArrowUpRight,
} from 'lucide-react';
import { Modal } from './components/ui';
import type { Bootstrap, Page, Run, Scene } from './domain/types';
import { mergeRun, mergeRuns } from './domain/editor';
import { api, desktopAvailable } from './lib/api';
import { WorkspaceContext } from './lib/workspace';
import Home from './pages/Home';
import Scenes from './pages/Scenes';
import Editor from './pages/Editor';
import Runs from './pages/Runs';
import Applications from './pages/Applications';
import Settings from './pages/Settings';
import Workspaces from './pages/Workspaces';
import Permissions from './pages/Permissions';
import Transfer from './pages/Transfer';
import './phase4.css';
import RunConfiguration from './components/RunConfiguration';
import WorkspaceClose from './components/WorkspaceClose';
import './phase2.css';

const navigation = [
  { id: 'home', label: '概览', icon: HomeIcon },
  { id: 'scenes', label: '我的场景', icon: LayoutGrid },
  { id: 'editor', label: '工作流编辑器', icon: Workflow },
  { id: 'runs', label: '运行历史', icon: History },
  { id: 'applications', label: '应用库', icon: AppWindow },
  { id: 'workspaces', label: '工作区', icon: PanelTop },
  { id: 'permissions', label: '权限与凭据', icon: ShieldCheck },
  { id: 'transfer', label: '导入与导出', icon: ArrowUpRight },
] as const;
export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [page, setPage] = useState<Page>('home');
  const [selectedScene, setSelectedScene] = useState<Scene | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showCloseWorkspace, setShowCloseWorkspace] = useState(false);
  const [pendingDefault, setPendingDefault] = useState<string | null | undefined>(undefined);
  const savingDefault = useRef(false);
  const defaultRevision = useRef(0);
  const [name, setName] = useState('');
  const [runConfiguration, setRunConfiguration] = useState<Scene | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    body: string;
    resolve: (answer: boolean) => void;
  } | null>(null);
  const events = useRef<Run[]>([]);
  const refreshing = useRef<Promise<void> | null>(null);
  const refreshRequested = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useCallback((text: string, error = false) => {
    clearTimeout(toastTimer.current);
    setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(null), error ? 12000 : 4000);
  }, []);
  const refresh = useCallback((): Promise<void> => {
    // A caller after a write needs a snapshot fetched after that write. An older
    // in-flight bootstrap cannot satisfy it, even when the requests overlap.
    refreshRequested.current = true;
    if (refreshing.current) return refreshing.current;
    refreshing.current = (async () => {
      try {
        do {
          refreshRequested.current = false;
          events.current = [];
          const revision = defaultRevision.current;
          let next: Bootstrap;
          try {
            next = await api.bootstrap();
          } catch (error) {
            if (revision !== defaultRevision.current) refreshRequested.current = true;
            if (refreshRequested.current) continue;
            throw error;
          }
          // Discard superseded snapshots instead of briefly restoring old UI state.
          if (revision !== defaultRevision.current) refreshRequested.current = true;
          if (refreshRequested.current) continue;
          const duringFetch = events.current;
          setData((previous) => ({
            ...next,
            runs: duringFetch.reduce(mergeRun, mergeRuns(previous?.runs || [], next.runs)),
          }));
          setLoadError('');
        } while (refreshRequested.current);
      } finally {
        events.current = [];
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, []);
  const setDefaultScene = useCallback(async (sceneId: string | null) => {
    if (savingDefault.current) throw new Error('正在保存默认场景，请稍候。');
    savingDefault.current = true;
    defaultRevision.current++;
    setPendingDefault(sceneId);
    try {
      const savedId = await api.setDefault(sceneId);
      // Commit the command's acknowledgement immediately, without waiting for a
      // full bootstrap (which also loads run history and unrelated settings).
      setData((current) =>
        current
          ? {
              ...current,
              scenes: current.scenes.map((scene) => ({
                ...scene,
                isDefault: scene.id === savedId,
              })),
            }
          : current,
      );
      setSelectedScene((scene) => (scene ? { ...scene, isDefault: scene.id === savedId } : scene));
    } finally {
      defaultRevision.current++;
      savingDefault.current = false;
      // A rejected save reveals the last confirmed state again.
      setPendingDefault(undefined);
    }
  }, []);
  useEffect(() => {
    if (!desktopAvailable) return;
    let active = true;
    const cleanups: (() => void)[] = [];
    void (async () => {
      const unsubscribers = await Promise.all([
        api.onCloseWorkspace(() => {
          if (active) setShowCloseWorkspace(true);
        }),
        api.onRun((event) => {
          if (!active) return;
          if (refreshing.current) events.current = mergeRun(events.current, event.run);
          setData((old) => (old ? { ...old, runs: mergeRun(old.runs, event.run) } : old));
        }),
        api.onError((error) => {
          if (active) notify(error, true);
        }),
        api.onResync(() => {
          if (active) void refresh().catch((e) => notify(String(e), true));
        }),
        api.onTrigger((event) => {
          if (active)
            setData((old) =>
              old
                ? {
                    ...old,
                    triggerStatuses: [
                      event,
                      ...old.triggerStatuses.filter(
                        (s) => s.sceneId !== event.sceneId || s.triggerId !== event.triggerId,
                      ),
                    ],
                  }
                : old,
            );
        }),
        api.onConfigureScene((scene) => {
          if (active) setRunConfiguration(scene);
        }),
      ]);
      if (!active) {
        unsubscribers.forEach((fn) => fn());
        return;
      }
      cleanups.push(...unsubscribers);
      await refresh();
    })().catch((e) => {
      if (active) setLoadError(String(e));
    });
    return () => {
      active = false;
      cleanups.forEach((fn) => fn());
    };
  }, [notify, refresh]);
  useEffect(() => {
    if (data) {
      document.documentElement.dataset.theme = data.settings.theme;
      document.documentElement.dataset.platform = data.os;
    }
  }, [data?.settings.theme]);
  const perform = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      try {
        return await fn();
      } catch (e) {
        notify(String(e), true);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );
  const edit = (scene: Scene) => {
    setSelectedScene(scene);
    setPage('editor');
  };
  const launch = (scene: Scene, parameters: Record<string, unknown> = {}) =>
    perform(async () => {
      const sensitive = await api.sensitiveActions(scene.id);
      if (
        sensitive.length &&
        !(await confirm(
          '确认本次敏感操作',
          sensitive.join('；') + '。请确认目标应用、命令和输入内容。此授权仅限本次运行。',
        ))
      )
        return undefined;
      const result = await api.runScene(scene.id, parameters, sensitive.length > 0);
      setRunConfiguration(null);
      setData((old) => (old ? { ...old, runs: mergeRun(old.runs, result) } : old));
      setSelectedRun(result.id);
      setPage('runs');
      return result;
    });
  const run = async (scene: Scene) => {
    if (scene.parameters?.length) {
      setRunConfiguration(scene);
      return undefined;
    }
    return launch(scene);
  };
  const confirm = (title: string, body: string) =>
    new Promise<boolean>((resolve) => setConfirmation({ title, body, resolve }));
  const activeCount =
    data?.runs.filter((r) => ['running', 'paused', 'queued'].includes(r.status)).length || 0;
  const navigate = (destination: Page) => {
    setPage(destination);
    if (destination === 'runs') setSelectedRun(null);
    if (destination === 'editor' && !selectedScene && data?.scenes[0])
      setSelectedScene(data.scenes[0]);
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('home');
          }}
        >
          <span className="brand-mark">
            <span />
            <i />
          </span>
          <span>
            LaunchFlow<small>让工作，准备就绪</small>
          </span>
        </a>
        <div className="workspace-chip">
          <span className="workspace-avatar">W</span>
          <span>
            我的工作空间<small>个人 · 本地设备</small>
          </span>
          <ShieldCheck size={15} />
        </div>
        <div className="nav-label">工作空间</div>
        <nav>
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              onClick={() => navigate(id)}
            >
              <Icon size={18} strokeWidth={1.7} />
              <span>{label}</span>
              {id === 'scenes' && !!data?.scenes.length && <small>{data.scenes.length}</small>}
              {id === 'runs' && activeCount > 0 && (
                <span className="running-count">{activeCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="background-status">
            <span className="live-dot" />
            <div>
              {activeCount ? `${activeCount} 个场景正在运行` : '一切就绪，随时开始'}
              <small>{desktopAvailable ? '后台引擎已连接' : '浏览器预览 · 未连接桌面'}</small>
            </div>
          </div>
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => navigate('settings')}
          >
            <SettingsIcon size={18} strokeWidth={1.7} />
            <span>设置</span>
          </button>
          <div className="sidebar-footer">
            <span>LOCAL FIRST</span>
            <span>v{data?.version || '0.4.10'}</span>
          </div>
        </div>
      </aside>
      <main className="main-shell">
        {desktopAvailable && <AutomationStatus />}
        <header className="topbar">
          <div>
            <PanelTop size={16} />
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>{navigation.find((n) => n.id === page)?.label || '设置'}</strong>
          </div>
          <div>
            <span className="local-badge">
              <span />
              {desktopAvailable ? '本地运行' : '桌面应用'}
            </span>
            <button
              className="icon-button"
              aria-label="使用说明"
              title="使用说明"
              onClick={() =>
                notify(
                  '在应用库绑定路径 → 新建场景并添加步骤 → 保存并运行。登录启动可在设置中开启。',
                )
              }
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        {!desktopAvailable ? (
          <div className="desktop-required">
            <span className="scene-icon green">
              <AppWindow size={28} />
            </span>
            <h1>在桌面上，让工作准备就绪。</h1>
            <p>
              LaunchFlow 的执行引擎、SQLite 和托盘运行在 Tauri 桌面应用中。
              <br />
              浏览器预览不会模拟执行，也无法操作本机应用。
            </p>
            <code>npm run desktop</code>
            <small>在项目目录运行以上命令，打开完整桌面应用。</small>
          </div>
        ) : !data ? (
          <div className="desktop-required">
            {loadError ? (
              <>
                <h2>暂时无法连接本地引擎</h2>
                <p className="danger-text">{loadError}</p>
                <button
                  className="button primary"
                  onClick={() => void refresh().catch((e) => setLoadError(String(e)))}
                >
                  重试连接
                </button>
              </>
            ) : (
              <>
                <LoaderCircle className="spin" size={28} />
                <p>正在载入本地工作空间…</p>
              </>
            )}
          </div>
        ) : (
          <WorkspaceContext.Provider
            value={{
              data:
                pendingDefault === undefined
                  ? data
                  : {
                      ...data,
                      scenes: data.scenes.map((scene) => ({
                        ...scene,
                        isDefault: scene.id === pendingDefault,
                      })),
                    },
              page,
              setPage,
              busy,
              selectedScene,
              selectedRun,
              setSelectedRun,
              refresh,
              setDefaultScene,
              perform,
              edit,
              run,
              create: () => {
                setName('');
                setShowCreate(true);
              },
              notify,
              confirm,
              closeWorkspace: () => setShowCloseWorkspace(true),
            }}
          >
            {page === 'home' && <Home />}
            {page === 'scenes' && <Scenes />}
            {page === 'editor' && <Editor key={selectedScene?.id || 'none'} />}
            {page === 'runs' && <Runs />}
            {page === 'applications' && <Applications />}
            {page === 'settings' && <Settings />}
            {page === 'workspaces' && <Workspaces />}
            {page === 'permissions' && <Permissions />}
            {page === 'transfer' && <Transfer />}
            {showCloseWorkspace && <WorkspaceClose onClose={() => setShowCloseWorkspace(false)} />}
          </WorkspaceContext.Provider>
        )}
      </main>
      {toast && (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <InfoIcon /> : <Check size={18} />}
          <span>{toast.text}</span>
          <button className="icon-button" aria-label="关闭消息" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
      {showCreate && (
        <Modal title="创建新场景" onClose={() => setShowCreate(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const scene = await api.createScene(name.trim());
                await refresh();
                setShowCreate(false);
                edit(scene);
              });
            }}
          >
            <div className="modal-body form-stack">
              <p className="muted">一个场景，就是一套属于你的工作环境。</p>
              <label>
                场景名称
                <input
                  required
                  autoFocus
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如 Java 开发、每日办公"
                />
              </label>
              <div className="info-strip">
                <Workflow size={17} />
                创建后可添加应用、文件和就绪检测步骤。
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button secondary"
                onClick={() => setShowCreate(false)}
              >
                取消
              </button>
              <button className="button primary" disabled={busy || !name.trim()}>
                创建场景
                <ArrowUpRight size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {confirmation && (
        <Modal
          title={confirmation.title}
          onClose={() => {
            confirmation.resolve(false);
            setConfirmation(null);
          }}
        >
          <div className="modal-body">
            <p>{confirmation.body}</p>
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => {
                confirmation.resolve(false);
                setConfirmation(null);
              }}
            >
              取消
            </button>
            <button
              className="button danger"
              onClick={() => {
                confirmation.resolve(true);
                setConfirmation(null);
              }}
            >
              {confirmation.title.includes('删除') ? '确认删除' : '确认'}
            </button>
          </div>
        </Modal>
      )}
      {runConfiguration && (
        <RunConfiguration
          scene={runConfiguration}
          onClose={() => setRunConfiguration(null)}
          onRun={(values) => launch(runConfiguration, values)}
        />
      )}
    </div>
  );
}
function InfoIcon() {
  return <span className="error-symbol">!</span>;
}
