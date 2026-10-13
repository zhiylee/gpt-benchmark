import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { getDashboardData } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  return NextResponse.json(getDashboardData(isAdminRequest(request), {
    limit: Number(params.get("limit")), questionId: params.get("questionId") || undefined,
    model: params.get("model") || undefined, effort: params.get("effort") || undefined,
    errorsOnly: params.get("errorsOnly") === "true",
  }), {
    headers: { "Cache-Control": "private, no-store", "Vary": "Cookie" },
  });
}
