import { randomUUID } from "node:crypto";
import { db, getEnabledQuestions, getRawGroup, getSettings } from "@/lib/db";
import { executeGroup } from "@/lib/runner";
import type { Job } from "@/lib/types";

const globalWorker = globalThis as unknown as { benchmarkWorker?: { controllers: Map<string, AbortController>; pumping: boolean } };
function state() {
  if (!globalWorker.benchmarkWorker) {
    // Deployment uses one Node process. Surviving rows belong to its previous lifetime.
    db.transaction(() => {
      db.prepare("UPDATE jobs SET status = 'interrupted', error = '服务重启，任务已中断', finished_at = ? WHERE status IN ('queued', 'running')").run(new Date().toISOString());
      db.prepare("UPDATE runs SET status = 'interrupted', error = '服务重启，检测已中断' WHERE status = 'running'").run();
    })();
    globalWorker.benchmarkWorker = { controllers: new Map(), pumping: false };
  }
  return globalWorker.benchmarkWorker;
}
const jobSelect = `SELECT j.id, j.group_id AS groupId, g.name AS groupName, j.status, j.total, j.completed,
  j.current_question AS currentQuestion, j.error, j.created_at AS createdAt FROM jobs j JOIN groups g ON g.id = j.group_id`;
export function listJobs(): Job[] {
  state();
  return db.prepare(`${jobSelect} WHERE j.status IN ('queued', 'running') OR j.id IN
    (SELECT id FROM jobs WHERE status NOT IN ('queued', 'running') ORDER BY created_at DESC LIMIT 12)
    ORDER BY CASE WHEN j.status IN ('queued', 'running') THEN 0 ELSE 1 END, j.created_at DESC`).all() as Job[];
}
export function enqueueGroups(groupIds: string[]): Job[] {
  state();
  const questions = getEnabledQuestions();
  if (!questions.length) throw new Error("没有启用的检测题");
  const ids = db.transaction(() => groupIds.map(groupId => {
    const group = getRawGroup(groupId);
    if (!group?.api_key) throw new Error("分组不存在或未配置 API Key");
    const existing = db.prepare("SELECT id FROM jobs WHERE group_id = ? AND status IN ('queued', 'running')").get(groupId) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    db.prepare("INSERT INTO jobs (id, group_id, status, question_ids, total, created_at) VALUES (?, ?, 'queued', ?, ?, ?)")
      .run(id, groupId, JSON.stringify(questions.map(q => q.id)), questions.length, new Date().toISOString());
    return id;
  }))();
  const jobs = ids.map(id => db.prepare(`${jobSelect} WHERE j.id = ?`).get(id) as Job);
  queueMicrotask(pumpJobs);
  return jobs;
}
export function pumpJobs() {
  const worker = state();
  if (worker.pumping) return;
  worker.pumping = true;
  try {
    while (worker.controllers.size < getSettings().maxConcurrentGroups) {
      const next = db.prepare("SELECT id, group_id, question_ids FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1").get() as { id: string; group_id: string; question_ids: string } | undefined;
      if (!next) break;
      const controller = new AbortController();
      worker.controllers.set(next.id, controller);
      db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(next.id);
      void executeGroup(next.group_id, JSON.parse(next.question_ids), controller.signal, (completed, question) => {
        db.prepare("UPDATE jobs SET completed = ?, current_question = ? WHERE id = ?").run(completed, question, next.id);
      }).then(() => {
        db.prepare("UPDATE jobs SET status = ?, current_question = NULL, finished_at = ? WHERE id = ?")
          .run(controller.signal.aborted ? "cancelled" : "completed", new Date().toISOString(), next.id);
      }).catch(error => {
        db.prepare("UPDATE jobs SET status = ?, error = ?, current_question = NULL, finished_at = ? WHERE id = ?")
          .run(controller.signal.aborted ? "cancelled" : "error", error instanceof Error ? error.message : "执行失败", new Date().toISOString(), next.id);
      }).finally(() => { worker.controllers.delete(next.id); pumpJobs(); });
    }
  } finally { worker.pumping = false; }
}
export function cancelJob(id: string) {
  const worker = state();
  const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string } | undefined;
  if (!job) return false;
  if (job.status === "queued") db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  worker.controllers.get(id)?.abort();
  return true;
}
