/* Serves the price data only to signed-in Card Watch users: every request needs the user's Supabase
   access token (Authorization: Bearer <jwt>). Browsers may only call from the app's own addresses.
   Netlify environment variables:
     SUPABASE_URL         https://<ref>.supabase.co (the app's Supabase project)
     ALLOWED_ORIGINS      the app's addresses, comma separated (https://cardwatch.netlify.app,http://localhost:8080)
     SUPABASE_JWT_SECRET  only for projects still on the legacy HS256 secret; with JWT signing keys it isn't needed
     SUPABASE_PUBLISHABLE_KEY  the app's publishable key, handed to the inspector page so it can sign in
     OWNER_EMAILS         accounts that may use the inspector, comma separated (none set = nobody)
   /inspector.html is served without a sign-in (it holds no data; config.excludedPath). It reads
   /inspector-config.json (public: the Supabase address and publishable key) and asks /inspector-access with
   its token whether the account is an owner. */
import type { Config, Context } from "@netlify/edge-functions";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "https://esm.sh/jose@6.2.12";

const SUPABASE_URL = (Netlify.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
const ALLOWED_ORIGINS = (Netlify.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const LEGACY_SECRET = Netlify.env.get("SUPABASE_JWT_SECRET");
const PUBLISHABLE_KEY = (Netlify.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "").trim();
const OWNER_EMAILS = (Netlify.env.get("OWNER_EMAILS") ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const jwks = SUPABASE_URL
  ? createRemoteJWKSet(new URL(SUPABASE_URL + "/auth/v1/.well-known/jwks.json"))
  : null;

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    Vary: "Origin",
    "X-Robots-Tag": "noindex",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "authorization";
    headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function refuse(request: Request, status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      ...corsHeaders(request),
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

/** The signed-in user's token claims, or null without a valid Card Watch sign-in. */
async function signedIn(request: Request): Promise<JWTPayload | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token || !jwks) return null;
  const options = { issuer: SUPABASE_URL + "/auth/v1", audience: "authenticated" };
  try {
    if (LEGACY_SECRET && decodeProtectedHeader(token).alg === "HS256") {
      return (await jwtVerify(token, new TextEncoder().encode(LEGACY_SECRET), options)).payload;
    }
    return (await jwtVerify(token, jwks, options)).payload;
  } catch {
    return null;
  }
}

export default async (request: Request, context: Context) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "GET" && request.method !== "HEAD") return refuse(request, 405, "Method not allowed");
  if (!SUPABASE_URL) return refuse(request, 503, "Price data is not configured (SUPABASE_URL)");
  const path = new URL(request.url).pathname;
  if (path === "/inspector-config.json") return json(request, { supabaseUrl: SUPABASE_URL, publishableKey: PUBLISHABLE_KEY });
  const user = await signedIn(request);
  if (!user) return refuse(request, 401, "Sign in to Card Watch to read the price data");
  if (path === "/inspector-access") {
    const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
    return OWNER_EMAILS.includes(email)
      ? json(request, { owner: true })
      : refuse(request, 403, "This account may not use the inspector");
  }

  const response = await context.next();
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
  headers.set("Cache-Control", "private, no-cache");
  return new Response(response.body, { status: response.status, headers });
};

export const config: Config = { path: "/*", excludedPath: ["/inspector.html", "/inspector"] };
