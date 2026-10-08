import { useState } from 'react';
import { Copy, Pencil, Play, Plus, Search, Star, Trash2 } from 'lucide-react';
import { Empty, PageTitle, SceneIcon } from '../components/ui';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
export default function Scenes() {
  const { data, create, edit, run, perform, refresh, setDefaultScene, busy, confirm, notify } =
    useWorkspace();
  const [query, setQuery] = useState('');
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
    </div>
  );
}
