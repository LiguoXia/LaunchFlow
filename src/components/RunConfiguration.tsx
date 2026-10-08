import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Modal } from './ui';
import type { Parameter, Scene } from '../domain/types';
export function ParameterInput({
  parameter: p,
  value,
  onChange,
}: {
  parameter: Parameter;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (p.kind === 'boolean')
    return (
      <select
        value={value === true ? 'true' : value === false ? 'false' : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}
        required={p.required}
      >
        <option value="">请选择</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  if (p.kind === 'select')
    return (
      <select
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        required={p.required}
      >
        <option value="">请选择</option>
        {p.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  return (
    <div className="input-with-action">
      <input
        type={p.kind === 'number' ? 'number' : 'text'}
        step="any"
        value={String(value ?? '')}
        required={p.required}
        min={p.kind === 'number' ? (p.validation.min ?? undefined) : undefined}
        max={p.kind === 'number' ? (p.validation.max ?? undefined) : undefined}
        placeholder={p.kind === 'secretReference' ? 'vault:ID 或 env:VARIABLE_NAME' : undefined}
        onChange={(e) =>
          onChange(
            p.kind === 'number'
              ? e.target.value === ''
                ? null
                : Number(e.target.value)
              : e.target.value,
          )
        }
      />
      {['file', 'directory'].includes(p.kind) && (
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            void open({ directory: p.kind === 'directory', multiple: false }).then((path) => {
              if (path) onChange(path);
            })
          }
        >
          浏览
        </button>
      )}
    </div>
  );
}
export default function RunConfiguration({
  scene,
  onClose,
  onRun,
}: {
  scene: Scene;
  onClose: () => void;
  onRun: (values: Record<string, unknown>) => Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...Object.fromEntries((scene.parameters ?? []).map((p) => [p.name, p.defaultValue ?? null])),
    ...scene.triggers?.find((t) => t.kind === 'manual' && t.enabled)?.parameters,
  }));
  const [running, setRunning] = useState(false);
  return (
    <Modal title={`运行配置 · ${scene.name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setRunning(true);
          void onRun(values).finally(() => setRunning(false));
        }}
      >
        <div className="modal-body form-stack">
          <p className="muted">参数将与本次工作流快照一起保存。</p>
          {(scene.parameters ?? []).map((p) => (
            <label key={p.name}>
              {p.name}
              {p.required ? ' *' : ''}
              <ParameterInput
                parameter={p}
                value={values[p.name]}
                onChange={(v) => setValues({ ...values, [p.name]: v })}
              />
              <small>
                {p.description}
                {p.kind === 'secretReference' ? ' · 仅填写环境变量引用，值不会写入历史。' : ''}
              </small>
            </label>
          ))}
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={running}>
            开始运行
          </button>
        </div>
      </form>
    </Modal>
  );
}
