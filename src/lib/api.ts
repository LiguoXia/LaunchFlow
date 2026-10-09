import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ApplicationProfile,
  Bootstrap,
  Run,
  RunEvent,
  Scene,
  Settings,
  ValidationIssue,
  TriggerEvent,
} from '../domain/types';

export const desktopAvailable = isTauri();
export interface StartupStatus {
  registrationId: string;
  legacyEnabled: boolean;
  login?: { registered: boolean; matches: boolean };
  task: {
    registered?: boolean;
    enabled?: boolean;
    matches?: boolean;
    taskName?: string;
    error?: string;
  };
  conditions: {
    disabledByPolicy?: number | null;
    securityMode?: number | null;
    userOptOut?: number | null;
    mdmAllow?: number | null;
    domainJoined?: boolean | null;
    entraJoined?: boolean | null;
    autoLogonConfigured?: boolean | null;
    autoLogonManaged?: boolean;
  };
  observation: {
    started?: { at: string; desktopReady: boolean };
    dispatch?: { at: string; desktopReady: boolean };
    result?: { at: string; status: string; code: string; message: string };
  } | null;
  readiness: {
    ready: boolean;
    code: string;
    message: string;
    sceneId?: string;
    version?: number;
    canAuthorize: boolean;
  };
  desktopReady: boolean;
}
export interface ApplicationAuthorization {
  state: 'notAuthorized' | 'authorized' | 'changed' | 'unavailable' | 'unsupported';
  message: string;
  taskPath?: string;
}
export const api = {
  startupStatus: () => invoke<StartupStatus>('startup_status'),
  setStartupMode: (mode: 'login' | 'beforeUnlock' | 'disabled') =>
    invoke<void>('set_startup_mode', { mode }),
  openSigninSettings: () => invoke<void>('open_signin_settings'),
  openAutologonSettings: () => invoke<void>('open_autologon_settings'),
  configureAutologon: () =>
    invoke<{ status: 'enabled' | 'disabled' | 'cancelled' }>('configure_autologon'),
  authorizeDefaultStartup: (sceneId: string, version: number) =>
    invoke<void>('authorize_default_startup', { sceneId, version }),
  onCloseWorkspace: (fn: () => void) => listen('launchflow://closeWorkspace', fn),
  bootstrap: () => invoke<Bootstrap>('bootstrap'),
  diagnosticLog: (runId?: string) => invoke<string>('diagnostic_log', { runId: runId ?? null }),
  createScene: (name: string) => invoke<Scene>('create_scene', { name }),
  saveScene: (scene: Scene) => invoke<Scene>('save_scene', { scene }),
  duplicateScene: (sceneId: string) => invoke<Scene>('duplicate_scene', { sceneId }),
  deleteScene: (sceneId: string) => invoke<void>('delete_scene', { sceneId }),
  setDefault: (sceneId: string | null) => invoke<string | null>('set_default_scene', { sceneId }),
  saveDraft: (scene: Scene) => invoke<void>('save_draft', { scene }),
  getDraft: (sceneId: string) => invoke<Scene | null>('get_draft', { sceneId }),
  deleteDraft: (sceneId: string) => invoke<void>('delete_draft', { sceneId }),
  validate: (scene: Scene) => invoke<ValidationIssue[]>('validate_scene', { scene }),
  saveProfile: (profile: ApplicationProfile) => invoke<void>('save_profile', { profile }),
  deleteProfile: (profileId: string) => invoke<void>('delete_profile', { profileId }),
  applicationAuthorization: (profile: ApplicationProfile) =>
    invoke<ApplicationAuthorization>('application_authorization_status', { profile }),
  changeApplicationAuthorization: (profileId: string, grant: boolean) =>
    invoke<ApplicationAuthorization>('application_authorization_change', { profileId, grant }),
  sensitiveActions: (sceneId: string) => invoke<string[]>('sensitive_actions', { sceneId }),
  runScene: (sceneId: string, parameters: Record<string, unknown> = {}, approved = false) =>
    invoke<Run>('run_scene', { sceneId, parameters, approved }),
  pauseRun: (runId: string) => invoke<void>('pause_run', { runId }),
  resumeRun: (runId: string) => invoke<void>('resume_run', { runId }),
  decideNode: (runId: string, nodeId: string, action: 'retry' | 'skip') =>
    invoke<void>('decide_node', { runId, nodeId, action }),
  recoverRun: (runId: string, action: string, nodeId?: string, approved = false) =>
    invoke<Run>('recover_run', { runId, action, nodeId: nodeId ?? null, approved }),
  onTrigger: (fn: (event: TriggerEvent) => void) =>
    listen<TriggerEvent>('launchflow://trigger', (e) => fn(e.payload)),
  onConfigureScene: (fn: (scene: Scene) => void) =>
    listen<Scene>('launchflow://configureScene', (e) => fn(e.payload)),
  stopRun: (runId: string) => invoke<void>('stop_run', { runId }),
  deleteRun: (runId: string) => invoke<void>('delete_run', { runId }),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),
  setAutostart: (enabled: boolean) => invoke<boolean>('set_autostart', { enabled }),
  onRun: (fn: (event: RunEvent) => void) =>
    listen<RunEvent>('launchflow://run', (e) => fn(e.payload)),
  onError: (fn: (error: string) => void) =>
    listen<string>('launchflow://error', (e) => fn(e.payload)),
  onResync: (fn: () => void) => listen('launchflow://resync', fn),
};
