/**
 * Shared API-route helpers.
 *
 * Most of TwinPilot's 151 `app/api/**` routes hand-roll the same five steps:
 *   1. parse Bearer token from Authorization header
 *   2. resolve user via Supabase (service-role client)
 *   3. parse JSON body, often into a hand-typed inline interface
 *   4. check tenant_members for the project's tenant
 *   5. emit ad-hoc { error: "..." } responses on failure
 *
 * That ad-hoc-ness is debt #6 and #15 in project_audit_2026_05_04.md:
 *   - no input size caps (DoS surface)
 *   - inconsistent error envelope (UI can't classify reliably)
 *   - no central place to add rate limiting / audit logging later
 *
 * This module gives every route a small, composable kit:
 *   - `serviceClient()` — service-role Supabase client (bypasses RLS, used
 *      everywhere; we don't write a tenant-scoped client client-side here
 *      because RLS is enforced via the auth gate + membership check below).
 *   - `getUser(req)` — parses the Bearer token and returns `{ user, sb }`.
 *      Throws `AuthError` on failure (caller's `errorResponse` translates).
 *   - `parseBody(req, schema)` — `await req.json()` + Zod validate. Throws
 *      `ValidationError` on failure with a structured detail list.
 *   - `assertMember(sb, userId, factoryId, roles?)` — confirms membership.
 *      Throws `ForbiddenError` on failure.
 *   - `errorResponse(e)` — translates known errors to the standard envelope
 *      `{ error, code?, hint?, details? }` with the right HTTP status.
 *
 * Routes adopt these gradually; the helpers don't replace the route signature
 * (Next.js App Router has too much variance there). Adoption pattern in the
 * route body:
 *
 *   try {
 *     const { user, sb } = await getUser(req);
 *     const { id } = await params;
 *     const body = await parseBody(req, ProjectPatchSchema);
 *     // ... handler logic
 *   } catch (e) {
 *     return errorResponse(e);
 *   }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { z, ZodType } from "zod";

/* ──────── Custom error classes ──────── */

export class AuthError extends Error {
  constructor(message = "Unauthorized") { super(message); this.name = "AuthError"; }
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") { super(message); this.name = "ForbiddenError"; }
}

export class NotFoundError extends Error {
  constructor(message = "Not found") { super(message); this.name = "NotFoundError"; }
}

