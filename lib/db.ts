import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdminData, DashboardData, DashboardFilters, Group, Question, Run, RunStats, RunSummary } from "@/lib/types";
import { shanghaiDayStart } from "@/lib/time";
import { DEFAULT_SETTINGS, MATRIX_RUN_LIMIT, type BenchmarkSettings } from "@/lib/settings";

const databasePath = path.resolve(process.cwd(), process.env.DATABASE_PATH || "data/benchmark.db");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const globalForDb = globalThis as unknown as { benchmarkDb?: Database.Database };
export const db = globalForDb.benchmarkDb ?? new Database(databasePath);

if (process.env.NODE_ENV !== "production") globalForDb.benchmarkDb = db;

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    question_ids TEXT NOT NULL,
    total INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    current_question TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_group ON jobs(group_id) WHERE status IN ('queued', 'running');
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    multiplier REAL NOT NULL DEFAULT 1,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    interval_minutes INTEGER NOT NULL DEFAULT 60,
    idle_interval_minutes INTEGER NOT NULL DEFAULT 180,
    streaming INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL DEFAULT 'medium',
    pass_pattern TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    reasoning_summary TEXT,
    reasoning_effort TEXT NOT NULL,
    streaming INTEGER NOT NULL DEFAULT 0,
    first_token_ms INTEGER,
    latency_ms INTEGER,
    error TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_runs_group_created ON runs(group_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
`);

function ensureColumn(table: "groups" | "runs", column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

ensureColumn("groups", "model", "model TEXT NOT NULL DEFAULT ''");
ensureColumn("groups", "streaming", "streaming INTEGER NOT NULL DEFAULT 1");
ensureColumn("groups", "is_public", "is_public INTEGER NOT NULL DEFAULT 1");
ensureColumn("groups", "reasoning_effort", "reasoning_effort TEXT");
ensureColumn("runs", "model", "model TEXT NOT NULL DEFAULT ''");
ensureColumn("runs", "streaming", "streaming INTEGER NOT NULL DEFAULT 0");
ensureColumn("runs", "first_token_ms", "first_token_ms INTEGER");
ensureColumn("runs", "reasoning_summary", "reasoning_summary TEXT");
db.prepare("UPDATE groups SET model = name WHERE model = ''").run();
db.prepare("UPDATE runs SET model = COALESCE((SELECT model FROM groups WHERE groups.id = runs.group_id), '') WHERE model = ''").run();
db.prepare("UPDATE runs SET streaming = 1, first_token_ms = CAST(latency_ms * 0.18 AS INTEGER) WHERE is_demo = 1 AND first_token_ms IS NULL").run();

function readDefaultQuestion() {
  const fallback = { prompt: "请回答检测题。", passPattern: ".+" };
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "question.md"), "utf8").trim();
    const [prompt, rule = ""] = raw.split(/\n---\n/);
    const match = rule.match(/答案正则匹配\s+(.+)/);
    return { prompt: prompt.trim(), passPattern: match?.[1]?.trim() || ".+" };
  } catch {
    return fallback;
  }
}

function seedDatabase() {
  const groupCount = (db.prepare("SELECT COUNT(*) AS count FROM groups").get() as { count: number }).count;
  const questionCount = (db.prepare("SELECT COUNT(*) AS count FROM questions").get() as { count: number }).count;
  const now = new Date().toISOString();

  if (questionCount === 0) {
    const question = readDefaultQuestion();
    db.prepare(`
      INSERT INTO questions (id, name, prompt, reasoning_effort, pass_pattern, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run("default-question", "糖果逻辑题", question.prompt, "high", question.passPattern, now, now);
  }

  if (groupCount === 0) {
    const insertGroup = db.prepare(`
      INSERT INTO groups (id, name, model, multiplier, base_url, api_key, interval_minutes, idle_interval_minutes, streaming, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, 1, 0, ?, ?)
    `);
    const groups = [
      ["demo-gpt-5", "旗舰模型", "gpt-5", 1, "https://api.openai.com/v1", 30, 120],
      ["demo-gpt-41", "通用模型", "gpt-4.1", 0.8, "https://api.openai.com/v1", 60, 180],
      ["demo-o3", "推理模型", "o3-mini", 1.2, "https://api.openai.com/v1", 45, 180],
    ] as const;
    const transaction = db.transaction(() => {
      for (const group of groups) insertGroup.run(...group, now, now);
      seedDemoRuns();
    });
    transaction();
  }
}

