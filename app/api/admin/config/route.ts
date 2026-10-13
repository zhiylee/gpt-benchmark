import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { getAdminData, getSettings, saveSettings } from "@/lib/db";
import { pumpJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  return NextResponse.json(getAdminData(), { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!Number.isInteger(body?.timeoutSeconds) || body.timeoutSeconds < 1 || body.timeoutSeconds > 86400) {
    return NextResponse.json({ error: "超时时间必须为 1–86400 秒的整数" }, { status: 400 });
  }
  const maxConcurrentGroups = body.maxConcurrentGroups ?? getSettings().maxConcurrentGroups;
  if (!Number.isInteger(maxConcurrentGroups) || maxConcurrentGroups < 1 || maxConcurrentGroups > 16) {
    return NextResponse.json({ error: "并发分组数必须为 1–16 的整数" }, { status: 400 });
  }
  saveSettings({ timeoutSeconds: body.timeoutSeconds, maxConcurrentGroups });
  pumpJobs();
  return NextResponse.json(getAdminData(), { headers: { "Cache-Control": "no-store" } });
}
