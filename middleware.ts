import { NextRequest, NextResponse } from "next/server";

// Protect /app/* — require a session cookie, else redirect to /login.
export function middleware(req: NextRequest) {
  const session = req.cookies.get(process.env.SESSION_COOKIE || "fp_session")?.value;
  if (!session) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*"],
};
