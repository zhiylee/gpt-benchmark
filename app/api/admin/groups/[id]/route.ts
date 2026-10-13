import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { db, getRawGroup } from "@/lib/db";
import { REASONING_LEVELS, type ReasoningLevel } from "@/lib/settings";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const { id } = await params;
  const current = getRawGroup(id);
  if (!current) return NextResponse.json({ error: "分组不存在" }, { status: 404 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = String(body?.name || "").trim();
  const model = String(body?.model || "").trim();
  const baseUrl = String(body?.baseUrl || "").trim();
  if (!name || !model || !baseUrl) return NextResponse.json({ error: "分组名称、模型和 Base URL 为必填项" }, { status: 400 });

  const submittedKey = String(body?.apiKey || "").trim();
  const effort = body?.reasoningEffort === undefined ? current.reasoning_effort : body.reasoningEffort;
  if (effort !== null && !REASONING_LEVELS.includes(effort as ReasoningLevel)) return NextResponse.json({ error: "思考强度无效" }, { status: 400 });
  db.prepare(`
    UPDATE groups SET name = ?, model = ?, multiplier = ?, base_url = ?, api_key = ?, interval_minutes = ?,
      idle_interval_minutes = ?, streaming = ?, enabled = ?, is_public = ?, reasoning_effort = ?, updated_at = ? WHERE id = ?
  `).run(
    name,
    model,
    Math.max(0.01, Number(body?.multiplier) || 1),
    baseUrl.replace(/\/+$/, ""),
    submittedKey || current.api_key,
    Math.max(1, Number(body?.intervalMinutes) || 60),
    Math.max(1, Number(body?.idleIntervalMinutes) || 180),
    body?.streaming ? 1 : 0,
    body?.enabled ? 1 : 0,
    typeof body?.isPublic === "boolean" ? Number(body.isPublic) : current.is_public,
    effort,
    new Date().toISOString(),
    id,
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const { id } = await params;
  if (db.prepare("SELECT 1 FROM jobs WHERE group_id = ? AND status IN ('queued', 'running')").get(id)) {
    return NextResponse.json({ error: "请先取消该分组的检测任务，再删除分组" }, { status: 409 });
  }
  const result = db.prepare("DELETE FROM groups WHERE id = ?").run(id);
  if (!result.changes) return NextResponse.json({ error: "分组不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
