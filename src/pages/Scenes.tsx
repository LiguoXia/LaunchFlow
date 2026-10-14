import { useState } from 'react';
import {
  BookOpen,
  Copy,
  GripVertical,
  Pencil,
  PencilLine,
  Play,
  Plus,
  Search,
  Star,
  Trash2,
  Zap,
} from 'lucide-react';
import { Empty, Modal, PageTitle, SceneIcon } from '../components/ui';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import type { Scene } from '../domain/types';
import SceneNameDialog from '../components/SceneNameDialog';
import { moveScene } from '../domain/scene-list';
export default function Scenes() {
  const {
    data,
    create,
    edit,
    run,
    perform,
    refresh,
    setDefaultScene,
    renameScene,
    reorderScenes,
    setSceneQuickLaunch,
    busy,
    confirm,
    notify,
  } = useWorkspace();
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<Scene | null>(null);
  const [showTemplate, setShowTemplate] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    placement: 'before' | 'after';
  } | null>(null);
  const scenes = data.scenes.filter((s) =>
    `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const quickLaunchIds = new Set(data.scenePreferences.quickLaunchIds);
  const move = (sourceId: string, targetId: string, placement: 'before' | 'after') => {
    const previous = data.scenes.map((scene) => scene.id);
    const next = moveScene(previous, sourceId, targetId, placement);
    if (next.every((id, index) => id === previous[index])) return;
    void perform(async () => {
      await reorderScenes(next);
      notify('场景顺序已保存');
    });
  };
  return (
    <div className="page scenes-page">
      <PageTitle
        eyebrow="SCENES"
        title="为每一种工作，准备一个场景"
        description="保存你的应用顺序与就绪条件，随时一键开始。"
        actions={
          <button className="button primary" onClick={create}>
            <Plus size={16} />
            新建场景
          </button>
        }
      />
      {data.os === 'windows' && (
        <section className="template-banner" aria-label="内置场景模板">
          <BookOpen size={25} />
          <div>
            <strong>从一个完整示例开始</strong>
            <p>Windows 全步骤体验 · 32 种步骤 · 记事本与专用练习窗口</p>
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => setShowTemplate(true)}
          >
            载入体验模板
          </button>
        </section>
      )}
      {showTemplate && (
        <Modal title="载入 Windows 体验模板" onClose={() => !busy && setShowTemplate(false)}>
          <div className="modal-body template-preview">
            <p>
              生成一个含 43
              步的主场景、一个配套子场景，以及两个应用配置。载入后可编辑、运行，也可在场景卡片中分别删除。
            </p>
            <ul>
              <li>
                启动应用、打开文件 / 文件夹 / 网页：使用 Windows 记事本、资源管理器与默认浏览器。
              </li>
              <li>等待、命令、条件、汇合和子流程：观察就绪检测、分支选择与子运行。</li>
              <li>复制文本：将配置内容写入系统剪贴板，体验可配合快捷键粘贴的输入方式。</li>
              <li>
                20 种 GUI
                步骤与工作区恢复：在随包提供的练习窗口体验中文输入、菜单、拖动、窗口布局与截图。
              </li>
            </ul>
            <p className="muted">
              将创建本地说明文件和专用演示凭据（非真实密码）。网页服务仅在练习窗口运行期间监听本机。载入不会自动执行或修改默认启动场景。
            </p>
            <p className="muted">
              运行时会操作鼠标、键盘和练习窗口，请先保存手头工作。完成后自行关闭体验窗口；应用配置及演示凭据可在应用库、权限与凭据中删除。
            </p>
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setShowTemplate(false)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const scenes = await api.loadWindowsDemo();
                  await refresh();
                  setShowTemplate(false);
                  edit(scenes[0]);
                  notify('体验模板已载入，可查看步骤说明后保存并运行');
                })
              }
            >
              {busy ? '正在载入…' : '载入并查看'}
            </button>
          </div>
        </Modal>
      )}
      <div className="list-toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            placeholder="搜索场景…"
            aria-label="搜索场景"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="muted">{scenes.length} 个场景 · 拖动卡片右上角可排序</span>
      </div>
      {!scenes.length ? (
        <Empty
          title={query ? '没有找到匹配场景' : '创建你的第一个场景'}
          description="从一个应用开始，再添加就绪检测和后续步骤。"
        >
          <button className="button primary" onClick={create}>
            <Plus size={16} />
            新建场景
          </button>
        </Empty>
      ) : (
        <div className="scene-grid full">
          {scenes.map((scene, index) => (
            <article
              className={`scene-card sortable-scene ${dragging === scene.id ? 'dragging' : ''} ${dropTarget?.id === scene.id ? `drop-${dropTarget.placement}` : ''}`}
              key={scene.id}
              data-scene-id={scene.id}
              onDragOver={(event) => {
                if (!dragging || busy) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const rect = event.currentTarget.getBoundingClientRect();
                setDropTarget({
                  id: scene.id,
                  placement: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after',
                });
              }}
              onDrop={(event) => {
                if (!dragging || busy) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                move(
                  dragging,
                  scene.id,
                  event.clientX < rect.left + rect.width / 2 ? 'before' : 'after',
                );
                setDragging(null);
                setDropTarget(null);
              }}
            >
              <div className="scene-card-top">
                <SceneIcon icon={scene.icon} color={scene.color} />
                <div className="scene-card-tools">
                  {scene.isDefault && (
                    <span className="default-tag">
                      <Star size={12} fill="currentColor" />
                      默认启动
                    </span>
                  )}
                  <button
                    className="icon-button scene-drag-handle"
                    aria-label={`拖动排序 ${scene.name}`}
                    title="拖动排序，也可按 Alt + 方向键移动"
                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
                    disabled={busy}
                    draggable={!busy}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/launchflow-scene', scene.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragging(scene.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                    onKeyDown={(event) => {
                      if (!event.altKey || busy) return;
                      const offset = ['ArrowLeft', 'ArrowUp'].includes(event.key)
                        ? -1
                        : ['ArrowRight', 'ArrowDown'].includes(event.key)
                          ? 1
                          : 0;
                      if (!offset) return;
                      event.preventDefault();
                      const target = scenes[index + offset];
                      if (target) move(scene.id, target.id, offset < 0 ? 'before' : 'after');
                    }}
                  >
                    <GripVertical size={17} />
                  </button>
                </div>
              </div>
              <h3>{scene.name}</h3>
              <p>{scene.description || '添加描述，让场景更容易辨认。'}</p>
              <div className="scene-card-footer">
                <span>{scene.workflow.nodes.length} 个任务</span>
                <span>v{scene.version}</span>
              </div>
              <div className="card-actions">
                <button
                  className="button primary small"
                  disabled={busy}
                  onClick={() => void run(scene)}
                >
                  <Play size={14} />
                  运行
                </button>
                <button className="button secondary small" onClick={() => edit(scene)}>
                  <Pencil size={14} />
                  编辑
                </button>
                <div className="scene-action-icons">
                  <button
                    className="icon-button"
                    title="重命名场景"
                    aria-label="重命名场景"
                    disabled={busy}
                    onClick={() => setRenaming(scene)}
                  >
                    <PencilLine size={16} />
                  </button>
                  <button
                    className="icon-button scene-quick-toggle"
                    title={quickLaunchIds.has(scene.id) ? '取消快捷启动' : '添加至快捷启动'}
                    aria-label={quickLaunchIds.has(scene.id) ? '取消快捷启动' : '添加至快捷启动'}
                    aria-pressed={quickLaunchIds.has(scene.id)}
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const enabled = !quickLaunchIds.has(scene.id);
                        await setSceneQuickLaunch(scene.id, enabled);
                        notify(enabled ? `已将「${scene.name}」添加至快捷启动` : '已取消快捷启动');
                      })
                    }
                  >
                    <Zap size={16} fill={quickLaunchIds.has(scene.id) ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    className="icon-button scene-default-toggle"
                    title={scene.isDefault ? '取消默认启动' : '设为默认启动场景'}
                    aria-label={scene.isDefault ? '取消默认启动' : '设为默认启动场景'}
                    aria-pressed={scene.isDefault}
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await setDefaultScene(scene.isDefault ? null : scene.id);
                        notify(
                          scene.isDefault
                            ? '已取消默认启动场景'
                            : `已将「${scene.name}」设为默认启动场景`,
                        );
                      })
                    }
                  >
                    <Star
                      key={scene.isDefault ? 'filled' : 'outline'}
                      size={16}
                      fill={scene.isDefault ? 'currentColor' : 'none'}
                    />
                  </button>
                  <button
                    className="icon-button"
                    title="复制场景"
                    aria-label="复制场景"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await api.duplicateScene(scene.id);
                        await refresh();
                        notify('场景已复制');
                      })
                    }
                  >
                    <Copy size={16} />
                  </button>
                  <button
                    className="icon-button danger-hover"
                    title="删除场景"
                    aria-label="删除场景"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        if (
                          await confirm(
                            '删除场景？',
                            `将删除「${scene.name}」及其草稿，历史运行记录会保留。`,
                          )
                        ) {
                          await api.deleteScene(scene.id);
                          await refresh();
                        }
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {renaming && (
        <SceneNameDialog
          name={renaming.name}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            await renameScene(renaming, name);
            notify('场景已改名');
          }}
        />
      )}
    </div>
  );
}
