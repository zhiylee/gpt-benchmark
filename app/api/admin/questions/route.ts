import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/db";
import { REASONING_LEVELS, type ReasoningLevel } from "@/lib/settings";

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = String(body?.name || "").trim();
  const prompt = String(body?.prompt || "").trim();
  const passPattern = String(body?.passPattern || "").trim();
  if (!name || !prompt || !passPattern) return NextResponse.json({ error: "名称、Prompt 和通过条件为必填项" }, { status: 400 });
  try { new RegExp(passPattern, "i"); } catch { return NextResponse.json({ error: "通过条件不是有效的正则表达式" }, { status: 400 }); }

  const effort = String(body?.reasoningEffort) as ReasoningLevel;
  if (!REASONING_LEVELS.includes(effort)) return NextResponse.json({ error: "请选择有效的思考强度" }, { status: 400 });
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO questions (id, name, prompt, reasoning_effort, pass_pattern, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, prompt, effort, passPattern, body?.enabled ? 1 : 0, now, now);
  return NextResponse.json({ id }, { status: 201 });
}
