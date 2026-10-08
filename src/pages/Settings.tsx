import { useEffect, useState } from 'react';
import { save as saveFile } from '@tauri-apps/plugin-dialog';
import { product, type UpdateStatus } from '../lib/product';
import { Bell, Check, History, Info, Laptop, Moon, Power, ShieldCheck, Sun } from 'lucide-react';
import { PageTitle } from '../components/ui';
import { DiagnosticLogButton } from '../components/DiagnosticLog';
import WorkspaceCloseShortcut from '../components/WorkspaceCloseShortcut';
import DesktopStartup from '../components/DesktopStartup';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
export default function Settings() {
  const { data, refresh, perform, busy, notify, setPage, confirm, setDefaultScene } =
    useWorkspace();
  const [settings, setSettings] = useState(data.settings);
  const [retentionPreset, setRetentionPreset] = useState(
    [0, 7, 30, 90].includes(data.settings.retentionDays)
      ? String(data.settings.retentionDays)
      : 'custom',
  );
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void product
      .updateStatus()
      .then(setUpdate)
      .catch(() =>
        setUpdate({ enabled: false, reason: '更新服务暂不可用', version: null, notes: null }),
      );
  }, []);
  useEffect(() => setSettings(data.settings), [data.settings]);
  const save = () =>
    void perform(async () => {
      await api.saveSettings(settings);
      await refresh();
      notify('设置已保存');
    });
  return (
    <div className="page settings-page">
      <PageTitle
        eyebrow="SETTINGS"
        title="按照你的方式运行"
        description="安静、可靠，在需要时准备好。"
        actions={
          <button className="button primary" disabled={busy} onClick={save}>
            <Check size={16} />
            保存设置
          </button>
        }
      />
      <WorkspaceCloseShortcut />
      <section className="settings-section">
        <div className="settings-title">
          <Power size={19} />
          <div>
            <h2>启动与后台</h2>
            <p>
              {data.os === 'windows' ? '配置解锁前准备或普通登录启动' : '登录后静默准备工作环境'}
            </p>
          </div>
        </div>
        <div className="settings-body">
          {data.os === 'windows' ? (
            <DesktopStartup />
          ) : (
            <div className="setting-row">
              <div>
                <strong>登录时启动 LaunchFlow</strong>
                <p>启动后保持在托盘 / 菜单栏，不弹出主窗口。</p>
              </div>
              <button
                role="switch"
                aria-label="登录时启动 LaunchFlow"
                aria-checked={data.autostart}
                className={`toggle ${data.autostart ? 'on' : ''}`}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await api.setAutostart(!data.autostart);
                    await refresh();
                    notify(data.autostart ? '已关闭登录启动' : '已启用登录启动');
                  })
                }
              >
                <span />
              </button>
            </div>
          )}
          <div className="setting-row">
            <div>
              <strong>默认启动场景</strong>
              <p>每次登录最多自动运行一个场景。</p>
            </div>
            <select
              aria-label="默认启动场景"
              value={data.scenes.find((s) => s.isDefault)?.id || ''}
              disabled={busy}
              onChange={(e) =>
                void perform(async () => {
                  await setDefaultScene(e.target.value || null);
                  notify('默认启动场景已更新');
                })
              }
            >
              <option value="">不自动运行场景</option>
              {data.scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div>
              <strong>启动延迟</strong>
              <p>在系统登录后，为其他程序留出准备时间。</p>
            </div>
            <label className="inline-number">
              <input
                aria-label="启动延迟秒数"
                type="number"
                min={0}
                max={3600}
                value={settings.startupDelaySeconds}
                onChange={(e) =>
                  setSettings({ ...settings, startupDelaySeconds: Number(e.target.value) })
                }
              />
              秒
            </label>
          </div>
          <div className="info-strip">
            <Info size={16} />
            关闭窗口会继续在后台运行。要退出，请使用托盘菜单中的「退出 LaunchFlow」。
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-title">
          <Sun size={19} />
          <div>
            <h2>外观</h2>
            <p>舒适、清晰的工作空间</p>
          </div>
        </div>
        <div className="settings-body">
          <div className="theme-options">
            {(
              [
                { id: 'system', label: '跟随系统', Icon: Laptop },
                { id: 'light', label: '浅色', Icon: Sun },
                { id: 'dark', label: '深色', Icon: Moon },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                className={settings.theme === id ? 'theme-option selected' : 'theme-option'}
                onClick={() => {
                  setSettings({ ...settings, theme: id });
                  document.documentElement.dataset.theme = id;
                }}
              >
                <Icon size={22} />
                <span>{label}</span>
                {settings.theme === id && <Check size={15} />}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-title">
          <Bell size={19} />
          <div>
            <h2>通知与历史</h2>
            <p>在需要时了解运行结果</p>
          </div>
        </div>
        <div className="settings-body">
          <div className="setting-row">
            <div>
              <strong>系统通知</strong>
              <p>场景开始、完成或失败时显示通知。</p>
            </div>
            <button
              role="switch"
              aria-label="系统通知"
              aria-checked={settings.notifications}
              className={`toggle ${settings.notifications ? 'on' : ''}`}
              onClick={() => setSettings({ ...settings, notifications: !settings.notifications })}
            >
              <span />
            </button>
          </div>
          <div className="setting-row">
            <div>
              <strong>历史保留天数</strong>
              <p>默认 30 天，每 15 分钟检查过期记录；活动运行不受清理影响。</p>
            </div>
            <label className="inline-number">
              <History size={15} />
              <select
                aria-label="历史保留策略"
                value={retentionPreset}
                onChange={(e) => {
                  setRetentionPreset(e.target.value);
                  if (e.target.value !== 'custom')
                    setSettings({ ...settings, retentionDays: Number(e.target.value) });
                  else if (settings.retentionDays === 0)
                    setSettings({ ...settings, retentionDays: 30 });
                }}
              >
                <option value="7">7 天</option>
                <option value="30">30 天</option>
                <option value="90">90 天</option>
                <option value="0">Forever · 永久</option>
                <option value="custom">Custom · 自定义</option>
              </select>
              {retentionPreset === 'custom' && (
                <input
                  aria-label="历史保留天数"
                  type="number"
                  min={1}
                  max={3650}
                  value={settings.retentionDays}
                  onChange={(e) =>
                    setSettings({ ...settings, retentionDays: Number(e.target.value) })
                  }
                />
              )}
              {retentionPreset === 'custom' ? '天' : ''}
            </label>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-title">
          <ShieldCheck size={19} />
          <div>
            <h2>本地与权限</h2>
            <p>默认普通用户权限</p>
          </div>
        </div>
        <div className="settings-body">
          <div className="setting-row">
            <div>
              <strong>数据只保存在本机</strong>
              <p>无需账号，不上传场景、应用列表或运行日志。</p>
            </div>
            <span className="local-badge">
              <span />
              Local only
            </span>
          </div>
          <div className="setting-row">
            <div>
              <strong>命令与敏感信息</strong>
              <p>
                命令输出默认不采集。开机执行命令须在场景中单独开启。
                <br />
                Secret Reference 支持 vault:ID（系统凭据库）和 env:变量名，执行时读取。
              </p>
            </div>
          </div>
        </div>
      </section>
      <button className="button secondary" onClick={() => setPage('permissions')}>
        打开权限与凭据中心
      </button>
      <section className="settings-section product-section">
        <h2>诊断与更新</h2>
        <div className="setting-row">
          <div>
            <strong>启动诊断日志</strong>
            <p>
              自动记录管理员与预授权启动的步骤和错误，重启后保留；本机最多保留约 2 MiB，复制最近 120
              条记录。
            </p>
          </div>
          <DiagnosticLogButton />
        </div>
        <div className="setting-row">
          <div>
            <strong>导出诊断包</strong>
            <p>
              包含版本、系统、权限、运行状态和错误分类。凭据、输入、命令参数、路径、截图及原始输出均不包含在内。
            </p>
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const path = await saveFile({
                  defaultPath: 'LaunchFlow-diagnostics.zip',
                  filters: [{ name: '诊断包', extensions: ['zip'] }],
                });
                if (path) {
                  await product.diagnostics(path);
                  notify('诊断包已导出');
                }
              })
            }
          >
            导出诊断包
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>应用更新</strong>
            <p>{update?.reason || '检查更新配置…'}</p>
            {update?.version && <p>可用版本：{update.version}</p>}
          </div>
          <button
            className="button secondary"
            disabled={busy || !update?.enabled}
            onClick={() =>
              void perform(async () => {
                setUpdate(await product.updateCheck());
              })
            }
          >
            检查更新
          </button>
        </div>
        {update?.version && (
          <>
            <pre className="update-notes">{update.notes || '此版本未提供更新说明。'}</pre>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (
                    await confirm(
                      `安装 LaunchFlow ${update.version}`,
                      '将下载并验证签名，安装后重新启动。请先结束运行中的工作流和录制。',
                    )
                  )
                    await product.updateInstall(update.version!);
                })
              }
            >
              下载并安装此版本
            </button>
          </>
        )}
        <p className="muted">
          开发版关闭更新。正式版仅使用发行时内置的 HTTPS 地址与签名公钥；安装前始终需要你的确认。
        </p>
      </section>
      <div className="about-line">
        <span className="mini-logo">L</span>
        <div>
          <strong>LaunchFlow</strong>
          <span>
            v{data.version} · Phase 4 · {data.os === 'windows' ? 'Windows' : 'macOS'}
          </span>
        </div>
        <span>你的工作环境，准备就绪。</span>
      </div>
    </div>
  );
}
