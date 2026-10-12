import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { AppWindow, Monitor, FolderOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import ApplicationCapture from '../components/ApplicationCapture';
import ApplicationIcon from '../components/ApplicationIcon';
import { Empty, Modal, PageTitle } from '../components/ui';
import type { ApplicationProfile } from '../domain/types';
import { api, type ApplicationAuthorization } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
export default function Applications() {
  const { data, perform, refresh, busy, confirm, notify } = useWorkspace();
  const [draft, setDraft] = useState<ApplicationProfile | null>(null);
  const [query, setQuery] = useState('');
  const [captureSource, setCaptureSource] = useState<'workspace' | 'system' | null>(null);
  const [authorization, setAuthorization] = useState<ApplicationAuthorization | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  useEffect(() => {
    if (!draft || data.os !== 'windows') {
      setAuthorization(null);
      return;
    }
    let disposed = false;
    setAuthorization(null);
    const timer = setTimeout(() => {
      void api
        .applicationAuthorization(draft)
        .then((status) => {
          if (!disposed) setAuthorization(status);
        })
        .catch((error) => {
          if (!disposed) setAuthorization({ state: 'unavailable', message: String(error) });
        });
    }, 350);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [draft, data.os]);
  const changeAuthorization = async (grant: boolean) => {
    if (!draft) return;
    setAuthorizing(true);
    try {
      await api.saveProfile(draft);
      const status = await api.changeApplicationAuthorization(draft.id, grant);
      setAuthorization(status);
      await refresh();
      notify(grant ? '已完成预授权，后续启动无需重复确认' : '免确认授权已撤销');
    } finally {
      setAuthorizing(false);
      setAuthorization(
        await api
          .applicationAuthorization(draft)
          .catch(() => ({ state: 'unavailable' as const, message: '请刷新授权状态' })),
      );
    }
  };
  const add = () =>
    setDraft({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      displayName: '',
      windows: {
        executable: '',
        processName: '',
        runAsAdministrator: false,
        usePreauthorizedTask: false,
      },
      macos: { appPath: '', bundleId: '', processName: '' },
      launchArguments: [],
      readyDetection: null,
    });
  const browse = async () => {
    const file = await open({ directory: data.os === 'macos', multiple: false, title: '选择应用' });
    if (file && draft) {
      const name = file.split(/[\\/]/).pop() || '';
      setDraft({
        ...draft,
        displayName: draft.displayName || name.replace(/\.(exe|app)$/i, ''),
        ...(data.os === 'windows'
          ? {
              windows: {
                ...draft.windows,
                executable: file,
                processName: draft.windows.processName || name,
              },
            }
          : { macos: { ...draft.macos, appPath: file } }),
      });
    }
  };
  const profiles = data.profiles.filter((p) =>
    p.displayName.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="page applications-page">
      <PageTitle
        eyebrow="APPLICATION LIBRARY"
        title="你的工具，各就各位"
        description="应用使用固定身份，启动路径按设备绑定。配置一次，在多个场景中复用。"
        actions={
          <div className="application-library-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setCaptureSource('workspace')}
            >
              <Monitor size={16} />
              捕获工作区应用
            </button>
            {data.os === 'windows' && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setCaptureSource('system')}
              >
                <AppWindow size={16} />
                捕获系统默认应用
              </button>
            )}
            <button className="button primary" onClick={add}>
              <Plus size={16} />
              添加应用
            </button>
          </div>
        }
      />
      {captureSource && (
        <ApplicationCapture source={captureSource} onClose={() => setCaptureSource(null)} />
      )}
      <div className="list-toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索应用…"
            aria-label="搜索应用"
          />
        </label>
        <span className="muted">当前设备 · {data.os === 'windows' ? 'Windows' : 'macOS'}</span>
      </div>
      {!profiles.length ? (
        <Empty
          title="连接你每天使用的工具"
          description="选择 Clash、IDEA、Chrome 等应用的本机路径，然后在工作流中添加「启动应用」。"
        >
          <button className="button primary" onClick={add}>
            <Plus size={16} />
            添加应用
          </button>
        </Empty>
      ) : (
        <div className="profile-list">
          {profiles.map((p) => (
            <article key={p.id} className="profile-card">
              <span className="scene-icon blue">
                <ApplicationIcon profile={p} />
              </span>
              <div className="profile-info">
                <h3>{p.displayName}</h3>
                <p title={data.os === 'windows' ? p.windows.executable : p.macos.appPath}>
                  {(data.os === 'windows'
                    ? p.windows.executable
                    : p.macos.appPath || p.macos.bundleId) || '尚未绑定本机路径'}
                </p>
                <small>
                  {data.os === 'windows' && p.windows.usePreauthorizedTask
                    ? '预授权启动 · '
                    : data.os === 'windows' && p.windows.runAsAdministrator
                      ? '管理员启动 · '
                      : ''}
                  {p.readyDetection
                    ? p.readyDetection.kind === 'port'
                      ? `Ready · ${p.readyDetection.host}:${p.readyDetection.port}`
                      : `Ready · ${p.readyDetection.processName}`
                    : '未配置 Ready 条件 · 仅确认启动请求'}
                </small>
              </div>
              <button
                className="icon-button"
                aria-label={`编辑 ${p.displayName}`}
                onClick={() => setDraft(structuredClone(p))}
              >
                <Pencil size={17} />
              </button>
              <button
                className="icon-button danger-hover"
                aria-label={`删除 ${p.displayName}`}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (
                      await confirm(
                        '删除应用配置？',
                        `将删除「${p.displayName}」的本地绑定。仍被场景引用的应用不能删除。`,
                      )
                    ) {
                      await api.deleteProfile(p.id);
                      await refresh();
                    }
                  })
                }
              >
                <Trash2 size={17} />
              </button>
            </article>
          ))}
        </div>
      )}
      {draft && (
        <Modal
          title={data.profiles.some((p) => p.id === draft.id) ? '编辑应用配置' : '添加应用'}
          onClose={() => {
            if (!authorizing) setDraft(null);
          }}
          wide
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await api.saveProfile(draft);
                await refresh();
                setDraft(null);
                notify('应用配置已保存');
              });
            }}
          >
            <fieldset disabled={authorizing} className="application-fields">
              <div className="modal-body form-stack">
                <div className="application-preview">
                  <ApplicationIcon profile={draft} size={40} />
                  <div>
                    <strong>{draft.displayName || '应用图标预览'}</strong>
                    <small>选择本机应用后自动获取图标</small>
                  </div>
                </div>
                <label>
                  应用名称
                  <input
                    required
                    autoFocus
                    value={draft.displayName}
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                    placeholder="例如 IntelliJ IDEA"
                  />
                </label>
                <div className="form-section-label">
                  {data.os === 'windows' ? 'Windows 绑定' : 'macOS 绑定'}
                </div>
                <label>
                  {data.os === 'windows' ? '可执行文件路径' : '应用路径 (.app 或可执行文件)'}
                  <div className="input-with-action">
                    <input
                      value={data.os === 'windows' ? draft.windows.executable : draft.macos.appPath}
                      onChange={(e) =>
                        setDraft(
                          data.os === 'windows'
                            ? {
                                ...draft,
                                windows: { ...draft.windows, executable: e.target.value },
                              }
                            : { ...draft, macos: { ...draft.macos, appPath: e.target.value } },
                        )
                      }
                      placeholder={
                        data.os === 'windows'
                          ? 'C:\\Program Files\\…\\app.exe'
                          : '/Applications/App.app'
                      }
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="浏览应用"
                      onClick={() => void perform(browse)}
                    >
                      <FolderOpen size={18} />
                    </button>
                  </div>
                </label>
                {data.os === 'macos' && (
                  <label>
                    Bundle ID（可替代路径）
                    <input
                      value={draft.macos.bundleId}
                      onChange={(e) =>
                        setDraft({ ...draft, macos: { ...draft.macos, bundleId: e.target.value } })
                      }
                      placeholder="com.jetbrains.intellij"
                    />
                  </label>
                )}
                {data.os === 'windows' && (
                  <div className="form-stack">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={draft.windows.usePreauthorizedTask ?? false}
                        disabled={busy}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            windows: { ...draft.windows, usePreauthorizedTask: e.target.checked },
                          })
                        }
                      />
                      使用预授权启动（首次确认，后续免确认）
                    </label>
                    <small className="muted">
                      仅当前 Windows
                      账户、本机程序和固定参数有效。首次需当前账户具备管理员资格并确认系统授权；应用更新、路径或参数变更后须重新授权。工作流额外参数请移入下方默认启动参数。
                    </small>
                    <div className="form-stack" aria-live="polite">
                      <small>
                        授权状态：
                        {authorizing
                          ? '等待 Windows 授权，请在系统窗口确认…'
                          : authorization?.message || '正在检查…'}
                      </small>
                      <div className="inline-actions">
                        {draft.windows.usePreauthorizedTask && (
                          <button
                            type="button"
                            className="button secondary"
                            disabled={
                              busy || !draft.displayName.trim() || !draft.windows.executable.trim()
                            }
                            onClick={() => void perform(() => changeAuthorization(true))}
                          >
                            保存并授权免确认启动
                          </button>
                        )}
                        <button
                          type="button"
                          className="button secondary"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () =>
                              setAuthorization(await api.applicationAuthorization(draft)),
                            )
                          }
                        >
                          刷新授权状态
                        </button>
                        {authorization &&
                          !['notAuthorized', 'unsupported'].includes(authorization.state) && (
                            <button
                              type="button"
                              className="button secondary"
                              disabled={busy}
                              onClick={() => void perform(() => changeAuthorization(false))}
                            >
                              撤销免确认授权
                            </button>
                          )}
                      </div>
                    </div>
                    {draft.windows.usePreauthorizedTask && (
                      <small className="muted">
                        请先完成授权再运行工作流。授权失效时会停止该步骤并显示原因，不会自动退回 UAC
                        弹窗。取消勾选只改变启动方式；永久撤销请点击“撤销免确认授权”。
                      </small>
                    )}
                    {!draft.windows.usePreauthorizedTask && (
                      <>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={draft.windows.runAsAdministrator ?? false}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                windows: { ...draft.windows, runAsAdministrator: e.target.checked },
                              })
                            }
                          />
                          以管理员身份启动
                        </label>
                        <small className="muted">
                          应用自身要求管理员权限时会自动弹出 Windows
                          授权框；勾选后每次新启动都请求管理员权限。请在系统窗口中确认“是”，取消授权后不会自动重试。授权等待计入步骤超时。
                          已运行的应用仍遵循启动节点的跳过设置；需要改变权限时请先退出应用再启动。
                        </small>
                      </>
                    )}
                  </div>
                )}
                <label>
                  精确进程名
                  <input
                    value={
                      data.os === 'windows' ? draft.windows.processName : draft.macos.processName
                    }
                    onChange={(e) =>
                      setDraft(
                        data.os === 'windows'
                          ? { ...draft, windows: { ...draft.windows, processName: e.target.value } }
                          : { ...draft, macos: { ...draft.macos, processName: e.target.value } },
                      )
                    }
                    placeholder={data.os === 'windows' ? 'idea64.exe' : 'idea'}
                  />
                  <small>用于检测应用是否已运行；留空则每次发送启动请求。</small>
                </label>
                <label>
                  默认启动参数
                  <textarea
                    rows={2}
                    value={draft.launchArguments.join('\n')}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        launchArguments: e.target.value ? e.target.value.split('\n') : [],
                      })
                    }
                    placeholder="每行一个参数，无需额外引号"
                  />
                </label>
                <div className="form-section-label">真正就绪，再进行下一步</div>
                <label>
                  Ready 条件
                  <select
                    value={draft.readyDetection?.kind || 'none'}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        readyDetection:
                          e.target.value === 'process'
                            ? {
                                kind: 'process',
                                processName:
                                  data.os === 'windows'
                                    ? draft.windows.processName
                                    : draft.macos.processName,
                              }
                            : e.target.value === 'port'
                              ? { kind: 'port', host: '127.0.0.1', port: 8080 }
                              : null,
                      })
                    }
                  >
                    <option value="none">不等待（仅确认启动请求）</option>
                    <option value="process">进程存在</option>
                    <option value="port">TCP 端口就绪</option>
                  </select>
                </label>
                {draft.readyDetection?.kind === 'process' && (
                  <label>
                    等待进程
                    <input
                      required
                      value={draft.readyDetection.processName}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          readyDetection: { kind: 'process', processName: e.target.value },
                        })
                      }
                    />
                  </label>
                )}
                {draft.readyDetection?.kind === 'port' && (
                  <div className="form-grid">
                    <label>
                      主机
                      <input
                        required
                        value={draft.readyDetection.host}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            readyDetection: {
                              kind: 'port',
                              host: e.target.value,
                              port:
                                draft.readyDetection?.kind === 'port'
                                  ? draft.readyDetection.port
                                  : 8080,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      端口
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        required
                        value={draft.readyDetection.port}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            readyDetection: {
                              kind: 'port',
                              host:
                                draft.readyDetection?.kind === 'port'
                                  ? draft.readyDetection.host
                                  : '127.0.0.1',
                              port: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                <p className="form-note">
                  就绪检测受启动节点的超时限制。应用身份不会因路径改变而变化。
                </p>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="button secondary"
                  disabled={authorizing}
                  onClick={() => setDraft(null)}
                >
                  取消
                </button>
                <button className="button primary" disabled={busy}>
                  保存应用
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
    </div>
  );
}
