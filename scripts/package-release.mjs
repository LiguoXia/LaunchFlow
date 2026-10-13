/** Verify the exact bundled native workers, then prepare GitHub Release assets. */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const target = process.argv[2];
const platforms = {
  'x86_64-pc-windows-msvc': { host: 'win32', name: 'windows-x64' },
  'x86_64-apple-darwin': { host: 'darwin', name: 'macos-intel', arch: 'x86_64' },
  'aarch64-apple-darwin': { host: 'darwin', name: 'macos-apple-silicon', arch: 'arm64' },
};
const platform = platforms[target];
if (!platform || process.platform !== platform.host)
  throw Error('Build on the matching native host');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const local = existsSync('.local/build.json')
  ? JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''))
  : {};
const source = resolve(
  process.env.CARGO_TARGET_DIR || local.targetDir || 'target',
  target,
  'release',
);
const destination = resolve('artifacts', 'github-release');
await mkdir(destination, { recursive: true });
const files = [];
const workers = [];
let startup = null;

function request(worker, value) {
  const response = JSON.parse(
    execFileSync(worker, [], {
      input: JSON.stringify(value) + '\n',
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    }),
  );
  if (!response.ok) throw Error(`Bundled worker rejected ${value.op}: ${response.error?.code}`);
  return response.result;
}
function verifyMacBinary(path) {
  execFileSync('lipo', ['-verify_arch', platform.arch, path], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', path], { stdio: 'inherit' });
}
async function checkStartup(binary) {
  // A fresh CI user has no saved workflows. --startup keeps the smoke run hidden.
  const child = spawn(binary, ['--startup'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-8192);
  });
  try {
    await new Promise((resolveStartup, reject) => {
      const timer = setTimeout(resolveStartup, 6000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(Error(`Packaged app exited during startup (${code ?? signal}): ${stderr}`));
      });
    });
    if (/panicked|could not start/i.test(stderr)) throw Error(stderr);
    return { stayedRunning: true, observationSeconds: 6 };
  } finally {
    child.kill('SIGTERM');
    await new Promise((done) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}

if (platform.host === 'win32') {
  const installer = `LaunchFlow_${version}_x64-setup.exe`;
  await copyFile(join(source, 'bundle', 'nsis', installer), join(destination, installer));
  files.push(installer);
  const directory = resolve('artifacts', 'portable', `LaunchFlow-${version}-windows-x64`);
  await mkdir(join(directory, 'native'), { recursive: true });
  await copyFile(join(source, 'launchflow.exe'), join(directory, 'LaunchFlow.exe'));
  for (const name of ['automation', 'harness', 'authorized']) {
    const path = join(directory, 'native', `launchflow-${name}.exe`);
    await copyFile(join(source, 'native', `launchflow-${name}.exe`), path);
    workers.push(path);
  }
  await writeFile(
    join(directory, 'README.txt'),
    `LaunchFlow ${version} / Windows x64\n解压整个文件夹，保留 native 子目录，运行 LaunchFlow.exe。\n需要 Windows 10/11 和 WebView2。数据保存在当前用户应用数据目录。\n本预发布版未使用发行证书签名，自动更新未配置，请手动升级。\n`,
  );
  const archive = `LaunchFlow_${version}_windows-x64-portable.zip`;
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath ${quote(directory)} -DestinationPath ${quote(join(destination, archive))} -Force`,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  files.push(archive);
} else {
  const app = join(source, 'bundle', 'macos', 'LaunchFlow.app');
  verifyMacBinary(join(app, 'Contents', 'MacOS', 'launchflow'));
  for (const name of ['automation', 'harness']) {
    const path = join(app, 'Contents', 'Resources', 'native', `launchflow-${name}`);
    verifyMacBinary(path);
    workers.push(path);
  }
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const dmgFiles = (await readdir(join(source, 'bundle', 'dmg'))).filter((name) =>
    name.endsWith('.dmg'),
  );
  if (dmgFiles.length !== 1) throw Error('Expected exactly one macOS DMG');
  const dmg = `LaunchFlow_${version}_${platform.name}.dmg`;
  await copyFile(join(source, 'bundle', 'dmg', dmgFiles[0]), join(destination, dmg));
  execFileSync('hdiutil', ['verify', join(destination, dmg)], { stdio: 'inherit' });
  files.push(dmg);
  const archive = `LaunchFlow_${version}_${platform.name}.app.zip`;
  execFileSync(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(destination, archive)],
    { stdio: 'inherit' },
  );
  files.push(archive);
  startup = await checkStartup(join(app, 'Contents', 'MacOS', 'launchflow'));
}
const permissions = request(workers[0], { op: 'permissions' });
for (const key of ['accessibility', 'screenRecording', 'inputMonitoring', 'automation']) {
  if (!['granted', 'denied', 'notRequired'].includes(permissions[key]))
    throw Error(`Invalid permission response: ${key}`);
}
const icons = request(workers[0], { op: 'applicationIcons', sources: [] });
if (!Array.isArray(icons) || icons.length) throw Error('Unexpected icon response');
const manifest = {
  version,
  target,
  platform: platform.name,
  commit: process.env.GITHUB_SHA || null,
  signing: platform.host === 'darwin' ? 'ad-hoc; not notarized' : 'unsigned',
  startup,
  packagedWorkerPermissions: permissions,
  nativeWorkers: workers.map((path) => path.split(/[\\/]/).at(-1)),
  files: await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(join(destination, file));
      return {
        file,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  ),
};
await writeFile(
  join(destination, `verification-${platform.name}.json`),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(JSON.stringify(manifest, null, 2));
