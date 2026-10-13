import { NextRequest, NextResponse } from "next/server";

const EMBED_ORIGIN = process.env.EMBED_ORIGIN?.trim();
const FRAME_POLICY = `frame-ancestors 'self'${EMBED_ORIGIN ? ` ${EMBED_ORIGIN}` : ""}`;

function applySharedHeaders(response: NextResponse) {
  response.headers.set("Content-Security-Policy", FRAME_POLICY);
  if (EMBED_ORIGIN) {
    response.headers.set("Access-Control-Allow-Origin", EMBED_ORIGIN);
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return response;
}

export function middleware(request: NextRequest) {
  if (request.method === "OPTIONS" && request.nextUrl.pathname.startsWith("/api/")) {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.headers.set("Access-Control-Max-Age", "86400");
    return applySharedHeaders(response);
  }

  return applySharedHeaders(NextResponse.next());
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
