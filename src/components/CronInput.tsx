import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function CronInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [preview, setPreview] = useState<{
    value: string;
    dates?: string[];
    error?: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void api.cronPreview(value).then(
        (dates) => {
          if (active) setPreview({ value, dates });
        },
        (error) => {
          if (active) setPreview({ value, error: String(error) });
        },
      );
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [value]);
  const current = preview?.value === value ? preview : null;
  return (
    <div className="cron-settings">
      <label>
        Cron 表达式
        <input
          spellCheck={false}
          className="cron-expression"
          value={value}
          placeholder="0 9 * * MON-FRI"
          aria-invalid={!!current?.error}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <p className="form-note">
        5 段：分 时 日 月 星期；6 段：秒 分 时 日 月 星期。支持 *、范围、列表和 / 步长；星期 0 / 7
        为周日，也可用 MON–SUN。日期与星期都有限制时，任一匹配即触发。
      </p>
      <div className="cron-examples">
        {[
          ['每 5 分钟', '*/5 * * * *'],
          ['工作日 09:00', '0 9 * * MON-FRI'],
          ['每 30 秒', '*/30 * * * * *'],
        ].map(([label, expression]) => (
          <button
            type="button"
            className="button secondary small"
            key={expression}
            onClick={() => onChange(expression)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="cron-preview" aria-live="polite">
        {current?.error ? (
          <p className="danger-text" role="alert">
            {current.error}
          </p>
        ) : current?.dates ? (
          <>
            <strong>接下来 3 次 · 本机时区</strong>
            <ul>
              {current.dates.map((date) => (
                <li key={date}>{new Date(date).toLocaleString()}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">正在检查表达式…</p>
        )}
      </div>
    </div>
  );
}
