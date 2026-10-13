import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE, verifyAdminKey } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { key?: string };
  if (!body.key || !verifyAdminKey(body.key)) {
    return NextResponse.json({ error: "访问密钥不正确" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
