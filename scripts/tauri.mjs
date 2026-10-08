import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
const cargoBin = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'bin');
const local = existsSync('.local/build.json')
  ? JSON.parse(readFileSync('.local/build.json', 'utf8').replace(/^\uFEFF/, ''))
  : {};
const rustup = join(cargoBin, process.platform === 'win32' ? 'rustup.exe' : 'rustup');
const toolchainBin = existsSync(rustup)
  ? join(execFileSync(rustup, ['which', 'cargo'], { encoding: 'utf8' }).trim(), '..')
  : cargoBin;
if (process.env.LAUNCHFLOW_NATIVE_PREBUILT !== '1')
  execFileSync(process.execPath, ['scripts/build-native.mjs', ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
  });
const child = spawn(
  process.execPath,
  [join('node_modules', '@tauri-apps', 'cli', 'tauri.js'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(local.targetDir && !process.env.CARGO_TARGET_DIR
        ? { CARGO_TARGET_DIR: local.targetDir }
        : {}),
      PATH: `${toolchainBin}${delimiter}${cargoBin}${delimiter}${process.env.PATH}`,
    },
  },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
