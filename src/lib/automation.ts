import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Run, Scene } from '../domain/types';
export interface WindowTarget {
  application?: string;
  title?: string;
  className?: string;
  pid?: number;
  handle?: string;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Locator {
  kind: string;
  window: WindowTarget;
  role?: string;
  name?: string;
  automationId?: string;
  className?: string;
  frameworkId?: string;
  ancestorPath?: unknown[];
  text?: string;
  ocr?: boolean;
  assetId?: string;
  threshold?: number;
  scales?: number[];
  region?: Rect;
  x?: number;
  y?: number;
}
export interface NativeWindow extends WindowTarget {
  handle: string;
  bounds: Rect;
}
export interface NativeElement {
  role: string;
  name: string;
  automationId: string;
  className: string;
  frameworkId: string;
  bounds: Rect;
  window: NativeWindow;
  ancestorPath: unknown[];
  secure: boolean;
}
export interface NativeError {
  code: string;
  message: string;
  permission?: string;
  platform?: string;
}
export interface Diagnostic {
  application: string;
  window: WindowTarget;
  locatorAttempts: {
    index: number;
    kind: string;
    durationMs: number;
    success: boolean;
    error?: NativeError;
  }[];
  locatorUsed?: number;
  matchedElement?: NativeElement;
  durationMs: number;
  screenshot?: string;
  error?: NativeError;
}
export interface Session {
  id: string;
  mode: string;
  status: string;
  element: NativeElement | null;
  locator: Locator | null;
  actions: Record<string, unknown>[];
  reviewed?: boolean;
  error?: NativeError;
}
export const errorText = (e: unknown) =>
  typeof e === 'object' && e !== null && 'message' in e ? String(e.message) : String(e);
export const stableWindow = (w: WindowTarget): WindowTarget => ({
  application: w.application,
  title: w.title,
  className: w.className?.startsWith('HwndWrapper[') ? '' : w.className,
});
export const automation = {
  permissions: () => invoke<Record<string, string>>('automation_permissions'),
  settings: (permission: string) => invoke('automation_settings', { permission }),
  windows: () => invoke<NativeWindow[]>('automation_windows'),
  elements: (window: WindowTarget) => invoke<NativeElement[]>('automation_elements', { window }),
  highlight: (locators: Locator[]) =>
    invoke<Diagnostic>('automation_highlight', { config: { locators } }),
  test: (
    scene: Scene,
    nodeId: string,
    parameters: Record<string, unknown> = {},
    approved = false,
  ) => invoke<Run>('automation_test_action', { scene, nodeId, parameters, approved }),
  start: (mode: 'pick' | 'record', window: WindowTarget) =>
    invoke<Session>('automation_session_start', { mode, window }),
  control: (operation: string) => invoke<void>('automation_session_control', { operation }),
  current: () => invoke<Session | null>('automation_session_current'),
  acknowledgeRecording: (id: string) => invoke<void>('automation_recording_acknowledge', { id }),
  onSession: (fn: (session: Session) => void) =>
    listen<Session>('launchflow://automationSession', (e) => fn(e.payload)),
  importAsset: (path: string) => invoke<{ id: string }>('automation_import_asset', { path }),
  captureAsset: (window: WindowTarget, region: Rect) =>
    invoke<{ id: string }>('automation_capture_asset', { window, region }),
  image: (id: string, asset = false) => invoke<string>('automation_image', { id, asset }),
  export: (scene: Scene, path: string) => invoke<void>('automation_export', { scene, path }),
  harness: () => invoke<{ pid: number; path: string }>('automation_launch_harness'),
};
