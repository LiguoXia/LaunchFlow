import { useEffect, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { Modal } from './ui';
import ApplicationIcon from './ApplicationIcon';
import { api, type ApplicationCaptureResult } from '../lib/api';
import { useWorkspace } from '../lib/workspace';

export default function ApplicationCapture({
  source,
  onClose,
}: {
  source: 'workspace' | 'system';
  onClose: () => void;
}) {
  const { refresh, notify } = useWorkspace();
  const [capture, setCapture] = useState<ApplicationCaptureResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void api
      .captureApplications(source)
      .then((result) => {
        if (!active) return;
        setCapture(result);
        setSelected(
          (old) =>
            new Set(
              result.apps
                .filter((a) => !a.existingId && !a.unavailable && old.has(a.key))
                .map((a) => a.key),
            ),
        );
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [source, generation]);
  const rows =
    capture?.apps.filter((a) =>
      `${a.profile.displayName} ${a.categories.join(' ')} ${a.profile.windows.executable} ${a.profile.macos.appPath}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  const available = rows.filter((a) => !a.existingId && !a.unavailable);
  const chosen =
    capture?.apps.filter((a) => selected.has(a.key) && !a.existingId && !a.unavailable) ?? [];
  const all = available.length > 0 && available.every((a) => selected.has(a.key));
  const disabled = loading || saving;
  const save = async () => {
    if (!chosen.length || disabled) return;
    setSaving(true);
    setError('');
    try {
      const count = await api.addCapturedApplications(chosen.map((a) => a.profile));
      // Mark successful additions immediately, even if refreshing unrelated data later fails.
      setCapture((old) =>
        old
          ? {
              ...old,
              apps: old.apps.map((a) =>
                selected.has(a.key) && !a.unavailable
                  ? { ...a, existingId: a.existingId ?? a.profile.id }
                  : a,
              ),
            }
          : old,
      );
      setSelected(new Set());
      notify(count ? `已添加 ${count} 个应用` : '所选应用已在应用库中，无需重复添加');
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={source === 'workspace' ? '捕获工作区应用' : '捕获系统默认应用'}
      onClose={onClose}
      canClose={!saving}
      wide
    >
      <div className="modal-body application-capture">
        <p className="form-note">
          {source === 'workspace'
            ? '读取当前桌面窗口所属的应用，同一应用的多个窗口会合并。'
            : '包含 Windows 内置常用应用，以及当前默认浏览器、邮件、图片、音乐、视频、PDF 和文本应用。'}
          勾选后添加至应用库，已添加的项目会勾选并置灰。
        </p>
        <div className="capture-toolbar">
          <label className="search-input">
            <Search size={16} />
            <input
              aria-label="搜索捕获应用"
              placeholder="搜索应用或类别…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button
            className="button secondary small"
            disabled={disabled}
            onClick={() => setGeneration((n) => n + 1)}
          >
            <RefreshCw size={14} />
            重新捕获
          </button>
        </div>
        {error && (
          <p className="error-panel" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <div className="capture-loading" role="status">
            <LoaderCircle size={20} className="spin" />
            正在捕获应用…
          </div>
        ) : (
          capture && (
            <>
              <div className="capture-selection">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={all}
                    disabled={saving || !available.length}
                    onChange={(e) =>
                      setSelected((old) => {
                        const next = new Set(old);
                        for (const a of available) {
                          if (e.target.checked) next.add(a.key);
                          else next.delete(a.key);
                        }
                        return next;
                      })
                    }
                  />
                  全选当前可添加项
                </label>
                <small>
                  找到 {capture.apps.length} 个 · 已添加{' '}
                  {capture.apps.filter((a) => a.existingId).length} 个
                </small>
              </div>
              <div className="capture-list" aria-label="捕获的应用">
                {rows.length ? (
                  rows.map((a) => (
                    <label
                      key={a.key}
                      className={`capture-app ${a.existingId || a.unavailable ? 'unavailable' : ''}`}
                      data-application-key={a.key}
                    >
                      <input
                        type="checkbox"
                        aria-label={`添加 ${a.profile.displayName}`}
                        disabled={saving || !!a.existingId || !!a.unavailable}
                        checked={!!a.existingId || selected.has(a.key)}
                        onChange={(e) =>
                          setSelected((old) => {
                            const next = new Set(old);
                            if (e.target.checked) next.add(a.key);
                            else next.delete(a.key);
                            return next;
                          })
                        }
                      />
                      <ApplicationIcon profile={a.profile} size={30} />
                      <span className="capture-app-info">
                        <strong>{a.profile.displayName || '未知应用'}</strong>
                        <small>{a.categories.join(' · ')}</small>
                        <small
                          className="capture-app-path"
                          title={
                            a.profile.launchArguments[0]?.startsWith('shell:AppsFolder\\')
                              ? a.profile.launchArguments[0]
                              : a.profile.windows.executable || a.profile.macos.appPath
                          }
                        >
                          {a.profile.launchArguments[0]?.startsWith('shell:AppsFolder\\')
                            ? 'Windows 商店应用'
                            : a.profile.windows.executable || a.profile.macos.appPath}
                        </small>
                        {a.unavailable && <small className="danger-text">{a.unavailable}</small>}
                      </span>
                      {a.existingId && (
                        <span className="capture-added">
                          <Check size={13} />
                          已添加
                        </span>
                      )}
                    </label>
                  ))
                ) : (
                  <p className="capture-empty">
                    {query ? '没有匹配的应用' : '未捕获到可添加的应用，请打开应用后重新捕获。'}
                  </p>
                )}
              </div>
              {!!capture.warnings.length && (
                <details className="capture-warnings">
                  <summary>部分应用未能识别（{capture.warnings.length}）</summary>
                  <ul>
                    {capture.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )
        )}
      </div>
      <div className="modal-footer">
        <span className="muted">已选 {chosen.length} 个待添加应用</span>
        <button className="button secondary" disabled={saving} onClick={onClose}>
          完成
        </button>
        <button
          className="button primary"
          disabled={disabled || !chosen.length}
          onClick={() => void save()}
        >
          {saving ? '正在添加…' : `添加所选（${chosen.length}）`}
        </button>
      </div>
    </Modal>
  );
}
