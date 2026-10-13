/** Publish only after every platform's package verification and checksum passes. */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const tag = `v${version}`;
if (process.env.GITHUB_REF_NAME !== tag) throw Error('Release tag and package version must match');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tagged = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
if (head !== tagged) throw Error('Release checkout does not match the tag');
const destination = resolve('artifacts', 'github-release');
const assets = [];
const checksums = [];
for (const platform of ['windows-x64', 'macos-intel', 'macos-apple-silicon']) {
  const report = join(destination, `verification-${platform}.json`);
  const manifest = JSON.parse(await readFile(report, 'utf8'));
  if (
    manifest.version !== version ||
    manifest.commit !== head ||
    manifest.platform !== platform ||
    manifest.files.length !== 2
  )
    throw Error(`Mismatched verification report: ${platform}`);
  if (platform.startsWith('macos') && manifest.startup?.stayedRunning !== true)
    throw Error(`Missing packaged startup verification: ${platform}`);
  for (const file of manifest.files) {
    if (!file.file.startsWith(`LaunchFlow_${version}_`) || /[\\/]/.test(file.file))
      throw Error('Invalid asset name');
    const path = join(destination, file.file);
    const bytes = await readFile(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== file.sha256 || bytes.length !== file.bytes)
      throw Error(`Checksum mismatch: ${file.file}`);
    checksums.push(`${sha256}  ${file.file}`);
    assets.push(path);
  }
  assets.push(report);
}
const checksumFile = join(destination, 'SHA256SUMS.txt');
await writeFile(checksumFile, checksums.sort().join('\n') + '\n');
assets.push(checksumFile);
const gh = (args) => execFileSync('gh', args, { stdio: 'inherit', windowsHide: true });
let releaseExists = false;
try {
  execFileSync('gh', ['release', 'view', tag, '--json', 'tagName'], { stdio: 'pipe' });
  releaseExists = true;
} catch (error) {
  if (error.status !== 1) throw error;
}
if (!releaseExists)
  gh([
    'release',
    'create',
    tag,
    '--verify-tag',
    '--draft',
    '--prerelease',
    '--title',
    `LaunchFlow ${tag} — Windows 与 macOS Intel / Apple Silicon`,
    '--notes-file',
    `docs/releases/${tag}.md`,
  ]);
gh(['release', 'upload', tag, ...assets, '--clobber']);
gh([
  'release',
  'edit',
  tag,
  '--draft=false',
  '--prerelease',
  '--latest=false',
  '--notes-file',
  `docs/releases/${tag}.md`,
]);
