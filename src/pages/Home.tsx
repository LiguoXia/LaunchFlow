import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Code2,
  Layers3,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Workflow,
  Zap,
} from 'lucide-react';
import { PageTitle, SceneIcon, Status, TextLink } from '../components/ui';
import { dateLabel, formatDuration } from '../domain/editor';
import { useWorkspace } from '../lib/workspace';
export default function Home() {
  const { data, setPage, edit, run, create, busy, setSelectedRun } = useWorkspace();
  const active = data.scenes.find((s) => s.isDefault);
  const quickLaunch = data.scenes.filter((scene) =>
    data.scenePreferences.quickLaunchIds.includes(scene.id),
  );
  const lastRun = active && data.runs.find((r) => r.sceneId === active.id);
  const successful = data.runs.filter((r) => r.status === 'succeeded').length;
  const hour = new Date().getHours();
  return (
    <div className="page home-page">
      <PageTitle
        eyebrow="YOUR WORKSPACE, IN FLOW"
        title={`${hour < 12 ? '上午' : hour < 18 ? '下午' : '晚上'}好，准备好开始了吗？`}
        description="把重复的准备工作交给 LaunchFlow，专注接下来的创造。"
        actions={
          <button className="button secondary" onClick={create}>
            <Plus size={16} />
            新建场景
          </button>
        }
      />
      <section className="hero">
        <div className="hero-content">
          <div className="hero-label">
            <span className="live-dot" />
            {active ? '默认启动场景' : '从一个场景，开始更从容的工作日'}
          </div>
          <h2>{active?.name || '让工作，从就绪开始。'}</h2>
          <p>{active?.description || '应用、工具、项目。按你设定的顺序，\n一步一步，准备妥当。'}</p>
          <div className="hero-actions">
            <button
              className="button primary"
              disabled={busy}
              onClick={() => (active ? void run(active) : create())}
            >
              {active ? <Play size={16} fill="currentColor" /> : <Plus size={17} />}
              {active ? '运行场景' : '创建第一个场景'}
            </button>
            {active && (
              <button className="button hero-secondary" onClick={() => edit(active)}>
                编辑工作流
                <ArrowUpRight size={16} />
              </button>
            )}
          </div>
          <div className="hero-meta">
            <span>
              <Layers3 size={14} />
              {active ? `${active.workflow.nodes.length} 个任务` : '自由编排'}
            </span>
            <span>
              <Clock3 size={14} />
              {lastRun ? `上次 ${dateLabel(lastRun.startedAt)}` : '按需运行 · 静默启动'}
            </span>
          </div>
        </div>
        <div className="hero-diagram" aria-hidden="true">
          <div className="diagram-top">
            <span className="diagram-icon">
              <Workflow size={22} />
            </span>
            <span>
              你的工作环境<small>一切，井然有序</small>
            </span>
            <CheckCircle2 size={17} />
          </div>
          <div className="diagram-connector" />
          <div className="diagram-row">
            <div>
              <Code2 size={24} />
              <span>应用</span>
            </div>
            <span className="diagram-dash" />
            <div>
              <Clock3 size={24} />
              <span>就绪检测</span>
            </div>
            <span className="diagram-dash" />
            <div>
              <Sparkles size={24} />
              <span>开始工作</span>
            </div>
          </div>
          <div className="diagram-caption">
            <span />
            LOCAL FIRST. ALWAYS YOURS.
          </div>
        </div>
      </section>
      <section className="quick-launch-section" aria-label="快捷启动">
        <div className="section-heading">
          <h2>
            <Zap size={18} /> 快捷启动 <span>{quickLaunch.length}</span>
          </h2>
          <TextLink onClick={() => setPage('scenes')}>管理快捷启动</TextLink>
        </div>
        {quickLaunch.length ? (
          <div className="quick-launch-grid">
            {quickLaunch.map((scene) => (
              <article className="quick-launch-card" key={scene.id} data-scene-id={scene.id}>
                <SceneIcon icon={scene.icon} color={scene.color} />
                <div className="quick-launch-info">
                  <strong title={scene.name}>{scene.name}</strong>
                  <small>{scene.workflow.nodes.length} 个任务</small>
                </div>
                <button
                  className="button primary small"
                  aria-label={`启动「${scene.name}」`}
                  disabled={busy}
                  onClick={() => void run(scene, 'quickLaunch')}
                >
                  <Play size={14} /> 启动
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="quick-launch-empty">
            <Zap size={20} />
            <p>
              在“我的场景”点击 <Zap size={14} aria-label="闪电图标" />
              ，把常用场景添加到这里。
            </p>
          </div>
        )}
      </section>
      <div className="stats-grid">
        <div>
          <span className="stat-icon">
            <Workflow size={19} />
          </span>
          <div>
            <span>我的场景</span>
            <strong>
              {data.scenes.length}
              <small> 个</small>
            </strong>
          </div>
        </div>
        <div>
          <span className="stat-icon">
            <CheckCircle2 size={19} />
          </span>
          <div>
            <span>成功运行</span>
            <strong>
              {successful}
              <small> 次</small>
            </strong>
          </div>
        </div>
        <div>
          <span className="stat-icon">
            <Clock3 size={19} />
          </span>
          <div>
            <span>最近运行耗时</span>
            <strong className="duration-stat">
              {data.runs[0]?.endedAt ? formatDuration(data.runs[0].durationMs) : '—'}
            </strong>
          </div>
        </div>
      </div>
      <div className="section-heading">
        <h2>
          你的场景 <span>{data.scenes.length.toString().padStart(2, '0')}</span>
        </h2>
        <TextLink onClick={() => setPage('scenes')}>查看全部</TextLink>
      </div>
      <div className="scene-grid">
        {data.scenes.slice(0, 2).map((scene) => (
          <button className="scene-card" key={scene.id} onClick={() => edit(scene)}>
            <div className="scene-card-top">
              <SceneIcon icon={scene.icon} color={scene.color} />
              <ArrowUpRight size={19} className="muted" />
            </div>
            <h3>{scene.name}</h3>
            <p>{scene.description || '为你的工作日准备好一切'}</p>
            <div className="scene-card-footer">
              <span>{scene.workflow.nodes.length} 个任务</span>
              {scene.isDefault ? (
                <span className="default-tag">默认启动</span>
              ) : (
                <span>手动运行</span>
              )}
            </div>
          </button>
        ))}
        <button className="scene-card add-scene" onClick={create}>
          <span className="add-circle">
            <Plus size={22} />
          </span>
          <h3>构建你的工作流</h3>
          <p>将每天的准备，变成一次启动。</p>
          <span className="text-link">
            新建场景 <ArrowRight size={15} />
          </span>
        </button>
      </div>
      <div className="section-heading">
        <h2>最近活动</h2>
        <TextLink onClick={() => setPage('runs')}>运行历史</TextLink>
      </div>
      {data.runs.length ? (
        <div className="activity-list">
          {data.runs.slice(0, 3).map((r) => (
            <button
              key={r.id}
              className="activity-row"
              onClick={() => {
                setSelectedRun(r.id);
                setPage('runs');
              }}
            >
              <span className="activity-icon">
                <Workflow size={18} />
              </span>
              <div>
                <strong>{r.sceneName}</strong>
                <small>
                  {dateLabel(r.startedAt)} · 版本 {r.sceneVersion}
                </small>
              </div>
              <Status status={r.status} />
              <span className="activity-duration">
                {r.endedAt ? formatDuration(r.durationMs) : '进行中'}
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))}
        </div>
      ) : (
        <div className="quiet-empty">
          <Clock3 size={20} />
          <div>
            <strong>新的工作流，从这里开始</strong>
            <p>运行场景后，这里会记录每一次准备的结果。</p>
          </div>
        </div>
      )}
      <div className="privacy-note">
        <ShieldCheck size={15} />
        只在你的设备上运行。场景与日志，始终由你掌控。
      </div>
    </div>
  );
}
