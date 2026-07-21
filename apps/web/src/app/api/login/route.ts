import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, dashboardPassword, mintSessionToken, passwordMatches } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const expected = dashboardPassword();
  const form = await req.formData();
  const candidate = String(form.get("password") ?? "");
  const nextPath = String(form.get("next") ?? "/");
  // Only ever redirect within the app.
  const safeNext = nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/";

  if (!expected || !passwordMatches(candidate, expected)) {
    const login = new URL("/login", req.url);
    login.searchParams.set("error", "1");
    if (safeNext !== "/") login.searchParams.set("next", safeNext);
    return NextResponse.redirect(login, 303);
  }

  const res = NextResponse.redirect(new URL(safeNext, req.url), 303);
  res.cookies.set(SESSION_COOKIE, mintSessionToken(expected), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
    // secure only when actually served over https, so http test deploys work
    secure: req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https",
  });
  return res;
}
