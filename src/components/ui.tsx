import { useEffect, useRef, type ReactNode } from 'react';
import {
  Activity,
  MousePointer2,
  AppWindow,
  ArrowUpRight,
  Check,
  ClipboardCopy,
  Circle,
  Code2,
  File,
  Folder,
  Globe,
  LoaderCircle,
  Network,
  Play,
  Terminal,
  Timer,
  X,
} from 'lucide-react';
import type { NodeStatus, RunStatus } from '../domain/types';

export const statusLabels: Record<RunStatus | NodeStatus, string> = {
  pending: '待执行',
  queued: '排队中',
  waiting: '等待就绪',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已停止',
  paused: '已暂停',
  retrying: '重试中',
  interrupted: '意外中断',
};
export function Status({ status }: { status: RunStatus | NodeStatus }) {
  return (
    <span className={`status ${status}`}>
      <span />
      {statusLabels[status]}
    </span>
  );
}
export function NodeIcon({ type, size = 18 }: { type: string; size?: number }) {
  const Icon =
    type === 'clipboard.copyText'
      ? ClipboardCopy
      : type.startsWith('gui.')
        ? MousePointer2
        : type.includes('launch')
          ? AppWindow
          : type.endsWith('file')
            ? File
            : type.endsWith('folder')
              ? Folder
              : type.endsWith('url')
                ? Globe
                : type.endsWith('port')
                  ? Network
                  : type.endsWith('process')
                    ? Activity
                    : type.endsWith('command')
                      ? Terminal
                      : Timer;
  return <Icon size={size} strokeWidth={1.8} />;
}
export function SceneIcon({ icon = 'code', color = 'green' }: { icon?: string; color?: string }) {
  const Icon =
    icon === 'terminal' ? Terminal : icon === 'globe' ? Globe : icon === 'folder' ? Folder : Code2;
  return (
    <span className={`scene-icon ${color}`}>
      <Icon size={25} strokeWidth={1.7} />
    </span>
  );
}
export function StateIcon({ status }: { status: NodeStatus }) {
  if (status === 'succeeded') return <Check size={17} className="success-text" />;
  if (status === 'failed') return <X size={17} className="danger-text" />;
  if (status === 'running' || status === 'waiting')
    return <LoaderCircle size={17} className="spin accent-text" />;
  return <Circle size={15} className="muted" />;
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-orbit">
        <Play size={25} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  canClose = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  canClose?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        if (canClose) onClose();
      }}
      onClick={(e) => {
        if (canClose && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭" disabled={!canClose} onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="actions">{actions}</div>
    </div>
  );
}
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={15} />
    </button>
  );
}
