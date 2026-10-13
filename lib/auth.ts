import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const SESSION_COOKIE = "benchmark_admin";

function adminKey() {
  return process.env.ADMIN_KEY || "admin";
}

export function createSessionToken() {
  return createHash("sha256").update(`gpt-benchmark:${adminKey()}`).digest("hex");
}

export function verifyAdminKey(value: string) {
  const expected = Buffer.from(createHash("sha256").update(adminKey()).digest("hex"));
  const actual = Buffer.from(createHash("sha256").update(value).digest("hex"));
  return timingSafeEqual(expected, actual);
}

export function isAdminRequest(request: NextRequest) {
  return isAdminToken(request.cookies.get(SESSION_COOKIE)?.value);
}

export function isAdminToken(token: string | undefined) {
  if (!token) return false;
  const expected = Buffer.from(createSessionToken());
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
