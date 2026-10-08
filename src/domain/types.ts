export type NodeStatus =
  | 'pending'
  | 'queued'
  | 'waiting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'paused'
  | 'retrying';
export type RunStatus =
  'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface WorkflowNode {
  id: string;
  type: string;
  name: string;
  description: string;
  position: { x: number; y: number };
  enabled: boolean;
  config: Record<string, unknown>;
  retryPolicy: { maxRetries: number; delayMs: number };
  timeoutMs: number;
  failurePolicy: 'stopWorkflow' | 'skipAndContinue' | 'askUser' | 'failureBranch';
  platformConstraint: string[];
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
export interface Edge {
  id: string;
  from: string;
  to: string;
  outlet?: string;
}
export interface Parameter {
  name: string;
  kind: 'string' | 'number' | 'boolean' | 'select' | 'file' | 'directory' | 'secretReference';
  description: string;
  required: boolean;
  defaultValue: unknown;
  options: string[];
  validation: { min?: number | null; max?: number | null; pattern?: string | null };
}
export interface Trigger {
  id: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
  parameters: Record<string, unknown>;
}
export interface TriggerDefinition {
  kind: string;
  name: string;
  defaults: Record<string, unknown>;
  description: string;
}
export interface TriggerEvent {
  sceneId: string;
  triggerId: string;
  kind: string;
  message: string;
  at: string;
}
export interface CanvasAnnotation {
  id: string;
  kind: 'group' | 'comment';
  text: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  nodeIds: string[];
}
export interface Scene {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  version: number;
  isDefault: boolean;
  allowCommandsAtStartup: boolean;
  sensitiveActionPolicy?: 'askEveryTime' | 'allowForThisScene' | 'blockAtStartup';
  workflow: { nodes: WorkflowNode[]; edges: Edge[]; annotations?: CanvasAnnotation[] };
  parameters?: Parameter[];
  triggers?: Trigger[];
  concurrentRunPolicy?: 'ignore' | 'restart' | 'queue';
  maxParallel?: number;
  createdAt: string;
  updatedAt: string;
}
export type ReadyDetection =
  { kind: 'process'; processName: string } | { kind: 'port'; host: string; port: number };
export interface ApplicationProfile {
  schemaVersion: number;
  id: string;
  displayName: string;
  windows: {
    executable: string;
    processName: string;
    runAsAdministrator?: boolean;
    usePreauthorizedTask?: boolean;
  };
  macos: { appPath: string; bundleId: string; processName: string };
  launchArguments: string[];
  readyDetection: ReadyDetection | null;
}
export interface NodeRun {
  output?: unknown;
  outlet?: string | null;
  reusedFrom?: string | null;
  nodeId: string;
  name: string;
  status: NodeStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  retryCount: number;
  message: string;
  stdout: string;
  stderr: string;
  error: string | null;
}
export interface Run {
  parameterSnapshot?: Record<string, unknown>;
  subflowSnapshots?: Record<string, Scene>;
  parentRunId?: string | null;
  parentNodeId?: string | null;
  resumedFrom?: string | null;
  id: string;
  sceneId: string;
  sceneName: string;
  sceneVersion: number;
  sceneSnapshot: Scene;
  status: RunStatus;
  source: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  revision: number;
  nodeRuns: NodeRun[];
  error: string | null;
}
export interface Settings {
  schemaVersion: number;
  theme: 'system' | 'light' | 'dark';
  startupDelaySeconds: number;
  notifications: boolean;
  retentionDays: number;
}
export interface FieldDefinition {
  key: string;
  label: string;
  kind: string;
  required: boolean;
  options: string[];
  hint: string;
}
export interface NodeDefinition {
  nodeType: string;
  name: string;
  description: string;
  category: string;
  fields: FieldDefinition[];
  defaults: Record<string, unknown>;
  waiting: boolean;
}
export interface ValidationIssue {
  nodeId: string | null;
  message: string;
}
export interface Bootstrap {
  triggerDefinitions: TriggerDefinition[];
  triggerStatuses: TriggerEvent[];
  scenes: Scene[];
  profiles: ApplicationProfile[];
  runs: Run[];
  settings: Settings;
  definitions: NodeDefinition[];
  os: 'windows' | 'macos';
  autostart: boolean;
  version: string;
}
export interface RunEvent {
  kind: string;
  run: Run;
}
export type Page =
  | 'home'
  | 'scenes'
  | 'editor'
  | 'runs'
  | 'applications'
  | 'settings'
  | 'workspaces'
  | 'permissions'
  | 'transfer';
