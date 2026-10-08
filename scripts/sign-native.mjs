import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
for (const name of process.platform === 'win32'
  ? ['automation', 'harness', 'authorized']
  : ['automation', 'harness']) {
  const file = resolve(
    'native/bin/launchflow-' + name + (process.platform === 'win32' ? '.exe' : ''),
  );
  if (process.platform === 'win32') {
    for (const key of ['WINDOWS_SIGNING_THUMBPRINT', 'WINDOWS_TIMESTAMP_URL', 'SIGNTOOL_PATH'])
      if (!process.env[key]) throw Error('Missing signing setting: ' + key);
    execFileSync(
      process.env.SIGNTOOL_PATH,
      [
        'sign',
        '/sha1',
        process.env.WINDOWS_SIGNING_THUMBPRINT,
        '/fd',
        'SHA256',
        '/tr',
        process.env.WINDOWS_TIMESTAMP_URL,
        '/td',
        'SHA256',
        file,
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    execFileSync(process.env.SIGNTOOL_PATH, ['verify', '/pa', file], {
      stdio: 'inherit',
      windowsHide: true,
    });
  } else if (process.platform === 'darwin') {
    if (!process.env.APPLE_SIGNING_IDENTITY) throw Error('Missing APPLE_SIGNING_IDENTITY');
    execFileSync(
      'codesign',
      [
        '--force',
        '--options',
        'runtime',
        '--timestamp',
        '--sign',
        process.env.APPLE_SIGNING_IDENTITY,
        file,
      ],
      { stdio: 'inherit' },
    );
    execFileSync('codesign', ['--verify', '--strict', file], { stdio: 'inherit' });
  } else throw Error('Unsupported signing platform');
}