function seedDemoRuns() {
  const question = readDefaultQuestion();
  const insert = db.prepare(`
    INSERT INTO runs (
      id, group_id, question_id, status, input, output, input_tokens, output_tokens,
      reasoning_tokens, reasoning_effort, model, streaming, first_token_ms, latency_ms, error, is_demo, created_at
    ) VALUES (?, ?, 'default-question', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, 1, ?)
  `);
  const groupPatterns = [
    ["demo-gpt-5", [1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1]],
    ["demo-gpt-41", [1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1]],
    ["demo-o3", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]],
  ] as const;

  groupPatterns.forEach(([groupId, pattern], groupIndex) => {
    pattern.forEach((passed, index) => {
      const createdAt = new Date(Date.now() - (index * 37 + groupIndex * 9) * 60_000).toISOString();
      insert.run(
        randomUUID(),
        groupId,
        passed ? "passed" : "failed",
        question.prompt,
        passed ? "经过分析，至少需要取出 21 个糖果。" : "答案是 20 个。",
        172 + groupIndex * 4,
        368 + index * 7,
        241 + index * 5,
        "high",
        groupId === "demo-gpt-5" ? "gpt-5" : groupId === "demo-gpt-41" ? "gpt-4.1" : "o3-mini",
        290 + index * 11 + groupIndex * 40,
        1840 + index * 83 + groupIndex * 260,
        createdAt,
      );
    });
  });
}

seedDatabase();

type GroupRow = {
  id: string;
  name: string;
  model: string;
  multiplier: number;
  base_url: string;
  api_key?: string;
  interval_minutes: number;
  idle_interval_minutes: number;
  streaming: number;
  enabled: number;
  is_public: number;
  reasoning_effort: Question["reasoningEffort"] | null;
  created_at: string;
  updated_at: string;
};

type QuestionRow = {
  id: string;
  name: string;
  prompt: string;
  reasoning_effort: Question["reasoningEffort"];
  pass_pattern: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  group_id: string;
  group_name: string;
  model: string;
  question_id: string;
  question_name: string;
  status: Run["status"];
  input: string;
  output: string;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  reasoning_summary: string | null;
  reasoning_effort: string;
  streaming: number;
  first_token_ms: number | null;
  latency_ms: number | null;
  error: string | null;
  is_timeout?: number;
  is_demo: number;
  created_at: string;
};

export function mapGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    multiplier: row.multiplier,
    baseUrl: row.base_url,
    apiKeyConfigured: Boolean(row.api_key),
    intervalMinutes: row.interval_minutes,
    idleIntervalMinutes: row.idle_interval_minutes,
    streaming: Boolean(row.streaming),
    isPublic: Boolean(row.is_public),
    reasoningEffort: row.reasoning_effort,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    reasoningEffort: row.reasoning_effort,
    passPattern: row.pass_pattern,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    model: row.model,
    questionId: row.question_id,
    questionName: row.question_name,
    status: row.status,
    input: row.input,
    output: row.output,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    reasoningSummary: row.reasoning_summary,
    reasoningEffort: row.reasoning_effort,
    streaming: Boolean(row.streaming),
    firstTokenMs: row.first_token_ms,
    latencyMs: row.latency_ms,
    error: row.error,
    isTimeout: Boolean(row.is_timeout) || Boolean(row.error?.startsWith("请求超时")),
    isDemo: Boolean(row.is_demo),
    createdAt: row.created_at,
  };
}

const runSelect = `
  SELECT r.*, g.name AS group_name, q.name AS question_name
  FROM runs r
  JOIN groups g ON g.id = r.group_id
  JOIN questions q ON q.id = r.question_id
`;

const summarySelect = runSelect.replace("r.*", `r.id, r.group_id, r.question_id, r.status, r.model,
  r.input_tokens, r.output_tokens, r.reasoning_tokens, r.reasoning_effort, r.streaming,
  r.first_token_ms, r.latency_ms, r.is_demo, r.created_at, CASE WHEN r.error LIKE '请求超时%' THEN 1 ELSE 0 END AS is_timeout`);

function mapRunSummary(row: RunRow): RunSummary {
  const { input, output, reasoningSummary, error, ...summary } = mapRun(row);
  return summary;
}

export function calculateStats(statuses: Array<{ status: Run["status"] }>): RunStats {
  const validSamples = statuses.filter(r => r.status === "passed" || r.status === "failed").length;
  const attemptedSamples = statuses.filter(r => ["passed", "failed", "error", "incomplete"].includes(r.status)).length;
  const passed = statuses.filter(r => r.status === "passed").length;
  return {
    passRate: validSamples ? passed * 100 / validSamples : null,
    availability: attemptedSamples ? validSamples * 100 / attemptedSamples : null,
    validSamples, attemptedSamples,
  };
}

export function getRunDetail(id: string, isAdmin = false): Run | null {
  const row = db.prepare(`${runSelect} WHERE r.id = ? ${isAdmin ? "" : "AND g.is_public = 1"}`).get(id) as RunRow | undefined;
  return row ? mapRun(row) : null;
}

