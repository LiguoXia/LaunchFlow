import { useState } from 'react';
import { ArrowDown, ArrowUp, Camera, Monitor, Plus } from 'lucide-react';
import { Empty, PageTitle } from '../components/ui';
import ApplicationIcon from '../components/ApplicationIcon';
import { useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
import {
  product,
  type WorkspaceCapture,
  type RestoreConfig,
  type WorkspaceProfile,
} from '../lib/product';
export default function Workspaces() {
  const { data, perform, notify, refresh, edit, busy, closeWorkspace } = useWorkspace();
  const [capture, setCapture] = useState<WorkspaceCapture | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [name, setName] = useState('我的工作区');
  const [profileName, setProfileName] = useState('Office');
  const [layout, setLayout] = useState(true);
  const [mode, setMode] = useState<'relative' | 'exact'>('relative');
  const [destination, setDestination] = useState('');
  const [condition, setCondition] = useState<'count' | 'names' | 'any'>('count');
  const scan = () =>
    perform(async () => {
      const result = await product.capture();
      setCapture(result);
      setSelected(
        result.windows.flatMap((w, i) =>
          (w.application.windows.executable || w.application.macos.appPath) &&
          !/launchflow|codex/i.test(w.identity.application || '')
            ? [i]
            : [],
        ),
      );
    });
  const move = (index: number, delta: number) =>
    setSelected((old) => {
      const copy = [...old];
      const pos = copy.indexOf(index);
      if (pos + delta >= 0 && pos + delta < copy.length)
        [copy[pos], copy[pos + delta]] = [copy[pos + delta], copy[pos]];
      return copy;
    });
  const save = () =>
    perform(async () => {
      if (!capture || !selected.length) return;
      const windows = selected.map((i) => capture.windows[i]);
      if (!destination) {
        const scene = await product.createFromWorkspace(
          name,
          windows,
          layout,
          profileName,
          capture.displays.length,
        );
        if (layout && (mode === 'exact' || condition !== 'count')) {
          const node = scene.workflow.nodes.find((n) => n.type === 'workspace.restore')!;
          const cfg = node.config as unknown as RestoreConfig;
          cfg.mode = mode;
          cfg.profiles[0].condition = monitorCondition();
          const saved = await api.saveScene(scene);
          await refresh();
          edit(saved);
        } else {
          await refresh();
          edit(scene);
        }
        notify('已从工作区创建场景；可在编辑器调整窗口标题与启动顺序');
      } else {
        const scene = structuredClone(data.scenes.find((s) => s.id === destination)!);
        const node = scene.workflow.nodes.find((n) => n.type === 'workspace.restore');
        if (!node) throw new Error('此场景尚无工作区恢复节点，请先从工作区创建场景。');
        const cfg = node.config as unknown as RestoreConfig;
        const profile: WorkspaceProfile = {
          name: profileName,
          condition: monitorCondition(),
          windows: [],
        };
        for (const w of windows) {
          const existing = data.profiles.find((p) =>
            data.os === 'windows'
              ? p.windows.executable.toLowerCase() ===
                w.application.windows.executable.toLowerCase()
              : p.macos.appPath === w.application.macos.appPath,
          );
          const application = existing || w.application;
          if (!existing) await api.saveProfile(application);
          profile.windows.push({
            identity: w.identity,
            display: w.display,
            bounds: w.bounds,
            relative: w.relative,
            state: w.state,
            applicationId: application.id,
          });
        }
        cfg.mode = mode;
        cfg.profiles = [...cfg.profiles.filter((p) => p.name !== profileName), profile];
        const saved = await api.saveScene(scene);
        await refresh();
        edit(saved);
        notify('工作区配置已保存');
      }
    });
  const monitorCondition = () => ({
    count: condition === 'count' ? capture?.displays.length || 1 : null,
    displayNames: condition === 'names' ? capture?.displays.map((d) => d.name) || [] : [],
  });
  return (
    <div className="page">
      <PageTitle
        eyebrow="WORKSPACE"
        title="工作环境，一次就位"
        description="捕获可见窗口，按进程启动时间排列应用，为办公室、家中和笔记本保存不同布局。"
        actions={
          <>
            <button className="button secondary" onClick={closeWorkspace}>
              关闭工作区应用
            </button>
            <button className="button primary" disabled={busy} onClick={() => void scan()}>
              <Camera size={16} />
              捕获当前工作区
            </button>
          </>
        }
      />
      {!capture ? (
        <Empty
          title="把当前桌面保存成场景"
          description="捕获后选择窗口、调整启动顺序。导入和创建均不会立即启动应用。"
        />
      ) : (
        <>
          <div className="display-grid">
            {capture.displays.map((d) => (
              <article className="product-card" key={d.id}>
                <Monitor size={22} />
                <strong>
                  {d.name || '显示器'} {d.primary ? '· 主屏' : '· 副屏'}
                </strong>
                <span className="muted">
                  {d.bounds.width} × {d.bounds.height} · {Math.round(d.scale * 100)}% · (
                  {d.bounds.x}, {d.bounds.y})
                </span>
              </article>
            ))}
          </div>
          <section className="product-card workspace-options">
            <label>
              保存到
              <select value={destination} onChange={(e) => setDestination(e.target.value)}>
                <option value="">新建场景</option>
                {data.scenes
                  .filter((s) => s.workflow.nodes.some((n) => n.type === 'workspace.restore'))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
            {!destination && (
              <label>
                场景名称
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            <label>
              配置名称
              <input
                list="workspace-names"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
              />
              <datalist id="workspace-names">
                <option>Office</option>
                <option>Home</option>
                <option>Laptop</option>
              </datalist>
            </label>
            <label>
              匹配条件
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value as typeof condition)}
              >
                <option value="count">显示器数量</option>
                <option value="names">显示器名称组合</option>
                <option value="any">任何显示器（备用布局）</option>
              </select>
            </label>
            <label>
              恢复模式
              <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="relative">Relative · 按可用区域比例</option>
                <option value="exact">Exact · 原始位置和尺寸</option>
              </select>
            </label>
            {!destination && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={layout}
                  onChange={(e) => setLayout(e.target.checked)}
                />
                包含窗口布局
              </label>
            )}
          </section>
          <div className="section-heading">
            <h2>
              选择窗口{' '}
              <span className="muted">
                {selected.length} / {capture.windows.length}
              </span>
            </h2>
            <span className="muted">箭头调整启动顺序 · 相同应用仅启动一次</span>
          </div>
          <div className="workspace-window-list">
            {[
              ...selected,
              ...capture.windows.map((_, i) => i).filter((i) => !selected.includes(i)),
            ].map((i) => {
              const w = capture.windows[i];
              const included = selected.includes(i);
              return (
                <article className={`workspace-window ${included ? 'selected' : ''}`} key={i}>
                  <input
                    type="checkbox"
                    aria-label={`包含 ${w.identity.title}`}
                    checked={included}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked ? [...old, i] : old.filter((n) => n !== i),
                      )
                    }
                  />
                  <span className="workspace-order">
                    {included ? selected.indexOf(i) + 1 : '—'}
                  </span>
                  <ApplicationIcon profile={w.application} />
                  <div className="workspace-window-info">
                    <strong>{w.application.displayName}</strong>
                    <span>{w.identity.title}</span>
                    <small>
                      {w.display.primary ? '主屏' : '副屏'} · 左 {Math.round(w.relative.x * 100)}% /
                      顶 {Math.round(w.relative.y * 100)}% · 宽 {Math.round(w.relative.width * 100)}
                      % / 高 {Math.round(w.relative.height * 100)}% · {w.state}
                    </small>
                    {!(w.application.windows.executable || w.application.macos.appPath) && (
                      <small className="danger-text">
                        无法读取应用路径；请排除此窗口或在应用库完成绑定。
                      </small>
                    )}
                  </div>
                  {included && (
                    <>
                      <button
                        className="icon-button"
                        aria-label={`上移 ${w.application.displayName}`}
                        disabled={selected.indexOf(i) === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`下移 ${w.application.displayName}`}
                        disabled={selected.indexOf(i) === selected.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown size={16} />
                      </button>
                    </>
                  )}
                </article>
              );
            })}
          </div>
          <div className="product-actions">
            <span className="muted">
              显示器移除时自动回退，窗口保持可见。窗口标题可在编辑器中调整。
            </span>
            <button
              className="button primary"
              disabled={
                busy || !selected.length || !profileName.trim() || (!destination && !name.trim())
              }
              onClick={() => void save()}
            >
              <Plus size={16} />
              {destination ? '保存工作区配置' : '创建场景'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
