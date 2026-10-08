import { useEffect, useState } from 'react';
import { product } from '../lib/product';
import { useWorkspace } from '../lib/workspace';
export default function WorkspaceCloseShortcut() {
  const { perform, notify, busy } = useWorkspace();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void product
      .closeShortcut()
      .then((v) => {
        setValue(v.shortcut);
        setError(v.error || '');
        setLoaded(true);
      })
      .catch((e) => setError(String(e)));
  }, []);
  return (
    <section className="settings-section product-section">
      <h2>关闭工作区快捷键</h2>
      <p className="muted">
        在任意应用中唤起关闭确认面板，自动捕获当前工作区并恢复上次勾选。留空可禁用。
      </p>
      <div className="close-shortcut">
        <input
          aria-label="关闭工作区快捷键"
          placeholder="例如 Ctrl+Alt+Q"
          value={value}
          disabled={!loaded || busy}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          className="button secondary"
          disabled={!loaded || busy}
          onClick={() =>
            void perform(async () => {
              await product.saveCloseShortcut(value);
              const v = await product.closeShortcut();
              setValue(v.shortcut);
              setError(v.error || '');
              notify(value.trim() ? '关闭工作区快捷键已保存' : '关闭工作区快捷键已禁用');
            })
          }
        >
          保存快捷键
        </button>
      </div>
      <p className="muted">
        Windows 使用 Ctrl / Alt / Shift；macOS 可用 Command。快捷键不会跳过勾选确认或自动强制关闭。
      </p>
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
    </section>
  );
}
