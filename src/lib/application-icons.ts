import { invoke } from '@tauri-apps/api/core';

export interface IconSource {
  path: string;
  bundleId: string;
}
const cache = new Map<string, { value: string | null; expires: number }>();
const pending = new Map<string, Promise<string | null>>();
const queue: { key: string; source: IconSource; resolve: (value: string | null) => void }[] = [];
let scheduled = false;

async function flush() {
  while (queue.length) {
    const batch = queue.splice(0, 24);
    let icons: (string | null)[] = [];
    try {
      icons = await invoke('application_icons', { sources: batch.map((item) => item.source) });
    } catch {
      /* Icons are optional; loading one must never block application operations. */
    }
    batch.forEach((item, index) => {
      const value = icons[index]?.startsWith('data:image/png;base64,') ? icons[index] : null;
      cache.delete(item.key);
      cache.set(item.key, { value, expires: Date.now() + (value ? 60_000 : 5_000) });
      while (cache.size > 256) cache.delete(cache.keys().next().value!);
      pending.delete(item.key);
      item.resolve(value);
    });
  }
  scheduled = false;
}

export function loadApplicationIcon(source: IconSource): Promise<string | null> {
  if (!source.path && !source.bundleId) return Promise.resolve(null);
  const key = JSON.stringify(source);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = new Promise<string | null>((resolve) => queue.push({ key, source, resolve }));
  pending.set(key, promise);
  if (!scheduled) {
    scheduled = true;
    setTimeout(() => void flush(), 20);
  }
  return promise;
}