export function getDashboardData(isAdmin = false, filters: DashboardFilters = {}): DashboardData {
  const limit = [24, 36, 48, 96].includes(filters.limit || 0) ? filters.limit! : MATRIX_RUN_LIMIT;
  const visible = isAdmin ? "1 = 1" : "g.is_public = 1";
  const groupRows = db.prepare(`SELECT g.* FROM groups g WHERE ${visible} ORDER BY created_at ASC`).all() as GroupRow[];
  const conditions = [visible];
  const values: string[] = [];
  for (const [column, value] of [["r.question_id", filters.questionId], ["r.model", filters.model], ["r.reasoning_effort", filters.effort]]) {
    if (value) { conditions.push(`${column} = ?`); values.push(value); }
  }
  // Statistics retain all statuses; the error filter only changes the displayed records.
  const where = conditions.join(" AND ");
  const errorWhere = filters.errorsOnly ? " AND r.status IN ('failed', 'error', 'incomplete', 'interrupted')" : "";
  let activeGroups = 0;
  const groups = groupRows.map(row => {
    const sample = db.prepare(`${summarySelect} WHERE ${where} AND r.group_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`).all(...values, row.id, limit) as RunRow[];
    if (row.enabled && (!(filters.model || filters.effort || filters.questionId) || sample.length > 0)) activeGroups += 1;
    const runs = filters.errorsOnly
      ? db.prepare(`${summarySelect} WHERE ${where} AND r.group_id = ? ${errorWhere} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`).all(...values, row.id, limit) as RunRow[]
      : sample;
    return { ...mapGroup(row), runs: runs.map(mapRunSummary), ...calculateStats(sample) };
  }).filter(group => {
    if (filters.errorsOnly) return group.runs.length > 0;
    if (filters.model || filters.effort || filters.questionId) return group.runs.length > 0;
    return true;
  });
  const todayRuns = db.prepare(`SELECT r.status FROM runs r JOIN groups g ON g.id = r.group_id WHERE ${where} AND r.created_at >= ?`).all(...values, shanghaiDayStart()) as Array<{ status: Run["status"] }>;
  const recentRuns = (db.prepare(`${summarySelect} WHERE ${where} ${errorWhere} ORDER BY r.created_at DESC, r.rowid DESC LIMIT 8`).all(...values) as RunRow[]).map(mapRunSummary);
  const questions = db.prepare(`SELECT DISTINCT q.id, q.name FROM questions q JOIN runs r ON r.question_id = q.id JOIN groups g ON g.id = r.group_id WHERE ${visible} ORDER BY q.name`).all() as Array<{ id: string; name: string }>;
  const dimensions = db.prepare(`SELECT DISTINCT r.model, r.reasoning_effort FROM runs r JOIN groups g ON g.id = r.group_id WHERE ${visible}`).all() as Array<{ model: string; reasoning_effort: string }>;
  return {
    isAdmin, groups, recentRuns, questions,
    models: [...new Set([...groupRows.map(g => g.model), ...dimensions.map(r => r.model)])].sort(),
    efforts: [...new Set(dimensions.map(r => r.reasoning_effort))].sort(),
    summary: { ...calculateStats(todayRuns), activeGroups,
      checksToday: todayRuns.length, lastCheckedAt: recentRuns[0]?.createdAt || null },
  };
}

export function getAdminData(): AdminData {
  const groups = (db.prepare("SELECT * FROM groups ORDER BY created_at ASC").all() as GroupRow[]).map(mapGroup);
  const questions = (db.prepare("SELECT * FROM questions ORDER BY created_at ASC").all() as QuestionRow[]).map(mapQuestion);
  return { groups, questions, settings: getSettings() };
}

export function getSettings(): BenchmarkSettings {
  const row = db.prepare("SELECT value FROM settings WHERE id = 1").get() as { value: string } | undefined;
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
}

export function saveSettings(settings: BenchmarkSettings) {
  db.prepare("INSERT INTO settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings));
}

export function getRawGroup(id: string) {
  return db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
}

export function getEnabledQuestions() {
  return db.prepare("SELECT * FROM questions WHERE enabled = 1 ORDER BY created_at ASC").all() as QuestionRow[];
}

export function getAllRunnableGroups() {
  return db.prepare("SELECT * FROM groups WHERE enabled = 1 AND api_key != '' ORDER BY created_at ASC").all() as GroupRow[];
}

export function getLastRealRunAt(groupId: string) {
  const row = db.prepare("SELECT created_at FROM runs WHERE group_id = ? AND is_demo = 0 ORDER BY created_at DESC LIMIT 1").get(groupId) as { created_at: string } | undefined;
  return row?.created_at || null;
}
