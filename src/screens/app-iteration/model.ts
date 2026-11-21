export type IterationStatus = "draft" | "spec" | "implementing" | "verifying" | "review" | "approved" | "merging" | "merged" | "abandoned" | "anomaly";
export type IterationAction = "create" | "settings" | "sync" | "draft" | "confirm" | "implement" | "validate" | "approve" | "merge" | "abandon" | "preview" | "stopPreview" | "stop" | "feedback" | "revert" | "update" | "restore" | "decideAgentApproval" | "trial";
export interface IterationVerification {
  id: number;
  sha: string;
  startedAt: string;
  result: "pending" | "success" | "failure" | "interrupted";
  steps: { name: string; command: string; durationMs: number; exitCode: number; logFile: string }[];
  screenshots: string[];
  error?: string;
}
export interface IterationTrial {
  sha: string;
  at: string;
  passed: boolean;
  items: { criterion: string; result: "pass" | "fail"; note: string }[];
  note: string;
  preview: { startedAt: string; realData: boolean };
}
export interface IterationTask {
  id: string;
  number?: number;
  title: string;
  description: string;
  criteria: string;
  status: IterationStatus;
  sha: string | null;
  base: string | null;
  branch?: string;
  issueUrl?: string;
  prUrl?: string;
  error?: string;
  pendingSync: number;
  freeze?: { hash: string; sha: string; at: string } | null;
  approval?: { sha: string; record: number; trial?: string } | null;
  trialItems: string[];
  previews?: { sha: string; startedAt: string; endedAt?: string; realData: boolean }[];
  trial?: IterationTrial | null;
  trials?: IterationTrial[];
  mergedSha?: string;
  revertTarget?: string;
  events?: { kind: "agent" | "verify"; text: string; at: string }[];
  attachments?: ChatAttachment[];
  pendingFeedback?: string[];
  messages: { role: "user" | "agent"; text: string; at: string; attachments?: ChatAttachment[] }[];
  verifications: IterationVerification[];
}
export interface IterationSnapshot {
  repository: { path: string; repository: string; head?: string; dirty?: boolean; main: string; mainHead?: string; updateMode?: "source" | "other" | "packaged"; commits?: { sha: string; title: string }[]; error?: string } | null;
  localUpdate?: { path: string; previous: string; target: string; backup: string } | null;
  updatePending?: boolean;
  updateError?: string | null;
  tasks: IterationTask[];
  retryLimit: number;
  runtime: "app-server" | "sdk";
  access?: "full" | "restricted";
  approvals: { id: string; taskId: string; kind: "command" | "patch" | "permissions"; title: string; detail: string }[];
  stream: { taskId: string; text: string } | null;
  active: IterationAction | null;
  preview: { id: string; sha: string } | null;
}
import type { ChatAttachment } from "../../types";

