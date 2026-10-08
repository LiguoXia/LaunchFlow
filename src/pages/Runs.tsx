import { AutomationDiagnostic } from '../components/Automation';
import { DiagnosticLogButton } from '../components/DiagnosticLog';
import { useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock3, Play, Square, Trash2, Pause } from 'lucide-react';
import { Empty, PageTitle, StateIcon, Status } from '../components/ui';
import WorkflowNodeIcon from '../components/WorkflowNodeIcon';
import { dateLabel, formatDuration } from '../domain/editor';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
export default function Runs() {
  const { data, selectedRun, setSelectedRun, perform, refresh, run, busy, confirm } =
    useWorkspace();
  const [filter, setFilter] = useState('all');
  const detail = data.runs.find((r) => r.id === selectedRun);
  if (detail) {
    const done = detail.nodeRuns.filter((n) => ['succeeded', 'skipped'].includes(n.status)).length;
    const scene = data.scenes.find((s) => s.id === detail.sceneId);
    const active = ['running', 'paused', 'queued'].includes(detail.status);
    const recover = (action: string, nodeId?: string) =>
      void perform(async () => {
        let next;
        try {
          next = await api.recoverRun(detail.id, action, nodeId);
        } catch (error) {
          if (!String(error).includes('sensitiveApprovalRequired:')) throw error;
          if (
            !(await confirm(
              '确认恢复中的敏感操作',
              '恢复可能重复执行命令、输入或点击。请先核对下方快照及目标应用状态，再确认本次恢复。',
            ))
          )
            return;
          next = await api.recoverRun(detail.id, action, nodeId, true);
        }
        await refresh();
        setSelectedRun(next.id);
      });
    return (
      <div className="page">
        <button className="back-link" onClick={() => setSelectedRun(null)}>
          <ArrowLeft size={15} />
          运行历史
        </button>
        <PageTitle
          eyebrow={`RUN · VERSION ${detail.sceneVersion}`}
          title={detail.sceneName}
          description={`${dateLabel(detail.startedAt)} · ${detail.source}`}
          actions={
            <>
              <Status status={detail.status} />
              <DiagnosticLogButton runId={detail.id} />
              {active ? (
                <>
                  {detail.status === 'running' && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void perform(() => api.pauseRun(detail.id))}
                    >
                      <Pause size={15} />
                      暂停
                    </button>
                  )}
                  {detail.status === 'paused' && (
                    <button
                      className="button primary"
                      disabled={busy || detail.nodeRuns.some((n) => n.status === 'paused')}
                      onClick={() => void perform(() => api.resumeRun(detail.id))}
                    >
                      <Play size={15} />
                      恢复
                    </button>
                  )}
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() => void perform(() => api.stopRun(detail.id))}
                  >
                    <Square size={15} />
                    停止运行
                  </button>
                </>
              ) : (
                scene && (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void run(scene)}
                  >
                    <Play size={15} />
                    运行当前版本
                  </button>
                )
              )}
            </>
          }
        />
        <section className="run-summary">
          <div>
            <span>任务完成</span>
            <strong>
              {done}
              <small> / {detail.nodeRuns.length}</small>
            </strong>
          </div>
          <div>
            <span>总耗时</span>
            <strong className="time-value">
              {detail.endedAt ? formatDuration(detail.durationMs) : '运行中…'}
            </strong>
          </div>
          <div>
            <span>执行版本</span>
            <strong>v{detail.sceneVersion}</strong>
          </div>
          <div className="run-progress">
            <div>
              <span
                style={{
                  width: `${detail.nodeRuns.length ? (done / detail.nodeRuns.length) * 100 : 0}%`,
                }}
              />
            </div>
            <small>{detail.status === 'succeeded' ? '工作环境已就绪' : '每一步都有迹可循'}</small>
          </div>
        </section>
        {detail.error && (
          <div className="error-panel" role="alert">
            <strong>{detail.status === 'interrupted' ? '上次运行意外中断' : '运行未能完成'}</strong>
            <p>{detail.error}</p>
            <small>继续执行使用本次快照，并复用已成功节点的结果。</small>
          </div>
        )}
        {detail.status === 'paused' && (
          <div className="info-strip">
            已暂停新节点调度。正在执行的系统操作可完成；等待询问的节点请在下方选择重试或跳过。
          </div>
        )}
        {!active && ['failed', 'cancelled', 'interrupted'].includes(detail.status) && (
          <div className="recovery-actions">
            {detail.status === 'interrupted' && (
              <>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => recover('safeResume')}
                >
                  从安全点恢复
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      if (
                        await confirm(
                          '丢弃中断记录',
                          '删除此记录并返回历史列表。不会重新执行任何节点。',
                        )
                      ) {
                        await api.deleteRun(detail.id);
                        await refresh();
                        setSelectedRun(null);
                      }
                    })
                  }
                >
                  丢弃记录
                </button>
              </>
            )}
            <button
              className="button primary"
              disabled={busy}
              onClick={() => recover('retryFailed')}
            >
              重试失败节点
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => recover('continue')}
            >
              从失败处继续
            </button>
            <button
              className="button secondary"
              disabled={busy || !detail.nodeRuns.some((n) => n.status === 'failed' && !n.outlet)}
              onClick={() => recover('skip')}
            >
              跳过并继续
            </button>
            <button className="button secondary" disabled={busy} onClick={() => recover('restart')}>
              重新执行整个快照
            </button>
          </div>
        )}
        {detail.resumedFrom && (
          <button className="text-link" onClick={() => setSelectedRun(detail.resumedFrom!)}>
            查看原运行记录
          </button>
        )}
        {detail.parentRunId && (
          <button className="text-link" onClick={() => setSelectedRun(detail.parentRunId!)}>
            返回父流程
          </button>
        )}
        <details className="run-snapshot">
          <summary>运行快照 · {detail.sceneSnapshot.workflow.edges.length} 条依赖 · 参数</summary>
          <pre>{JSON.stringify(detail.parameterSnapshot ?? {}, null, 2)}</pre>
          <small>
            Scene {detail.sceneId} / v{detail.sceneVersion} · {detail.id}
          </small>
        </details>
        <div className="section-heading">
          <h2>执行步骤</h2>
          <span className="muted">保留执行时的场景快照</span>
        </div>
        <div className="node-run-list">
          {detail.nodeRuns.map((node, index) => (
            <details
              key={node.nodeId}
              className={`node-run ${node.status}`}
              open={['failed', 'paused'].includes(node.status) || undefined}
            >
              <summary>
                <span className="step-number">{(index + 1).toString().padStart(2, '0')}</span>
                <StateIcon status={node.status} />
                <div>
                  <strong>{node.name}</strong>
                  {detail.sceneSnapshot.workflow.nodes
                    .filter((n) => n.id === node.nodeId && !!n.config.applicationId)
                    .map((n) => (
                      <span className="run-application-icon" key={n.id}>
                        <WorkflowNodeIcon node={n} size={20} />
                      </span>
                    ))}
                  <small>{node.message || node.error || '等待前置步骤完成'}</small>
                </div>
                <Status status={node.status} />
                <span>{node.endedAt ? formatDuration(node.durationMs) : '—'}</span>
              </summary>
              <div className="node-run-detail">
                <p>{node.error || node.message || '暂无输出'}</p>
                <p className="muted">
                  重试 {node.retryCount} 次{node.outlet ? ` · 出口 ${node.outlet}` : ''}
                  {node.reusedFrom ? ' · 已复用原运行结果' : ''}
                </p>
                {node.status === 'paused' && (
                  <div className="recovery-actions">
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void perform(() => api.decideNode(detail.id, node.nodeId, 'retry'))
                      }
                    >
                      重试此节点
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void perform(() => api.decideNode(detail.id, node.nodeId, 'skip'))
                      }
                    >
                      跳过此节点
                    </button>
                  </div>
                )}
                {!active && ['failed', 'cancelled'].includes(node.status) && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => recover('continue', node.nodeId)}
                  >
                    从此节点继续
                  </button>
                )}
                {(node.output as { automation?: unknown })?.automation != null && (
                  <AutomationDiagnostic
                    value={(node.output as { automation: unknown }).automation}
                  />
                )}
                {node.output != null && (
                  <>
                    <label>output</label>
                    <pre>{JSON.stringify(node.output, null, 2)}</pre>
                  </>
                )}
                {data.runs
                  .filter((r) => r.parentRunId === detail.id && r.parentNodeId === node.nodeId)
                  .map((r) => (
                    <button key={r.id} className="text-link" onClick={() => setSelectedRun(r.id)}>
                      查看子流程 · {r.sceneName} · <Status status={r.status} />
                    </button>
                  ))}
                {node.stdout && (
                  <>
                    <label>stdout</label>
                    <pre>{node.stdout}</pre>
                  </>
                )}
                {node.stderr && (
                  <>
                    <label>stderr</label>
                    <pre>{node.stderr}</pre>
                  </>
                )}
                <span className="muted">节点 ID · {node.nodeId}</span>
              </div>
            </details>
          ))}
        </div>
      </div>
    );
  }
  const rows = data.runs.filter((r) => filter === 'all' || r.status === filter);
  return (
    <div className="page">
      <PageTitle
        eyebrow="RUN HISTORY"
        title="每次运行，都有记录"
        description={`保留最近 ${data.settings.retentionDays} 天的执行历史，最多显示最近 300 次。`}
      />
      <div className="list-toolbar">
        <div className="segmented">
          {[
            ['all', '全部'],
            ['succeeded', '已完成'],
            ['failed', '失败'],
            ['running', '运行中'],
            ['paused', '已暂停'],
            ['queued', '排队中'],
          ].map(([key, text]) => (
            <button
              className={filter === key ? 'active' : ''}
              key={key}
              onClick={() => setFilter(key)}
            >
              {text}
            </button>
          ))}
        </div>
        <span className="muted">{rows.length} 次运行</span>
      </div>
      {!rows.length ? (
        <Empty
          title="这里还没有运行记录"
          description="从首页或场景列表运行一个工作流，执行结果会保存在这里。"
        />
      ) : (
        <div className="history-table">
          <div className="table-head">
            <span>场景 / 时间</span>
            <span>状态</span>
            <span>任务</span>
            <span>耗时</span>
            <span />
          </div>
          {rows.map((r) => (
            <div className="table-row" key={r.id}>
              <button className="run-name" onClick={() => setSelectedRun(r.id)}>
                <span className="activity-icon">
                  {r.status === 'succeeded' ? <CheckCircle2 size={20} /> : <Clock3 size={20} />}
                </span>
                <span>
                  <strong>{r.sceneName}</strong>
                  <small>
                    {dateLabel(r.startedAt)} · v{r.sceneVersion}
                  </small>
                </span>
              </button>
              <Status status={r.status} />
              <span>
                {r.nodeRuns.filter((n) => n.status === 'succeeded').length} / {r.nodeRuns.length}
              </span>
              <span>{r.endedAt ? formatDuration(r.durationMs) : '—'}</span>
              <button
                className="icon-button danger-hover"
                aria-label="删除运行记录"
                disabled={['running', 'paused', 'queued'].includes(r.status) || busy}
                onClick={() =>
                  void perform(async () => {
                    if (await confirm('删除运行记录？', '此操作会删除本次运行的节点结果和日志。')) {
                      await api.deleteRun(r.id);
                      await refresh();
                    }
                  })
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
