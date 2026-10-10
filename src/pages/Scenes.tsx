import { useState } from 'react';
import { BookOpen, Copy, Pencil, PencilLine, Play, Plus, Search, Star, Trash2 } from 'lucide-react';
import { Empty, Modal, PageTitle, SceneIcon } from '../components/ui';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import type { Scene } from '../domain/types';
import SceneNameDialog from '../components/SceneNameDialog';
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
    busy,
    confirm,
    notify,
  } = useWorkspace();
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<Scene | null>(null);
  const [showTemplate, setShowTemplate] = useState(false);
  const scenes = data.scenes
    .filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return (
    <div className="page">
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
              生成一个含 42
              步的主场景、一个配套子场景，以及两个应用配置。载入后可编辑、运行，也可在场景卡片中分别删除。
            </p>
            <ul>
              <li>
                启动应用、打开文件 / 文件夹 / 网页：使用 Windows 记事本、资源管理器与默认浏览器。
              </li>
              <li>等待、命令、条件、汇合和子流程：观察就绪检测、分支选择与子运行。</li>
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
        <span className="muted">{scenes.length} 个场景</span>
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
          {scenes.map((scene) => (
            <article className="scene-card" key={scene.id}>
              <div className="scene-card-top">
                <SceneIcon icon={scene.icon} color={scene.color} />
                {scene.isDefault && (
                  <span className="default-tag">
                    <Star size={12} fill="currentColor" />
                    默认启动
                  </span>
                )}
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
                <div className="spacer" />
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
