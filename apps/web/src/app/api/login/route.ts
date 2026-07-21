import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, dashboardPassword, mintSessionToken, passwordMatches } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const expected = dashboardPassword();
  const form = await req.formData();
  const candidate = String(form.get("password") ?? "");
  const nextPath = String(form.get("next") ?? "/");
  // Only ever redirect within the app.
  const safeNext = nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/";

  // Relative Location headers keep the browser on whatever host it used —
  // req.url reflects the server bind address (0.0.0.0) in standalone mode.
  if (!expected || !passwordMatches(candidate, expected)) {
    const params = new URLSearchParams({ error: "1" });
    if (safeNext !== "/") params.set("next", safeNext);
    return new NextResponse(null, {
      status: 303,
      headers: { Location: `/login?${params.toString()}` },
    });
  }

  const res = new NextResponse(null, { status: 303, headers: { Location: safeNext } });
  res.cookies.set(SESSION_COOKIE, mintSessionToken(expected), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Number(process.env.SESSION_TTL_HOURS ?? 168) * 60 * 60,
    // secure only when actually served over https, so http test deploys work
    secure: req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https",
  });
  return res;
}