export class ValidationError extends Error {
  /** Zod's flattened issue list — surfaced in the error envelope so the
   *  client can pin failures to specific fields. */
  details: { path: string[]; message: string }[];
  constructor(message: string, details: { path: string[]; message: string }[]) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

export class PayloadTooLargeError extends Error {
  constructor(message = "Payload too large") { super(message); this.name = "PayloadTooLargeError"; }
}

/* ──────── Service-role client ──────── */

/**
 * Service-role Supabase client. Bypasses RLS — only safe to use after auth
 * has been verified via getUser + membership via assertMember.
 */
export function serviceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

/* ──────── Auth ──────── */
/*
 * The command-center has 6 distinct auth surfaces:
 *
 *   1. Operator UI routes (~120 routes)    — Bearer Supabase JWT (browser session)
 *      → use `getOperatorUser(req)` below.
 *
 *   2. /api/cli/*  (~15 routes)            — Bearer tenant API key (`tp` daemon)
 *      → use `getCliCaller(req)` below (wraps `lib/cli-api-auth.ts`).
 *
 *   3. /api/admin/* (~20 routes)           — Bearer Supabase JWT + role=platform_admin
 *      → use `getOperatorUser(req)` then call `assertMember(..., ["platform_admin"])`.
 *
 *   4. /api/webhooks/* (per-webhook)       — HMAC signature verification.
 *      → custom per-webhook; not covered by these helpers.
 *
 *   5. /api/cron/* (retired 2026-05-04)    — was Bearer CRON_SECRET.
 *      → no longer used; do not add new ones (see feedback_no_platform_scheduling.md).
 *
 *   6. /api/worker/mint-token              — internal mint flow.
 *      → custom; not covered.
 *
 * `parseBody` and `errorResponse` are auth-agnostic and work for any
 * surface. Pick the right auth helper for the route's class.
 */

/** The fields downstream code reads from the Supabase user. Strict subset
 *  of `@supabase/supabase-js`'s User type so callers don't need to import
 *  the SDK's user type just to type a parameter. `app_metadata` carries
 *  the platform-admin role flag. */
export interface OperatorUser {
  id:            string;
  email?:        string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

/**
 * Operator UI auth — Bearer Supabase JWT from the browser session. Throws
 * AuthError on missing / invalid token. The caller is expected to wrap the
 * route body in try/catch and route errors through `errorResponse`.
 *
 * For admin routes, the returned user carries `app_metadata` — gate on
 * `user.app_metadata?.role === 'admin'` directly. For tenant-member roles
 * (admin / member of a specific tenant), follow with `assertMember`.
 */
export async function getOperatorUser(req: NextRequest): Promise<{
  user: OperatorUser;
  sb: SupabaseClient;
}> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new AuthError("Missing Authorization header");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new AuthError("Invalid or expired token");
  return {
    user: {
      id:            user.id,
      email:         user.email ?? null,
      app_metadata:  user.app_metadata ?? {},
      user_metadata: user.user_metadata ?? {},
    },
    sb,
  };
}

/**
 * @deprecated Use `getOperatorUser` instead. Kept as an alias during the
 * Trilho E sweep so already-converted routes don't need a second touch.
 * Will be removed in a follow-up cleanup.
 */
export const getUser = getOperatorUser;

/**
 * CLI auth — Bearer tenant API key from `tp` daemon. Wraps the existing
 * `authCli` helper but throws structured errors instead of returning
 * NextResponse, so /api/cli/* routes can use the same try/catch +
 * errorResponse shape as operator UI routes.
 *
 * Returns the resolved tenant context (sb, tenantId, factoryId). When the
 * key is factory-scoped, factoryId is non-null; tenant-wide keys leave it
 * null — the caller is responsible for taking factoryId from the request
 * body or query when needed.
 */
export async function getCliCaller(
  req: NextRequest,
  opts?: { requestedFactoryId?: string | null },
): Promise<{ sb: SupabaseClient; tenantId: string; factoryId: string | null }> {
  // Lazy import — avoids a circular dep risk and keeps the helper small.
  const { authCli } = await import("./cli-api-auth");
  const result = await authCli(req, opts);
  // authCli returns either the context OR a NextResponse on failure. Map
  // the failure shapes to our structured error classes so errorResponse
  // emits the same envelope shape as operator-UI routes.
  if (result instanceof NextResponse) {
    const status = result.status;
    let message = `CLI auth failed (HTTP ${status})`;
    try {
      const body = await result.clone().json() as { error?: string };
      if (body.error) message = body.error;
    } catch { /* response wasn't JSON — keep generic */ }
    if (status === 401) throw new AuthError(message);
    if (status === 403) throw new ForbiddenError(message);
    throw new Error(message);
  }
  return result;
}

/**
 * Confirm the user is a member of the factory's tenant (with one of the
 * given roles). Throws ForbiddenError on failure. Returns the resolved
 * tenant id for downstream use.
 *
 * Default roles: platform_admin + admin. Pass ["platform_admin","admin","member"]
 * for routes that allow regular members (most read endpoints).
 */
export async function assertMember(
  sb: SupabaseClient,
  userId: string,
  factoryId: string,
  roles: string[] = ["platform_admin", "admin"],
): Promise<{ tenantId: string }> {
  const { data: factory } = await sb
    .from("factories")
    .select("tenant_id")
    .eq("id", factoryId)
    .single();
  if (!factory) throw new NotFoundError("Factory not found");
  const tenantId = factory.tenant_id as string;
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .single();
  if (!member || !roles.includes(member.role as string)) {
    throw new ForbiddenError(`Caller lacks one of [${roles.join(", ")}] on tenant ${tenantId}`);
  }
  return { tenantId };
}

/* ──────── Body parsing ──────── */

/**
 * Hard upper bound on the raw JSON body. Above this we reject without
 * trying to parse — protects against DoS via massive payloads. Per-field
 * caps inside the schema bound the smaller cases.
 *
 * 1 MB is generous enough for any sane sprint dispatch (PRD up to 64KB +
 * step instructions + step-routing matrix + context refs) and small
 * enough to fail fast on attacks.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * `await req.json()` + Zod validate. Throws PayloadTooLargeError when the
 * raw body exceeds 1MB, ValidationError when the schema rejects.
 *
 * Zod parses once and the type is inferred from the schema, so the caller
 * gets fully-typed `body` without an explicit cast.
 */
export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  // Read raw text first so we can enforce a byte cap before JSON parsing.
  // Reading via .json() doesn't tell us the size before allocation.
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError(
      `Request body is ${raw.length} bytes; max is ${MAX_BODY_BYTES}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch (e) {
    throw new ValidationError(`Invalid JSON: ${(e as Error).message}`, []);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((iss) => ({
      path: iss.path.map((p) => String(p)),
      message: iss.message,
    }));
    throw new ValidationError("Request body failed validation", details);
  }
  return result.data;
}

/* ──────── Error envelope ──────── */

/** Standard error response shape. */
export interface ErrorEnvelope {
  error:    string;
  code?:    string;
  hint?:    string;
  details?: { path: string[]; message: string }[];
}

/**
 * Translate a thrown error to the standard envelope + correct HTTP status.
 * Unknown errors fall through to 500 with a generic message — full details
 * are logged server-side via console.error so we don't leak internals.
 */
export function errorResponse(e: unknown): NextResponse<ErrorEnvelope> {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message, code: "UNAUTHORIZED" }, { status: 401 });
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: e.message, code: "FORBIDDEN" }, { status: 403 });
  }
  if (e instanceof NotFoundError) {
    return NextResponse.json({ error: e.message, code: "NOT_FOUND" }, { status: 404 });
  }
  if (e instanceof ValidationError) {
    return NextResponse.json(
      { error: e.message, code: "VALIDATION_ERROR", details: e.details },
      { status: 400 },
    );
  }
  if (e instanceof PayloadTooLargeError) {
    return NextResponse.json({ error: e.message, code: "PAYLOAD_TOO_LARGE" }, { status: 413 });
  }
  // Unknown failure — log and return generic 500. Don't echo internals.
  const message = e instanceof Error ? e.message : "unknown error";
  console.error("[api] Unhandled route error:", message, e instanceof Error ? e.stack : undefined);
  return NextResponse.json({ error: message, code: "INTERNAL" }, { status: 500 });
}

/* ──────── Type re-exports ──────── */

/** Convenience: infer the body type from a Zod schema. */
export type Infer<S extends ZodType> = z.infer<S>;
