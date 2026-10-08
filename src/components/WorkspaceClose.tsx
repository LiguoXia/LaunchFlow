import { useEffect, useRef, useState } from 'react';
import ApplicationIcon from './ApplicationIcon';
import { LoaderCircle, RefreshCw, Power } from 'lucide-react';
import { Modal } from './ui';
import { product, type CloseCapture } from '../lib/product';
import { useWorkspace } from '../lib/workspace';

const labels: Record<string, string> = {
  ready: '待选择',
  pending: '仍在运行',
  closed: '已退出',
  failed: '未能关闭',
  stale: '需要重新捕获',
};
export default function WorkspaceClose({ onClose }: { onClose: () => void }) {
  const { notify, data } = useWorkspace();
  const [capture, setCapture] = useState<CloseCapture | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forceIds, setForceIds] = useState<string[] | null>(null);
  const gate = useRef(false);
  const work = async (fn: () => Promise<void>) => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      gate.current = false;
      setBusy(false);
    }
  };
  const scan = () =>
    work(async () => {
      setCapture(await product.closeCapture());
      setForceIds(null);
    });
  useEffect(() => {
    void scan();
  }, []);
  const selected =
    capture?.apps.filter((a) => a.selected && !a.blocked && a.state !== 'closed') || [];
  const remaining = selected.filter((a) => a.canForce);
  const choose = (id: string, selected: boolean) =>
    work(async () => {
      if (!capture) return;
      setCapture({
        ...capture,
        apps: capture.apps.map((a) => (a.id === id ? { ...a, selected } : a)),
      });
      try {
        await product.closeSelect(capture.token, id, selected);
      } catch (error) {
        setCapture(capture);
        throw error;
      }
    });
  const all = (selected: boolean) =>
    work(async () => {
      if (!capture) return;
      // Each acknowledged write is shown immediately; failures never pretend a choice was saved.
      for (const app of capture.apps.filter((a) => !a.blocked && a.selected !== selected)) {
        await product.closeSelect(capture.token, app.id, selected);
        setCapture((old) =>
          old
            ? { ...old, apps: old.apps.map((a) => (a.id === app.id ? { ...a, selected } : a)) }
            : old,
        );
      }
    });
  const execute = (action: 'graceful' | 'status' | 'force', ids = selected.map((a) => a.id)) =>
    work(async () => {
      if (!capture) return;
      setCapture(await product.closeExecute(capture.token, ids, action, action === 'force'));
      setForceIds(null);
      if (action === 'graceful') notify('已请求正常关闭；如有保存提示，请在对应应用中处理。');
    });
  return (
    <Modal
      title="关闭工作区应用"
      wide
      canClose={!busy}
      onClose={() => {
        if (!gate.current) onClose();
      }}
    >
      <div className="workspace-close">
        <p className="muted">
          {data.os === 'windows'
            ? '自动捕获当前桌面的可见应用（含最小化窗口）'
            : '自动捕获当前桌面显示窗口的应用'}
          ，按应用合并。勾选与取消勾选会自动记忆。
        </p>
        <div className="info-strip">
          {data.os === 'windows'
            ? '先请求窗口正常关闭，等待 4 秒。应用可能保留托盘或后台进程。'
            : '正常退出会作用于整个应用，包含该应用其他桌面的窗口。'}{' '}
          保存提示由你处理；未退出的应用才可另行确认强制关闭。
          {data.os === 'windows' &&
            ' 管理员应用会请求 Windows 授权，请在系统窗口确认；取消授权不会强制关闭。'}
        </div>
        <div className="close-toolbar">
          <span>
            已选择 {selected.length} /{' '}
            {capture?.apps.filter((a) => !a.blocked && a.state !== 'closed').length || 0} 个应用
          </span>
          <button
            className="text-link"
            disabled={busy || !capture || !!forceIds}
            onClick={() => void all(true)}
          >
            全选
          </button>
          <button
            className="text-link"
            disabled={busy || !capture || !!forceIds}
            onClick={() => void all(false)}
          >
            全不选
          </button>
          <button className="button secondary" disabled={busy} onClick={() => void scan()}>
            <RefreshCw size={15} />
            重新捕获
          </button>
        </div>
        {error && (
          <p role="alert" className="danger-text">
            {error}
          </p>
        )}
        {!capture && busy && (
          <p role="status">
            <LoaderCircle className="spin" size={18} /> 正在捕获应用…
          </p>
        )}
        {capture?.apps.length === 0 && <p>当前桌面没有可捕获的应用。</p>}
        <div className="close-app-list">
          {capture?.apps.map((a) => (
            <label key={a.id} className={`close-app ${a.blocked ? 'blocked' : ''}`}>
              <input
                type="checkbox"
                aria-label={`关闭 ${a.name}`}
                checked={a.selected}
                disabled={busy || !!a.blocked || !!forceIds}
                onChange={(e) => void choose(a.id, e.target.checked)}
              />
              <div>
                <span className="close-application-name">
                  <ApplicationIcon path={a.executable} size={24} />
                  <strong>{a.name}</strong>
                </span>
                <small title={a.executable}>{a.executable || '路径不可用'}</small>
                <p title={a.windows.join('\n')}>
                  {a.windows.length} 个窗口 · {a.windows.join(' · ')}
                </p>
                {(a.blocked || a.message) && (
                  <p
                    title={a.blocked || a.message}
                    className={['failed', 'stale'].includes(a.state) ? 'danger-text' : ''}
                  >
                    {a.blocked || a.message}
                  </p>
                )}
              </div>
              <span className={`close-state ${a.state === 'closed' ? 'success-text' : ''}`}>
                {a.blocked ? '受保护' : labels[a.state] || a.state}
              </span>
            </label>
          ))}
        </div>
        {forceIds && (
          <div className="close-force" role="alert">
            <strong>确认强制关闭 {forceIds.length} 个应用？</strong>
            <p>
              {capture?.apps
                .filter((a) => forceIds.includes(a.id))
                .map((a) => a.name)
                .join('、')}
            </p>
            <p>未保存的内容可能丢失。只终止本次已尝试正常关闭且仍在运行的进程。</p>
            <div className="actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setForceIds(null)}
              >
                继续等待
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void execute('force', forceIds)}
              >
                确认强制关闭
              </button>
            </div>
          </div>
        )}
        <div className="close-footer">
          <span className="muted" role="status">
            {busy
              ? '正在处理；如出现 Windows 授权窗口，请确认或取消…'
              : error
                ? '操作未完成，请查看上方提示。'
                : '勾选状态已自动保存；快捷键可在设置中配置。'}
          </span>
          <div className="actions">
            {!!remaining.length && !forceIds && (
              <button
                className="button secondary danger-text"
                disabled={busy}
                onClick={() => setForceIds(remaining.map((a) => a.id))}
              >
                强制关闭剩余 {remaining.length} 个
              </button>
            )}
            <button
              className="button secondary"
              disabled={busy || !selected.some((a) => a.state !== 'ready')}
              onClick={() => void execute('status')}
            >
              检查退出状态
            </button>
            <button
              className="button primary"
              disabled={busy || !selected.length || !!forceIds}
              onClick={() => void execute('graceful')}
            >
              <Power size={16} />
              一键关闭所选应用
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
