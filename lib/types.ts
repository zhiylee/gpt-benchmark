import type { BenchmarkSettings, ReasoningLevel } from "@/lib/settings";

export type RunStatus = "passed" | "failed" | "error" | "running" | "incomplete" | "cancelled" | "interrupted";

export interface Group {
  id: string;
  name: string;
  model: string;
  multiplier: number;
  baseUrl: string;
  apiKeyConfigured?: boolean;
  intervalMinutes: number;
  idleIntervalMinutes: number;
  streaming: boolean;
  isPublic: boolean;
  reasoningEffort: ReasoningLevel | null;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Question {
  id: string;
  name: string;
  prompt: string;
  reasoningEffort: ReasoningLevel;
  passPattern: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Run {
  id: string;
  groupId: string;
  groupName: string;
  model: string;
  questionId: string;
  questionName: string;
  status: RunStatus;
  input: string;
  output: string;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  reasoningSummary: string | null;
  reasoningEffort: string;
  streaming: boolean;
  firstTokenMs: number | null;
  latencyMs: number | null;
  error: string | null;
  isTimeout: boolean;
  isDemo: boolean;
  createdAt: string;
}

export interface DashboardData {
  isAdmin: boolean;
  groups: Array<Group & RunStats & { runs: RunSummary[] }>;
  recentRuns: RunSummary[];
  questions: Array<{ id: string; name: string }>;
  models: string[];
  efforts: string[];
  summary: RunStats & {
    activeGroups: number;
    checksToday: number;
    lastCheckedAt: string | null;
  };
}

export type RunSummary = Omit<Run, "input" | "output" | "reasoningSummary" | "error">;
export interface RunStats {
  passRate: number | null;
  availability: number | null;
  validSamples: number;
  attemptedSamples: number;
}
export interface DashboardFilters {
  limit?: number;
  questionId?: string;
  model?: string;
  effort?: string;
  errorsOnly?: boolean;
}
export interface Job {
  id: string;
  groupId: string;
  groupName: string;
  status: "queued" | "running" | "completed" | "cancelled" | "interrupted" | "error";
  total: number;
  completed: number;
  currentQuestion: string | null;
  error: string | null;
  createdAt: string;
}

export interface AdminData {
  settings: BenchmarkSettings;
  groups: Group[];
  questions: Question[];
}
