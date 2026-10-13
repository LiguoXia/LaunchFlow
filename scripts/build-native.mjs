import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const out = join(root, 'native/bin');
mkdirSync(out, { recursive: true });
if (process.platform === 'win32') {
  const framework = join(
    process.env.WINDIR || 'C:/Windows',
    'Microsoft.NET/Framework64/v4.0.30319',
  );
  const refs = [
    'System.dll',
    'System.Core.dll',
    'Microsoft.CSharp.dll',
    'System.Xaml.dll',
    'System.Web.Extensions.dll',
    'System.Drawing.dll',
    'System.Windows.Forms.dll',
    'System.Runtime.WindowsRuntime.dll',
    'System.Runtime.dll',
    'System.Runtime.InteropServices.WindowsRuntime.dll',
    'System.Threading.Tasks.dll',
    'System.Collections.dll',
  ].map((x) => join(framework, x));
  for (const x of [
    'WindowsBase.dll',
    'UIAutomationClient.dll',
    'UIAutomationTypes.dll',
    'PresentationFramework.dll',
    'PresentationCore.dll',
  ])
    refs.push(join(framework, 'WPF', x));
  const kits = 'C:/Program Files (x86)/Windows Kits/10/UnionMetadata';
  const sdk = existsSync(kits)
    ? readdirSync(kits)
        .filter((x) => /^\d/.test(x))
        .sort()
        .reverse()
        .find((x) => existsSync(join(kits, x, 'Windows.winmd')))
    : null;
  if (!sdk)
    throw new Error('Windows 10 SDK UnionMetadata is required to compile the native OCR worker.');
  refs.push(join(kits, sdk, 'Windows.winmd'));
  const facades = join(framework, 'Facades');
  if (existsSync(facades))
    for (const name of [
      'System.Runtime.dll',
      'System.Runtime.InteropServices.WindowsRuntime.dll',
      'System.Threading.Tasks.dll',
      'System.Collections.dll',
    ])
      if (existsSync(join(facades, name))) refs.push(join(facades, name));
  const workerSources = [
    'Common.cs',
    'Automation.cs',
    'WindowFocus.cs',
    'RecordedPointer.cs',
    'RecordedText.cs',
    'PointerInput.cs',
    'Sessions.cs',
    'Ocr.cs',
    'Workspace.cs',
    'WorkspaceClose.cs',
    'WorkspaceCloseElevation.cs',
    'Vault.cs',
    'Launch.cs',
    'TaskAuthorization.cs',
    'ApplicationTrace.cs',
    'ApplicationIcons.cs',
    'ApplicationDiscovery.cs',
    'Startup.cs',
    'AutoLogon.cs',
    'AutoLogonDialog.cs',
  ];
  for (const [name, sources, kind, entry] of [
    ['automation', workerSources, 'exe'],
    [
      'authorized',
      [...workerSources, 'AuthorizedProgram.cs'],
      'winexe',
      'LaunchFlow.Native.AuthorizedProgram',
    ],
    ['harness', ['Common.cs', 'Harness.cs', 'Tutorial.cs'], 'winexe'],
  ]) {
    const input = sources.map((x) => join(root, 'native/windows', x));
    const binary = join(out, `launchflow-${name}.exe`);
    if (
      existsSync(binary) &&
      input.every(
        (x) =>
          Math.max(statSync(x).mtimeMs, statSync(import.meta.filename).mtimeMs) <
          statSync(binary).mtimeMs,
      )
    )
      continue;
    execFileSync(
      join(framework, 'csc.exe'),
      [
        '/nologo',
        '/optimize+',
        '/platform:x64',
        `/target:${kind}`,
        ...(entry ? [`/main:${entry}`] : []),
        `/out:${binary}`,
        ...refs.map((x) => `/reference:${x}`),
        ...input,
      ],
      { stdio: 'inherit', windowsHide: true },
    );
  }
} else if (process.platform === 'darwin') {
  for (const name of ['automation', 'harness']) {
    execFileSync(
      'xcrun',
      [
        'swiftc',
        '-O',
        '-framework',
        'AppKit',
        '-framework',
        'ApplicationServices',
        '-framework',
        'Vision',
        '-framework',
        'ScreenCaptureKit',
        '-framework',
        'CoreMedia',
        '-framework',
        'CoreImage',
        '-framework',
        'Security',
        '-target',
        `${process.argv.includes('aarch64-apple-darwin') ? 'arm64' : process.argv.includes('x86_64-apple-darwin') ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
        join(root, `native/macos/${name}.swift`),
        '-o',
        join(out, `launchflow-${name}`),
      ],
      { stdio: 'inherit' },
    );
    execFileSync('codesign', ['--force', '--sign', '-', join(out, `launchflow-${name}`)], {
      stdio: 'inherit',
    });
  }
} else throw new Error('Native automation supports Windows and macOS.');
