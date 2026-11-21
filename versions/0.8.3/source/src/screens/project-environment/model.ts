export type EnvironmentScenario = "ready" | "unconfigured" | "running" | "conda-missing" | "error";
export type EnvironmentOperation = "create" | "bind" | "check" | "plan" | "update" | null;

export interface ProjectPythonEnvironment {
  name: string;
  prefix: string;
  condaExecutable: string;
  pythonVersion: string;
  revision: number;
  checkedAt: string;
  diskUsage: string;
  architecture?: string;
}

export interface EnvironmentPackage {
  name: string;
  version: string;
  source: "conda" | "pip";
  purpose: string;
}

export interface EnvironmentExperiment {
  id: string;
  title: string;
  kind: "论文复现" | "自主实验";
  status: "idle" | "running" | "done" | "waiting" | "needs_input";
}

export interface EnvironmentChange {
  name: string;
  before: string | null;
  after: string;
}

export interface EnvironmentUpdateRequest {
  id?: string;
  manager?: "conda" | "pip";
  note?: string;
  status?: "pending" | "installing" | "failed" | "approved" | "rejected";
  plan?: { fingerprint: string; changes: EnvironmentChange[] };
  experiment: string;
  changes: EnvironmentChange[];
}

export interface EnvironmentHistory {
  id: string;
  title: string;
  detail: string;
  time: string;
  revision: number;
}

export interface EnvironmentCreateInput {
  name: string;
  pythonVersion: string;
  condaExecutable: string;
}

export interface EnvironmentBindInput {
  name: string;
  prefix: string;
  condaExecutable?: string;
}

export interface ProjectEnvironmentSnapshot {
  projectId: string;
  projectTitle: string;
  suggestedName: string;
  prefix: string;
  condaExecutable: string;
  condaDetected: boolean;
  environment: ProjectPythonEnvironment | null;
  operation: EnvironmentOperation;
  progress: number;
  error: string;
  packages: EnvironmentPackage[];
  experiments: EnvironmentExperiment[];
  request: EnvironmentUpdateRequest | null;
  history: EnvironmentHistory[];
  locked: boolean;
  availableEnvironments: Array<{ name: string; prefix: string; base: boolean }>;
}

export interface ProjectEnvironmentController {
  demo?: boolean;
  locked?: boolean;
  availableEnvironments?: Array<{ name: string; prefix: string; base: boolean }>;
  projectTitle: string;
  suggestedName: string;
  prefix: string;
  condaExecutable: string;
  condaDetected: boolean;
  environment: ProjectPythonEnvironment | null;
  operation: EnvironmentOperation;
  progress: number;
  error: string;
  packages: EnvironmentPackage[];
  experiments: EnvironmentExperiment[];
  request: EnvironmentUpdateRequest | null;
  history: EnvironmentHistory[];
  onCreate: (input: EnvironmentCreateInput) => Promise<void>;
  onBind: (input: EnvironmentBindInput) => Promise<void>;
  onCheck: () => Promise<void>;
  onPrepareUpdate?: () => Promise<void>;
  onUpdate: () => Promise<void>;
  onRejectUpdate: () => void;
  onNotice: (text: string) => void;
}
