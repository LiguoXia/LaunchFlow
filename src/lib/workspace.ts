import { createContext, useContext } from 'react';
import type { Bootstrap, Page, Run, Scene } from '../domain/types';
export interface Workspace {
  data: Bootstrap;
  page: Page;
  setPage: (page: Page) => void;
  busy: boolean;
  selectedScene: Scene | null;
  selectedRun: string | null;
  setSelectedRun: (id: string | null) => void;
  refresh: () => Promise<void>;
  setDefaultScene: (sceneId: string | null) => Promise<void>;
  renameScene: (scene: Scene, name: string) => Promise<Scene>;
  reorderScenes: (sceneIds: string[]) => Promise<void>;
  setSceneQuickLaunch: (sceneId: string, enabled: boolean) => Promise<void>;
  registerEditorLeave: (handler: () => Promise<boolean>) => () => void;
  perform: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  edit: (scene: Scene) => void;
  run: (scene: Scene, source?: 'manual' | 'quickLaunch') => Promise<Run | undefined>;
  create: () => void;
  closeWorkspace: () => void;
  notify: (text: string, error?: boolean) => void;
  confirm: (title: string, body: string) => Promise<boolean>;
}
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('Workspace is not loaded');
  return ctx;
}
