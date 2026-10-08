import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const target = process.argv[2];
if (!['x86_64-pc-windows-msvc', 'x86_64-apple-darwin', 'aarch64-apple-darwin'].includes(target))
  throw Error('Choose a supported release target');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const root = resolve(process.env.CARGO_TARGET_DIR || 'target', target, 'release/bundle');
async function files(path) {
  const all = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) all.push(...(await files(p)));
    else if (entry.isFile()) all.push(p);
  }
  return all;
}
const all = await files(root),
  signatures = all.filter((p) => p.endsWith('.sig'));
if (!signatures.length) throw Error('Release blocked: updater signatures are missing');
for (const file of signatures) {
  if (!existsSync(file.slice(0, -4))) throw Error('Update signature has no artifact');
  const signature = Buffer.from((await readFile(file, 'utf8')).trim(), 'base64').toString('utf8');
  if (
    !signature
      .split('\n')
      .some(
        (line) =>
          line.startsWith('trusted comment:') && line.split(/\s+/).includes('version:' + version),
      )
  )
    throw Error('Updater signature must include the current version in its signed comment');
}
if (process.platform === 'win32') {
  if (!process.env.SIGNTOOL_PATH) throw Error('SIGNTOOL_PATH is required');
  for (const file of [
    ...all.filter((p) => p.endsWith('.exe')),
    resolve('native/bin/launchflow-automation.exe'),
    resolve('native/bin/launchflow-authorized.exe'),
    resolve('native/bin/launchflow-harness.exe'),
  ])
    execFileSync(process.env.SIGNTOOL_PATH, ['verify', '/pa', file], {
      stdio: 'inherit',
      windowsHide: true,
    });
} else {
  const app = join(root, 'macos', 'LaunchFlow.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose', app], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
}
const artifacts = [];
for (const file of all.filter((p) => /\.(exe|dmg|gz|sig)$/.test(p))) {
  const bytes = await readFile(file);
  artifacts.push({
    file: file.slice(root.length + 1),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await mkdir('artifacts', { recursive: true });
await writeFile(
  `artifacts/release-verification-${target}.json`,
  JSON.stringify(
    {
      version,
      target,
      osSignatures: 'verified',
      updaterVersionComments: 'present',
      updaterEndToEnd: 'Required against staging distribution before public release',
      artifacts,
    },
    null,
    2,
  ),
);
console.log(
  'Release artifact checks passed. No upload or publication was performed by this script.',
);
