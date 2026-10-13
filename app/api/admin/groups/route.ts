import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/db";
import { REASONING_LEVELS, type ReasoningLevel } from "@/lib/settings";

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = String(body?.name || "").trim();
  const model = String(body?.model || "").trim();
  const baseUrl = String(body?.baseUrl || "").trim();
  if (!name || !model || !baseUrl) return NextResponse.json({ error: "分组名称、模型和 Base URL 为必填项" }, { status: 400 });

  const id = randomUUID();
  const effort = body?.reasoningEffort ?? null;
  if (effort !== null && !REASONING_LEVELS.includes(effort as ReasoningLevel)) return NextResponse.json({ error: "思考强度无效" }, { status: 400 });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO groups (id, name, model, multiplier, base_url, api_key, interval_minutes, idle_interval_minutes, streaming, enabled, is_public, reasoning_effort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    model,
    Math.max(0.01, Number(body?.multiplier) || 1),
    baseUrl.replace(/\/+$/, ""),
    String(body?.apiKey || "").trim(),
    Math.max(1, Number(body?.intervalMinutes) || 60),
    Math.max(1, Number(body?.idleIntervalMinutes) || 180),
    body?.streaming ? 1 : 0,
    body?.enabled ? 1 : 0,
    body?.isPublic === false ? 0 : 1,
    effort,
    now,
    now,
  );
  return NextResponse.json({ id }, { status: 201 });
}
