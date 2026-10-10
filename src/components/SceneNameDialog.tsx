import { useRef, useState } from 'react';
import { Modal } from './ui';

export default function SceneNameDialog({
  name: initialName,
  onSave,
  onClose,
}: {
  name: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const trimmed = name.trim();
  const tooLong = new TextEncoder().encode(trimmed).length > 200;
  return (
    <Modal title="重命名场景" onClose={onClose} canClose={!saving}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || tooLong || submitting.current) return;
          submitting.current = true;
          setSaving(true);
          setError('');
          void onSave(trimmed)
            .then(onClose)
            .catch((error) => setError(String(error)))
            .finally(() => {
              submitting.current = false;
              setSaving(false);
            });
        }}
      >
        <div className="modal-body form-stack">
          <label>
            场景名称
            <input
              autoFocus
              required
              maxLength={200}
              value={name}
              disabled={saving}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
            />
          </label>
          {tooLong && (
            <p className="danger-text" role="alert">
              场景名称过长，请缩短后重试。
            </p>
          )}
          {error && (
            <p className="danger-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={saving || !trimmed || tooLong}>
            {saving ? '正在保存…' : '确定'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
