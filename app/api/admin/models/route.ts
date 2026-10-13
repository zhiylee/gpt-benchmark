import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { getRawGroup } from "@/lib/db";
import { createOpenAIClient } from "@/lib/openai-client";

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const current = body?.groupId ? getRawGroup(String(body.groupId)) : undefined;
  const baseUrl = String(body?.baseUrl || current?.base_url || "").trim().replace(/\/+$/, "");
  const apiKey = String(body?.apiKey || "").trim() || current?.api_key || "";
  if (!baseUrl || !apiKey) return NextResponse.json({ error: "请先填写 Base URL 和 API Key" }, { status: 400 });

  try {
    const payload = await createOpenAIClient(baseUrl, apiKey, 15_000).models.list();
    const models = [...new Set(payload.data
      .map((item) => item.id.trim())
      .filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (!models.length) return NextResponse.json({ error: "接口未返回可用模型" }, { status: 502 });
    return NextResponse.json({ models });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "读取模型超时（15 秒）"
      : error instanceof Error ? error.message : "读取模型失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
