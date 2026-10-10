import { useEffect, useState } from 'react';
import { KeyRound, Plus, RefreshCw, Trash2, Pencil } from 'lucide-react';
import { PageTitle, Modal } from '../components/ui';
import { useWorkspace } from '../lib/workspace';
import { product } from '../lib/product';
import { automation } from '../lib/automation';
const details: Record<string, { name: string; purpose: string }> = {
  accessibility: {
    name: 'Accessibility · 辅助功能',
    purpose: '读取控件身份并执行点击、输入、窗口恢复。',
  },
  screenRecording: {
    name: 'Screen Recording · 屏幕录制',
    purpose: '窗口截图、OCR 和图片定位需要此权限。',
  },
  automation: {
    name: 'Automation · 自动化',
    purpose: '当前通过辅助功能操作应用；未使用 Apple Events 的操作不需要此权限。',
  },
  inputMonitoring: {
    name: 'Input Monitoring · 输入监控',
    purpose: '仅在主动开始拾取器或录制器后监听指定窗口的交互。',
  },
};
export default function Permissions() {
  const { data, perform, notify, confirm, busy } = useWorkspace();
  const [permissions, setPermissions] = useState<Record<string, string>>({});
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof product.vaultMetadata>>>([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<{
    id: string;
    label: string;
    value: string;
    update: boolean;
  } | null>(null);
  const refresh = async () => {
    const results = await Promise.allSettled([automation.permissions(), product.vaultMetadata()]);
    if (results[0].status === 'fulfilled') setPermissions(results[0].value);
    if (results[1].status === 'fulfilled') setEntries(results[1].value);
    const failed = results.find((r) => r.status === 'rejected');
    setError(failed?.status === 'rejected' ? String(failed.reason) : '');
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div className="page permissions-page">
      <PageTitle
        eyebrow="PERMISSIONS & SECRETS"
        title="权限与凭据"
        description="按需授权。场景保存凭据引用，执行时才从本机系统凭据库读取。"
        actions={
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void perform(refresh)}
          >
            <RefreshCw size={16} />
            重新检查
          </button>
        }
      />
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
      <section className="settings-section product-section">
        <h2>系统权限</h2>
        {data.os === 'windows' ? (
          <div className="permission-row">
            <div>
              <strong>Administrator: On Demand</strong>
              <p>
                默认使用普通用户权限。操作管理员应用时，需要你明确通过系统 UAC 授权后启动
                LaunchFlow；不会自动提升或绕过 UAC。
              </p>
            </div>
            <span className="local-badge">按需授权</span>
          </div>
        ) : (
          Object.entries(details).map(([key, d]) => (
            <div className="permission-row" key={key}>
              <div>
                <strong>{d.name}</strong>
                <p>{d.purpose}</p>
              </div>
              <span>{permissions[key] || '检查中'}</span>
              <button
                className="text-link"
                onClick={() =>
                  void perform(async () => {
                    await automation.settings(key);
                  })
                }
              >
                系统设置
              </button>
            </div>
          ))
        )}
        <p className="muted">
          录制需要显式开始，可随时暂停或停止。密码控件使用 Secret
          占位符，截图会遮蔽已识别的密码区域。
        </p>
      </section>
      <section className="settings-section product-section">
        <div className="section-heading">
          <div>
            <h2>
              <KeyRound size={18} /> Secret Vault
            </h2>
            <p>
              {data.os === 'windows' ? 'Windows Credential Manager' : 'macOS Keychain'} · 此设备 ·
              不随场景导出
            </p>
          </div>
          <button
            className="button secondary"
            onClick={() => setDraft({ id: '', label: '', value: '', update: false })}
          >
            <Plus size={16} />
            添加凭据
          </button>
        </div>
        {!entries.length ? (
          <p className="muted">
            尚无凭据。创建后在 Secret Reference 或 Input Secret 中填写 vault:ID。
          </p>
        ) : (
          entries.map((entry) => (
            <div className="permission-row" key={entry.id}>
              <div>
                <strong>{entry.label || entry.id}</strong>
                <p>
                  <code>vault:{entry.id}</code> · {new Date(entry.updatedAt).toLocaleString()}
                </p>
              </div>
              <button
                className="icon-button"
                aria-label={`更新 ${entry.id}`}
                onClick={() => setDraft({ ...entry, value: '', update: true })}
              >
                <Pencil size={16} />
              </button>
              <button
                className="icon-button"
                aria-label={`删除 ${entry.id}`}
                onClick={() =>
                  void perform(async () => {
                    if (
                      await confirm(
                        '删除凭据',
                        `删除 vault:${entry.id} 后，引用它的场景将需要重新绑定。`,
                      )
                    ) {
                      await product.vaultDelete(entry.id);
                      await refresh();
                      notify('凭据已删除');
                    }
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))
        )}
      </section>
      {draft && (
        <Modal title={draft.update ? '更新凭据' : '添加凭据'} onClose={() => setDraft(null)}>
          <form
            className="secret-form"
            onSubmit={(e) => {
              e.preventDefault();
              const input = draft;
              setDraft({ ...draft, value: '' });
              void perform(async () => {
                await product.vaultWrite(input.id, input.label, input.value, input.update);
                setDraft(null);
                await refresh();
                notify('凭据已保存在系统凭据库');
              });
            }}
          >
            <div className="modal-body form-stack">
              <p className="muted">凭据仅保存在此设备，工作流通过引用 ID 使用。</p>
              <div>
                <label>
                  凭据 ID
                  <input
                    required
                    pattern="[A-Za-z0-9_.\-]{1,64}"
                    maxLength={64}
                    autoComplete="off"
                    disabled={draft.update}
                    value={draft.id}
                    placeholder="例如：work-account"
                    aria-describedby="secret-id-hint"
                    onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  />
                </label>
                <small id="secret-id-hint">
                  {draft.update
                    ? `引用为 vault:${draft.id}，更新时保持不变。`
                    : '支持字母、数字、下划线、短横线和点，最多 64 个字符。'}
                </small>
              </div>
              <label>
                显示名称
                <input
                  maxLength={80}
                  value={draft.label}
                  placeholder="例如：工作账号（可选）"
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                />
              </label>
              <label>
                新凭据值
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  spellCheck={false}
                  value={draft.value}
                  placeholder={draft.update ? '输入新的凭据值以替换' : '输入需要保存的凭据值'}
                  aria-describedby="secret-value-hint"
                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                />
              </label>
              <p className="form-note" id="secret-value-hint">
                保存后无法在界面查看明文。可直接替换凭据值；不会改变引用 ID。
              </p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                取消
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                保存到系统凭据库
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
