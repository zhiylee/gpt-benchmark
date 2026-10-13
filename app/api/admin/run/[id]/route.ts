import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { cancelJob } from "@/lib/jobs";
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  return cancelJob((await params).id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "任务不存在" }, { status: 404 });
}
