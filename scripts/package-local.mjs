/** Package an existing unsigned Windows build for local acceptance. Does not install or publish. */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
if (process.platform !== 'win32') throw Error('This local acceptance package targets Windows');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const local = existsSync('.local/build.json')
  ? JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''))
  : {};
const source = resolve(process.env.CARGO_TARGET_DIR || local.targetDir || 'target', 'release');
const root = resolve(process.argv[2] || 'artifacts/phase4'),
  destination = join(root, 'windows');
const directory = join(destination, `LaunchFlow-${version}-windows-x64`);
await mkdir(join(directory, 'native'), { recursive: true });
const installer = `LaunchFlow_${version}_x64-setup.exe`,
  archive = `LaunchFlow_${version}_windows-x64-portable.zip`;
await copyFile(join(source, 'bundle/nsis', installer), join(destination, installer));
await copyFile(join(source, 'launchflow.exe'), join(directory, 'LaunchFlow.exe'));
for (const name of [
  'launchflow-automation.exe',
  'launchflow-harness.exe',
  'launchflow-authorized.exe',
])
  await copyFile(join(source, 'native', name), join(directory, 'native', name));
await writeFile(
  join(directory, 'README.txt'),
  `LaunchFlow ${version} — Windows x64 本地构建\n\n解压整个文件夹，保留 native 子目录，然后运行 LaunchFlow.exe。\n需要 Windows 10/11、WebView2 与系统 .NET Framework。数据保存在当前用户应用数据目录；此 ZIP 不是数据隔离模式。\n\n解锁前准备：设置中选择“解锁前准备桌面应用”，配合 Windows 登录选项中的自动完成设置，设置默认场景；依赖 Windows ARSO 条件，详见 DESKTOP-STARTUP.md。\n录制修复：审阅关闭、放弃或插入后不会反复弹出；详见 RECORDING-REVIEW-FIX.md。\n管理员关闭：工作区的一键关闭会为被拒绝的管理员应用请求 Windows 授权；正常关闭优先，强制退出仍需另行确认，详见 WORKSPACE-CLOSE.md。\n\n预授权启动：应用库勾选“使用预授权启动”，点击“保存并授权免确认启动”，首次在 Windows 确认一次。后续固定应用与参数通过已授权任务启动，程序更新后须重新授权。可刷新状态或撤销授权。详见 PREAUTHORIZED-LAUNCH.md，其中记录当前版本的实机验收状态。\n管理员启动：需要权限的 .exe 自动请求 Windows UAC；也可在应用库勾选“以管理员身份启动”。请在系统授权框亲自确认，拒绝授权后不自动重试。详见 UAC-LAUNCH-FIX.md。\n工作区：捕获窗口，选择启动顺序、Relative / Exact 与 Office / Home / Laptop。\n迁移：导出 YAML 或完整 .launchflow 包，导入时完成应用、路径、Secret 映射与预览确认。\n凭据：权限与凭据页管理 vault:ID；不会随场景导出。\n旧场景升级默认阻止启动时敏感动作，请在编辑器重新检查策略。\n\n本地构建未签名；Updater 未配置而禁用。不是 V1 Release Candidate。\nMac 与多屏实机、签名升级、安装/卸载及真实 Docker 完整链路仍有验收缺口。\n历史 Phase 4 验收边界见 V1-RELEASE-READINESS.md，发行流程见 RELEASE.md。\n`,
);
for (const name of [
  'V1-RELEASE-READINESS.md',
  'RELEASE.md',
  'UAC-LAUNCH-FIX.md',
  'PREAUTHORIZED-LAUNCH.md',
  'APPLICATION-DIAGNOSTICS.md',
  'WORKSPACE-CLOSE.md',
  'DEFAULT-SCENE-FIX.md',
  'APPLICATION-ICONS.md',
  'DESKTOP-STARTUP.md',
  'RECORDING-REVIEW-FIX.md',
  'GUI-FOCUS-FIX.md',
])
  await copyFile(join('docs', name), join(directory, name));
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const powershellEnv = {
  ...process.env,
  PSModulePath: join(
    process.env.SystemRoot || 'C:/Windows',
    'System32/WindowsPowerShell/v1.0/Modules',
  ),
};
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ErrorActionPreference='Stop'; for ($archiveAttempt=0; $archiveAttempt -lt 5; $archiveAttempt++) { try { Compress-Archive -LiteralPath ${quote(directory)} -DestinationPath ${quote(join(destination, archive))} -Force -ErrorAction Stop; exit 0 } catch { if ($archiveAttempt -eq 4) { throw }; Start-Sleep -Milliseconds (750 * ($archiveAttempt + 1)) } }`,
  ],
  { stdio: 'inherit', windowsHide: true, env: powershellEnv },
);
const files = [];
for (const name of [installer, archive]) {
  const data = await readFile(join(destination, name));
  files.push({
    file: 'windows/' + name,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  });
}
const nativeResult = JSON.parse(
  execFileSync(join(directory, 'native/launchflow-automation.exe'), [], {
    input: JSON.stringify({ op: 'permissions' }) + '\n',
    encoding: 'utf8',
    windowsHide: true,
  }),
);
if (!nativeResult.ok) throw Error('Packaged native worker did not run');
const signatures = JSON.parse(
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `@(${quote(join(directory, 'LaunchFlow.exe'))},${quote(join(destination, installer))}) | ForEach-Object { $signature=Get-AuthenticodeSignature -LiteralPath $_; [pscustomobject]@{file=[IO.Path]::GetFileName($_);status=[string]$signature.Status} } | ConvertTo-Json -Compress`,
    ],
    { encoding: 'utf8', windowsHide: true, env: powershellEnv },
  ),
);
await writeFile(
  join(root, 'manifest.json'),
  JSON.stringify(
    {
      version,
      label: 'Local acceptance build — not V1 Release Candidate',
      created: new Date().toISOString(),
      platform: 'windows-x64',
      signatures,
      packagedWorkerPermissions: nativeResult.result,
      files,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(files, null, 2));
