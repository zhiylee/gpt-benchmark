export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];

export interface BenchmarkSettings {
  timeoutSeconds: number;
  maxConcurrentGroups: number;
}

export const DEFAULT_SETTINGS: BenchmarkSettings = {
  timeoutSeconds: 120,
  maxConcurrentGroups: 3,
};

export const MATRIX_RUN_LIMIT = 36;
