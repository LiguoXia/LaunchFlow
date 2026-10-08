import { beforeEach, expect, test, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
  vi.useFakeTimers();
});

test('coalesces duplicate icons and limits each batch to 24 applications', async () => {
  invoke.mockImplementation(async (_name, { sources }) =>
    sources.map(() => 'data:image/png;base64,a'),
  );
  const { loadApplicationIcon } = await import('./application-icons');
  const source = { path: 'C:\\app.exe', bundleId: '' };
  const first = loadApplicationIcon(source);
  expect(loadApplicationIcon(source)).toBe(first);
  const other = Array.from({ length: 25 }, (_, i) =>
    loadApplicationIcon({ ...source, path: `C:\\${i}.exe` }),
  );
  await vi.runAllTimersAsync();
  await Promise.all([first, ...other]);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls.map((c) => c[1].sources.length)).toEqual([24, 2]);
  await expect(loadApplicationIcon(source)).resolves.toBe('data:image/png;base64,a');
  expect(invoke).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

test('recovers after extraction failure and never loads remote image responses', async () => {
  const { loadApplicationIcon } = await import('./application-icons');
  const source = { path: 'C:\\later.exe', bundleId: '' };
  invoke.mockRejectedValueOnce(new Error('worker unavailable'));
  const first = loadApplicationIcon(source);
  await vi.runAllTimersAsync();
  await expect(first).resolves.toBeNull();
  await vi.advanceTimersByTimeAsync(5001);
  invoke.mockResolvedValueOnce(['https://example.invalid/icon.png']);
  const next = loadApplicationIcon(source);
  await vi.runAllTimersAsync();
  await expect(next).resolves.toBeNull();
  await vi.advanceTimersByTimeAsync(5001);
  invoke.mockResolvedValueOnce(['data:image/png;base64,a']);
  const recovered = loadApplicationIcon(source);
  await vi.runAllTimersAsync();
  await expect(recovered).resolves.toBe('data:image/png;base64,a');
  vi.useRealTimers();
});
