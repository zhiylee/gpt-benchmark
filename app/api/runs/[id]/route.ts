import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { getRunDetail } from "@/lib/db";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const run = getRunDetail((await params).id, isAdminRequest(request));
  return NextResponse.json(run ?? { error: "记录不存在" }, {
    status: run ? 200 : 404, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
}
