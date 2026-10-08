import { useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import { Modal } from './ui';

export function DiagnosticLogButton({ runId }: { runId?: string }) {
  const { perform, notify, busy } = useWorkspace();
  const [text, setText] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setManual(false);
      notify('诊断日志已复制，可粘贴到问题反馈中');
    } catch {
      setManual(true);
      area.current?.focus();
      area.current?.select();
    }
  };
  return (
    <>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            const value = await api.diagnosticLog(runId);
            setText(value);
            await copy(value);
          })
        }
      >
        <Copy size={15} />
        复制诊断日志
      </button>
      {text !== null && (
        <Modal title="诊断日志" wide onClose={() => setText(null)}>
          <div className="modal-body diagnostic-log">
            <p>
              包含最近的管理员与预授权启动步骤、错误码、调用位置和运行摘要。应用标识已摘要化，不含路径、启动参数、凭据或输入内容。
            </p>
            {manual && (
              <p role="status">自动复制不可用，请在下面文本框按 Ctrl+A、Ctrl+C 手动复制。</p>
            )}
            <textarea
              ref={area}
              aria-label="诊断日志内容"
              readOnly
              value={text}
              spellCheck={false}
              onFocus={(e) => manual && e.currentTarget.select()}
            />
          </div>
          <div className="modal-footer">
            <button className="button secondary" onClick={() => setText(null)}>
              关闭日志
            </button>
            <button className="button primary" onClick={() => void copy(text)}>
              再次复制
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
