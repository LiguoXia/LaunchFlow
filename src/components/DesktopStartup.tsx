import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { api, type StartupStatus } from '../lib/api';
import { useWorkspace } from '../lib/workspace';

export default function DesktopStartup() {
  const { data, perform, refresh, busy, notify } = useWorkspace();
  const [status, setStatus] = useState<StartupStatus | null>(null);
  const [error, setError] = useState('');
  const [loginMessage, setLoginMessage] = useState('');
  const request = useRef(0);
  const defaultScene = data.scenes.find((s) => s.isDefault);
  const load = useCallback(async () => {
    const revision = ++request.current;
    try {
      const next = await api.startupStatus();
      if (request.current === revision) {
        setStatus(next);
        setError('');
      }
    } catch (e) {
      if (request.current === revision) setError(String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const focus = () => void load();
    window.addEventListener('focus', focus);
    return () => {
      request.current++;
      window.removeEventListener('focus', focus);
    };
  }, [load, defaultScene?.id, defaultScene?.version]);
  const mode = status?.task.enabled ? 'beforeUnlock' : status?.legacyEnabled ? 'login' : 'disabled';
  const condition = status?.conditions;
  const blocked = condition?.disabledByPolicy === 1 || condition?.mdmAllow === 0;
  const arso = blocked
    ? '被系统策略禁用'
    : condition?.userOptOut === 1
      ? '当前用户已关闭'
      : condition?.userOptOut === 0
        ? '用户选项已开启，仍需满足 Windows 条件'
        : '需在 Windows 登录选项中确认';
  const managed = condition?.domainJoined || condition?.entraJoined;
  const observation = status?.observation?.started;
  const diagnostics = JSON.stringify(
    { version: data.version, startup: status, error, loginMessage },
    null,
    2,
  );
  const autologonUrl = 'https://learn.microsoft.com/en-us/sysinternals/downloads/autologon';
  const configureLogin = () =>
    void perform(async () => {
      setLoginMessage('请完成 Windows 管理员授权，在 LaunchFlow 配置窗口中填写账户密码。');
      try {
        const result = await api.configureAutologon();
        if (result.status === 'enabled') {
          setLoginMessage('Windows 自动登录已配置，正在登记 LaunchFlow 普通登录启动…');
          try {
            await api.setStartupMode('login');
          } catch {
            throw new Error(
              'Windows 自动登录已保存，但 LaunchFlow 启动登记失败。请点击“切换为普通登录启动”重试。',
            );
          }
          setLoginMessage(
            '已配置 Windows 自动登录和 LaunchFlow 普通登录启动。请确认上方默认场景检查通过，再自行重启验收。',
          );
          notify('自动登录配置已保存，下次开机生效');
        } else if (result.status === 'disabled') {
          setLoginMessage(
            '已关闭 Windows 自动登录，并清除 LaunchFlow 保存的自动登录密码。LaunchFlow 登录后启动设置保持不变。',
          );
          notify('已关闭 Windows 自动登录');
        } else {
          setLoginMessage('已取消，Windows 自动登录配置未更改。');
        }
      } catch (e) {
        setLoginMessage(String(e));
        throw e;
      } finally {
        await load();
        await refresh();
      }
    });
  const setMode = (next: 'login' | 'beforeUnlock' | 'disabled') =>
    void perform(async () => {
      try {
        await api.setStartupMode(next);
        notify(
          next === 'beforeUnlock'
            ? 'LaunchFlow 已配置为尽早启动；请完成下方 Windows 设置并重启验收'
            : next === 'login'
              ? '已切换为普通登录启动'
              : '已关闭 LaunchFlow 自动启动',
        );
      } finally {
        await load();
        await refresh();
      }
    });
  return (
    <div className="desktop-startup">
      <div className="setting-row">
        <div>
          <strong>LaunchFlow 自动启动方式</strong>
          <p>解锁前准备需要 Windows 先自动登录并保持屏幕锁定。</p>
        </div>
        <select
          aria-label="LaunchFlow 自动启动方式"
          value={mode}
          disabled={busy || !status || !!error}
          onChange={(e) => setMode(e.target.value as 'login' | 'beforeUnlock' | 'disabled')}
        >
          <option value="disabled">不自动启动</option>
          <option value="login">普通登录启动</option>
          <option value="beforeUnlock">解锁前准备桌面应用</option>
        </select>
      </div>
      {(error || status?.task.error) && (
        <p className="danger-text" role="alert">
          {error || status?.task.error}
        </p>
      )}
      {status?.login?.registered && !status.login.matches && (
        <p className="danger-text">
          普通登录启动的路径或参数需要更新。
          <button className="text-link" disabled={busy} onClick={() => setMode('login')}>
            修复普通登录启动
          </button>
        </p>
      )}
      <div className="startup-guide">
        <strong>默认场景自动执行检查</strong>
        <p className={status?.readiness.ready ? 'success-text' : 'danger-text'} role="status">
          {status?.readiness.message || '检测中…'}
        </p>
        {status?.readiness.canAuthorize && (
          <>
            <p>
              允许后，此默认场景里的点击、文本输入、命令和 Secret 步骤可自动执行；Windows
              系统授权仍需按要求确认。此操作只保存策略，不立即运行场景。
            </p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api.authorizeDefaultStartup(
                    status.readiness.sceneId!,
                    status.readiness.version!,
                  );
                  await refresh();
                  await load();
                  notify('已允许默认场景自动执行，请查看启动检查结果');
                })
              }
            >
              允许默认场景自动执行
            </button>
          </>
        )}
        {status?.observation?.result && (
          <p className={status.observation.result.status === 'blocked' ? 'danger-text' : 'muted'}>
            上次启动结果：{status.observation.result.message}
          </p>
        )}
      </div>
      <div className="startup-guide">
        <strong>开机直接进入桌面</strong>
        <p>
          Windows 自动登录 → LaunchFlow 普通登录启动 → 执行默认场景。自动登录由 Windows 在
          LaunchFlow 启动前完成，不需要添加解锁步骤或在工作流填写密码。
        </p>
        <ol>
          <li>
            点击“在 LaunchFlow 中配置自动登录”，完成一次 Windows 管理员授权，在内置窗口中填写
            当前账户的密码。Microsoft 账户请选择对应类型并填写邮箱；不能用 Windows Hello PIN
            代替密码。
          </li>
          <li>保存成功后自动设置“普通登录启动”，请确认上方默认场景自动执行检查通过。</li>
          <li>
            下次开机或重启后由 Windows 登录。普通锁屏不会被 LaunchFlow 自动解锁，原有 PIN
            登录仍保留。再次打开内置配置窗口可更新密码或关闭自动登录。
          </li>
        </ol>
        <p className="muted">
          配置后设备会直接进入该账户桌面，能接触设备的人也能使用此账户。密码由 Windows LSA
          保存，系统管理员可能读取。密码仅在本机管理员配置窗口处理，不进入场景、诊断日志或导出文件。
        </p>
        <p>
          系统自动登录标记：
          {condition?.autoLogonConfigured === true
            ? `已开启${condition.autoLogonManaged ? ' · 由 LaunchFlow 登记' : ' · 外部配置'}，仍需重启验收`
            : condition?.autoLogonConfigured === false
              ? '未开启'
              : '无法检测'}
        </p>
        <div className="inline-actions">
          <button className="button primary" disabled={busy || !status} onClick={configureLogin}>
            在 LaunchFlow 中配置自动登录
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await api.openAutologonSettings();
                notify('已请求默认浏览器打开微软说明。如未显示，可复制说明地址。');
              })
            }
          >
            <ExternalLink size={15} /> 打开 Microsoft Autologon 说明
          </button>
          <button
            className="button secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(autologonUrl)
                .then(() => notify('微软说明地址已复制'))
                .catch(() => setLoginMessage(`请复制地址：${autologonUrl}`))
            }
          >
            <Copy size={15} /> 复制说明地址
          </button>
          {mode !== 'login' && (
            <button
              className="button secondary"
              disabled={busy || !status}
              onClick={() => setMode('login')}
            >
              切换为普通登录启动
            </button>
          )}
        </div>
        {loginMessage && <p role="status">{loginMessage}</p>}
      </div>
      <div className="startup-guide">
        <strong>开机后先准备，输入密码后直接使用</strong>
        <p>
          开启 Windows 的“自动登录并锁定”功能后，LaunchFlow
          会在用户会话建立时启动默认场景，主窗口保持隐藏。你仍需输入密码或使用 Windows Hello
          解锁屏幕。
        </p>
        <ol>
          <li>上方选择“解锁前准备桌面应用”，并在下方选好默认启动场景。</li>
          <li>
            打开 Windows 登录选项，查找并开启“使用我的登录信息自动完成设置”（具体名称因 Windows
            版本而异）。返回此处刷新检测。
          </li>
          <li>
            保持账户处于登录状态，正常重启或关机；不要先注销账户。下次开机等待应用准备后再解锁。
          </li>
        </ol>
        <div className="startup-checks" aria-live="polite">
          <p>
            <strong>LaunchFlow：</strong>
            {!status
              ? '检测中…'
              : status.task.enabled && status.task.matches
                ? '已登记会话建立时启动 · 等待重启验收'
                : status.task.registered
                  ? '启动任务需要重新配置'
                  : '尚未配置解锁前准备'}
          </p>
          <p>
            <strong>Windows 自动登录并锁定：</strong>
            {status ? arso : '检测中…'}
          </p>
          <p>
            <strong>默认场景：</strong>
            {data.scenes.find((s) => s.isDefault)?.name || '尚未选择'} · 启动延迟{' '}
            {data.settings.startupDelaySeconds} 秒
          </p>
        </div>
        <p className="muted">
          {managed
            ? '检测到组织加入设备：此机制通常只适用于 Windows 更新重启，请遵循组织策略。'
            : '是否生效还取决于 Windows 安全条件、账户状态和关机方式，不能保证每次冷启动都提前打开应用。'}{' '}
          普通应用可以提前启动；点击、输入、窗口恢复及需要 UAC
          确认的步骤等待解锁后继续，流程顺序保持不变。
        </p>
        <p className="muted">
          此“自动登录并锁定”模式无需填写密码，登录信息由 Windows
          管理。请在你信任并妥善保管的设备上启用。
        </p>
        <div className="inline-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void perform(api.openSigninSettings)}
          >
            <ExternalLink size={15} />
            打开 Windows 登录选项
          </button>
          <button className="button secondary" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={15} />
            刷新启动检测
          </button>
          {status?.task.registered && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setMode('beforeUnlock')}
            >
              重新登记当前版本
            </button>
          )}
        </div>
        {observation && (
          <p className="startup-observation">
            上次自动启动：{new Date(observation.at).toLocaleString()} ·{' '}
            {observation.desktopReady
              ? '当时桌面可交互，不能证明解锁前启动'
              : '当时桌面尚未可交互（可能处于锁屏）'}
            。默认场景的执行结果可在运行历史查看。
          </p>
        )}
        <details className="startup-diagnostics">
          <summary>启动诊断</summary>
          <textarea
            aria-label="启动诊断内容"
            readOnly
            rows={6}
            value={diagnostics}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            className="button secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(diagnostics)
                .then(() => notify('启动诊断已复制'))
                .catch(() => notify('请选中诊断文本，按 Ctrl+A、Ctrl+C 复制'))
            }
          >
            <Copy size={15} />
            复制启动诊断
          </button>
        </details>
      </div>
    </div>
  );
}
