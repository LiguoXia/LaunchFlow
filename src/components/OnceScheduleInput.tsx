import { useEffect, useId, useState } from 'react';
import { api } from '../lib/api';

export default function OnceScheduleInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const descriptionId = useId();
  const [validation, setValidation] = useState<{ value: string; date?: string; error?: string }>();
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void api.onceSchedulePreview(value).then(
        (date) => {
          if (active) setValidation({ value, date });
        },
        (error) => {
          if (active) setValidation({ value, error: String(error) });
        },
      );
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [value]);
  const current = validation?.value === value ? validation : undefined;
  return (
    <div className="once-schedule-settings">
      <label>
        指定时间
        <input
          value={value}
          placeholder="yyyy-MM-dd HH:mm:ss"
          spellCheck={false}
          aria-invalid={!!current?.error}
          aria-describedby={descriptionId}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div id={descriptionId} className="cron-preview" aria-live="polite">
        {current?.error ? (
          <p className="danger-text" role="alert">
            {current.error}
          </p>
        ) : current?.date ? (
          <p className="form-note">
            时间有效 · 本机时区（UTC{current.date.slice(-6)}） · 仅执行一次。
            {new Date(current.date).getTime() <= Date.now() &&
              ' 此时间已到；保存并启用后，尚未执行的预约将补执行一次。'}
          </p>
        ) : (
          <p className="muted">正在校验时间…</p>
        )}
      </div>
    </div>
  );
}
