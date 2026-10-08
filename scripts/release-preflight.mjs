/** Fail closed before a release build. Never print secret values. */
import { mkdir, writeFile } from 'node:fs/promises';
const required = [
  'LAUNCHFLOW_UPDATE_URL',
  'LAUNCHFLOW_UPDATE_PUBLIC_KEY',
  'TAURI_SIGNING_PRIVATE_KEY',
];
if (process.platform === 'win32')
  required.push('WINDOWS_SIGNING_THUMBPRINT', 'WINDOWS_TIMESTAMP_URL');
else if (process.platform === 'darwin')
  required.push(
    'APPLE_SIGNING_IDENTITY',
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'APPLE_API_KEY_PATH',
  );
else throw new Error('Release packaging is supported on Windows and macOS');
const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error('Release blocked. Configure: ' + missing.join(', '));
  process.exit(1);
}
const endpoint = new URL(process.env.LAUNCHFLOW_UPDATE_URL);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
  throw new Error('Update endpoint must be HTTPS without embedded credentials');
const publicKey = Buffer.from(process.env.LAUNCHFLOW_UPDATE_PUBLIC_KEY, 'base64').toString('utf8');
if (!publicKey.startsWith('untrusted comment:') || !publicKey.includes('\n'))
  throw new Error('Invalid Tauri updater public key');
const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: {
      pubkey: process.env.LAUNCHFLOW_UPDATE_PUBLIC_KEY,
      endpoints: [process.env.LAUNCHFLOW_UPDATE_URL],
      requireSignedVersion: true,
    },
  },
};
if (process.platform === 'win32')
  config.bundle.windows = {
    certificateThumbprint: process.env.WINDOWS_SIGNING_THUMBPRINT,
    digestAlgorithm: 'sha256',
    timestampUrl: process.env.WINDOWS_TIMESTAMP_URL,
    tsp: true,
  };
else
  config.bundle.macOS = {
    signingIdentity: process.env.APPLE_SIGNING_IDENTITY,
    hardenedRuntime: true,
  };
await mkdir('.local', { recursive: true });
await writeFile('.local/release.json', JSON.stringify(config, null, 2));
console.log('Release configuration validated. No artifacts have been published.');
