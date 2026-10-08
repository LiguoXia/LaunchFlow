import { invoke } from '@tauri-apps/api/core';
import type { ApplicationProfile, Scene } from '../domain/types';
import type { WindowTarget } from './automation';
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DisplayDescriptor {
  id: string;
  name: string;
  bounds: Rect;
  workArea: Rect;
  scale: number;
  primary: boolean;
}
export interface CapturedWindow {
  identity: WindowTarget;
  application: ApplicationProfile;
  startedAt: string | null;
  display: DisplayDescriptor;
  bounds: Rect;
  relative: Rect;
  state: 'normal' | 'maximized' | 'minimized';
}
export interface WorkspaceCapture {
  displays: DisplayDescriptor[];
  windows: CapturedWindow[];
}
export interface WindowLayout extends Omit<CapturedWindow, 'application' | 'startedAt'> {
  applicationId: string;
}
export interface WorkspaceProfile {
  name: string;
  condition: { count: number | null; displayNames: string[] };
  windows: WindowLayout[];
}
export interface RestoreConfig {
  mode: 'relative' | 'exact';
  profiles: WorkspaceProfile[];
  skipMissingWindows: boolean;
}
export interface Mappings {
  applications: Record<string, string>;
  paths: Record<string, string>;
  secrets: Record<string, string>;
}
export interface Binding {
  kind: 'application' | 'path' | 'secret' | 'asset';
  source: string;
  label: string;
  target: string;
  found: boolean;
}
export interface ImportPreview {
  token: string;
  migrated: boolean;
  analysis: {
    bindings: Binding[];
    warnings: string[];
    ready: boolean;
    document: {
      schemaVersion: number;
      scene: Scene;
      subflows: Scene[];
      applications: ApplicationProfile[];
    };
  };
}
export const product = {
  closeCapture: () => invoke<CloseCapture>('workspace_close_capture'),
  closeSelect: (token: string, id: string, selected: boolean) =>
    invoke<void>('workspace_close_select', { token, id, selected }),
  closeExecute: (
    token: string,
    ids: string[],
    action: 'graceful' | 'status' | 'force',
    confirmed = false,
  ) => invoke<CloseCapture>('workspace_close_execute', { token, ids, action, confirmed }),
  closeShortcut: () =>
    invoke<{ shortcut: string; error: string | null }>('workspace_close_shortcut'),
  saveCloseShortcut: (shortcut: string) =>
    invoke<void>('workspace_close_shortcut_save', { shortcut }),
  diagnostics: (path: string) => invoke<void>('export_diagnostics', { path }),
  updateStatus: () => invoke<UpdateStatus>('update_status'),
  updateCheck: () => invoke<UpdateStatus>('update_check'),
  updateInstall: (version: string) => invoke<void>('update_install', { version, confirmed: true }),
  exportScene: (sceneId: string, path: string, packageFile: boolean) =>
    invoke<void>('scene_export', { sceneId, path, package: packageFile }),
  importPreview: (path: string) => invoke<ImportPreview>('scene_import_preview', { path }),
  importRebind: (token: string, mappings: Mappings) =>
    invoke<ImportPreview>('scene_import_rebind', { token, mappings }),
  importCommit: (token: string, mappings: Mappings) =>
    invoke<Scene>('scene_import_commit', { token, mappings }),
  vaultMetadata: () => invoke<{ id: string; label: string; updatedAt: string }[]>('vault_metadata'),
  vaultWrite: (id: string, label: string, value: string, update: boolean) =>
    invoke<void>('vault_write', { id, label, value, update }),
  vaultDelete: (id: string) => invoke<void>('vault_delete', { id }),
  capture: () => invoke<WorkspaceCapture>('workspace_capture'),
  createFromWorkspace: (
    name: string,
    windows: CapturedWindow[],
    captureLayout: boolean,
    profileName: string,
    monitorCount: number,
  ) =>
    invoke<Scene>('workspace_create_scene', {
      name,
      windows,
      captureLayout,
      profileName,
      monitorCount,
    }),
};
export interface CloseApp {
  id: string;
  name: string;
  executable: string;
  windows: string[];
  selected: boolean;
  blocked: string | null;
  state: string;
  message: string;
  canForce: boolean;
}
export interface CloseCapture {
  token: string;
  apps: CloseApp[];
}
export interface UpdateStatus {
  enabled: boolean;
  reason: string;
  version: string | null;
  notes: string | null;
}
