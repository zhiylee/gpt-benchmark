import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/db";
import { REASONING_LEVELS, type ReasoningLevel } from "@/lib/settings";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = String(body?.name || "").trim();
  const prompt = String(body?.prompt || "").trim();
  const passPattern = String(body?.passPattern || "").trim();
  if (!name || !prompt || !passPattern) return NextResponse.json({ error: "名称、Prompt 和通过条件为必填项" }, { status: 400 });
  try { new RegExp(passPattern, "i"); } catch { return NextResponse.json({ error: "通过条件不是有效的正则表达式" }, { status: 400 }); }
  const effort = String(body?.reasoningEffort) as ReasoningLevel;
  const current = db.prepare("SELECT reasoning_effort FROM questions WHERE id = ?").get(id) as { reasoning_effort: string } | undefined;
  if (!current) return NextResponse.json({ error: "检测题不存在" }, { status: 404 });
  if (!REASONING_LEVELS.includes(effort)) {
    return NextResponse.json({ error: "请选择有效的思考强度" }, { status: 400 });
  }

  const result = db.prepare(`
    UPDATE questions SET name = ?, prompt = ?, reasoning_effort = ?, pass_pattern = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(name, prompt, effort, passPattern, body?.enabled ? 1 : 0, new Date().toISOString(), id);
  if (!result.changes) return NextResponse.json({ error: "检测题不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const { id } = await params;
  const active = db.prepare("SELECT question_ids FROM jobs WHERE status IN ('queued', 'running')").all() as Array<{ question_ids: string }>;
  if (active.some(job => (JSON.parse(job.question_ids) as string[]).includes(id))) {
    return NextResponse.json({ error: "该检测题有待执行任务，请先取消任务再删除" }, { status: 409 });
  }
  const result = db.prepare("DELETE FROM questions WHERE id = ?").run(id);
  if (!result.changes) return NextResponse.json({ error: "检测题不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
