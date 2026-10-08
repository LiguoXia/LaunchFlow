import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
const bin = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'bin');
const local = existsSync('.local/build.json')
  ? JSON.parse(readFileSync('.local/build.json', 'utf8').replace(/^\uFEFF/, ''))
  : {};
const rustup = join(bin, process.platform === 'win32' ? 'rustup.exe' : 'rustup');
const cargo = existsSync(rustup)
  ? execFileSync(rustup, ['which', 'cargo'], { encoding: 'utf8' }).trim()
  : 'cargo';
const toolchainBin = cargo === 'cargo' ? bin : join(cargo, '..');
const args = process.argv.slice(2);
const subcommand = args[0];
const companion = ['fmt', 'clippy'].includes(subcommand)
  ? join(toolchainBin, `cargo-${subcommand}${process.platform === 'win32' ? '.exe' : ''}`)
  : null;
const child = spawn(companion && existsSync(companion) ? companion : cargo, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(local.targetDir && !process.env.CARGO_TARGET_DIR
      ? { CARGO_TARGET_DIR: local.targetDir }
      : {}),
    PATH: `${toolchainBin}${delimiter}${bin}${delimiter}${process.env.PATH}`,
  },
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
