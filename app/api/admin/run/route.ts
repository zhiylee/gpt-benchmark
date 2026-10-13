import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { getAllRunnableGroups } from "@/lib/db";
import { enqueueGroups, listJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  return NextResponse.json({ jobs: listJobs() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { groupId?: string };
  try {
    const ids = body?.groupId ? [body.groupId] : getAllRunnableGroups().map(g => g.id);
    if (!ids.length) throw new Error("没有可运行的分组");
    return NextResponse.json({ jobs: enqueueGroups(ids) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "执行失败" }, { status: 400 });
  }
}
