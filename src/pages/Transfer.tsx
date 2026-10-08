import { useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Download, Upload, Check, RefreshCw } from 'lucide-react';
import { PageTitle } from '../components/ui';
import ApplicationIcon from '../components/ApplicationIcon';
import { product, type ImportPreview, type Mappings } from '../lib/product';
import { useWorkspace } from '../lib/workspace';
const emptyMappings = (): Mappings => ({ applications: {}, paths: {}, secrets: {} });
const bindingLabel = { application: '应用', path: '路径', secret: '凭据引用', asset: '图片资产' };
export default function Transfer() {
  const { data, perform, busy, refresh, edit, notify } = useWorkspace();
  const [sceneId, setSceneId] = useState(data.scenes[0]?.id || '');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mappings, setMappings] = useState<Mappings>(emptyMappings);
  const [dirty, setDirty] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [secrets, setSecrets] = useState<Awaited<ReturnType<typeof product.vaultMetadata>>>([]);
  const [importPath, setImportPath] = useState('');
  const previewFile = async (path: string) => {
    setPreview(await product.importPreview(path));
    setImportPath(path);
    setMappings(emptyMappings());
    setDirty(false);
    setReviewed(false);
    setSecrets(await product.vaultMetadata());
  };
  const load = () =>
    perform(async () => {
      const path = await open({
        multiple: false,
        filters: [{ name: 'LaunchFlow 场景', extensions: ['launchflow', 'yaml', 'yml', 'json'] }],
      });
      if (!path) return;
      await previewFile(path);
    });
  const exportScene = (pkg: boolean) =>
    perform(async () => {
      const scene = data.scenes.find((s) => s.id === sceneId);
      if (!scene) return;
      const path = await save({
        defaultPath: scene.name.replace(/[<>:"/\\|?*]/g, '_') + (pkg ? '.launchflow' : '.yaml'),
        filters: [
          { name: pkg ? 'LaunchFlow Package' : 'YAML', extensions: [pkg ? 'launchflow' : 'yaml'] },
        ],
      });
      if (path) {
        await product.exportScene(sceneId, path, pkg);
        notify('场景已导出，包含子流程依赖；凭据仅保存引用');
      }
    });
  const mapping = (kind: 'applications' | 'paths' | 'secrets', source: string, target: string) => {
    setMappings((old) => ({ ...old, [kind]: { ...old[kind], [source]: target } }));
    setDirty(true);
    setReviewed(false);
  };
  return (
    <div className="page">
      <PageTitle
        eyebrow="PORTABILITY"
        title="场景，随设备迁移"
        description="版本化 YAML 与完整资产包。先校验，再重绑定、预览并导入。"
        actions={
          <button className="button primary" disabled={busy} onClick={() => void load()}>
            <Upload size={16} />
            选择导入文件
          </button>
        }
      />
      <section className="product-card">
        <h2>导入场景</h2>
        <div className="product-actions">
          <input
            aria-label="导入文件路径"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            placeholder="粘贴 YAML 或 .launchflow 文件的完整路径"
            style={{ flex: 1 }}
          />
          <button
            className="button secondary"
            disabled={busy || !importPath.trim()}
            onClick={() => void perform(() => previewFile(importPath.trim()))}
          >
            校验并预览
          </button>
        </div>
      </section>
      <section className="product-card">
        <h2>导出场景</h2>
        <div className="product-actions">
          <select
            aria-label="导出场景"
            value={sceneId}
            onChange={(e) => setSceneId(e.target.value)}
          >
            <option value="">选择场景</option>
            {data.scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            className="button secondary"
            disabled={busy || !sceneId}
            onClick={() => void exportScene(false)}
          >
            <Download size={16} />
            导出 YAML
          </button>
          <button
            className="button secondary"
            disabled={busy || !sceneId}
            onClick={() => void exportScene(true)}
          >
            <Download size={16} />
            导出 .launchflow 包
          </button>
        </div>
        <p className="muted">
          图片定位器建议使用完整包。YAML
          保留图片引用，导入设备需要已有相同资产。系统凭据不会被导出。
        </p>
      </section>
      {preview && (
        <section className="transfer-preview">
          <div className="section-heading">
            <div>
              <h2>Rebind · {preview.analysis.document.scene.name}</h2>
              <p className="muted">
                {preview.analysis.document.scene.workflow.nodes.length} 个节点 ·{' '}
                {preview.analysis.document.subflows.length} 个子流程 · Schema{' '}
                {preview.analysis.document.schemaVersion}
                {preview.migrated ? ' · 已迁移旧版本' : ''}
              </p>
            </div>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  setPreview(await product.importRebind(preview.token, mappings));
                  setDirty(false);
                  setReviewed(false);
                })
              }
            >
              <RefreshCw size={16} />
              检查映射
            </button>
          </div>
          <div className="info-strip">
            导入不会执行场景。所有触发器保持关闭，默认启动标记与启动命令授权将移除，敏感操作需要每次确认。
          </div>
          <div className="binding-table">
            <div className="binding-row binding-header">
              <span>资源 / 原始引用</span>
              <span>本机绑定</span>
              <span>状态</span>
            </div>
            {preview.analysis.bindings.map((b) => (
              <div className="binding-row" key={b.kind + b.source}>
                <div>
                  <strong>{bindingLabel[b.kind]}</strong>
                  <p title={b.source}>{b.label}</p>
                </div>
                <div>
                  {b.kind === 'application' ? (
                    <span className="application-select">
                      <ApplicationIcon
                        profile={data.profiles.find(
                          (p) => p.id === (mappings.applications[b.source] || b.target),
                        )}
                        size={24}
                      />
                      <select
                        aria-label={`映射应用 ${b.label}`}
                        value={mappings.applications[b.source] || b.target}
                        onChange={(e) => mapping('applications', b.source, e.target.value)}
                      >
                        {!data.profiles.some((p) => p.id === b.target) && (
                          <option value={b.target}>
                            {b.found ? '使用包内路径' : '请选择本机应用'}
                          </option>
                        )}
                        {data.profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName}
                          </option>
                        ))}
                      </select>
                    </span>
                  ) : b.kind === 'path' ? (
                    <input
                      aria-label={`映射路径 ${b.source}`}
                      value={mappings.paths[b.source] ?? b.target}
                      onChange={(e) => mapping('paths', b.source, e.target.value)}
                    />
                  ) : b.kind === 'secret' ? (
                    <input
                      aria-label={`映射凭据 ${b.source}`}
                      list="local-secret-references"
                      value={mappings.secrets[b.source] ?? b.target}
                      placeholder="vault:ID 或 env:NAME"
                      onChange={(e) => mapping('secrets', b.source, e.target.value)}
                    />
                  ) : (
                    <code>{b.target.slice(0, 16)}…</code>
                  )}
                </div>
                <strong className={b.found ? 'success-text' : 'danger-text'}>
                  {dirty ? '待检查' : b.found ? 'Found' : 'Missing'}
                </strong>
              </div>
            ))}
          </div>
          <datalist id="local-secret-references">
            {secrets.map((s) => (
              <option key={s.id} value={`vault:${s.id}`}>
                {s.label}
              </option>
            ))}
          </datalist>
          {!preview.analysis.bindings.length && (
            <p className="muted">此场景没有需要重绑定的资源。</p>
          )}
          <details className="run-snapshot">
            <summary>预览工作流与应用绑定</summary>
            <pre>{JSON.stringify(preview.analysis.document, null, 2)}</pre>
          </details>
          <p className="muted">
            {preview.analysis.warnings.length > 1
              ? '此包包含命令或敏感 GUI 操作，请核对目标、参数和输入。'
              : '校验通过后才可导入。缺失应用可先在应用库添加，缺失凭据可在权限与凭据中创建。'}
          </p>
          <div className="product-actions">
            <label>
              <input
                type="checkbox"
                checked={reviewed}
                disabled={dirty || !preview.analysis.ready}
                onChange={(e) => setReviewed(e.target.checked)}
              />{' '}
              我已核对预览内容和本机映射
            </label>
            <button
              className="button primary"
              disabled={busy || dirty || !reviewed || !preview.analysis.ready}
              onClick={() =>
                void perform(async () => {
                  const scene = await product.importCommit(preview.token, mappings);
                  setPreview(null);
                  await refresh();
                  edit(scene);
                  notify('已导入场景，触发器保持关闭');
                })
              }
            >
              <Check size={16} />
              导入场景
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
