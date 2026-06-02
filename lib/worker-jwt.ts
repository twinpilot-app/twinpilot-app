/**
 * Worker JWT minting — shared by /api/worker/mint-token and the sprint
 * dispatcher. Signs a short-lived token carrying tenant_id/factory_id so
 * the worker can open a tenant-scoped Supabase client that RLS honours.
 *
 * Supabase migrated away from symmetric HS256 keys in its JWT Signing
 * Keys product. We support both paths:
 *
 *   1. ES256 (preferred for projects with asymmetric-only keys).
 *      Requires SUPABASE_JWT_PRIVATE_KEY (PEM) + SUPABASE_JWT_KID
 *      (the kid Supabase's JWKS exposes for the public key).
 *
 *   2. HS256 (legacy projects that still accept the symmetric secret
 *      for verification). Requires SUPABASE_JWT_SECRET.
 *
 * If neither is configured, minting throws and sprint-dispatcher
 * releases the slot with a clear error.
 */
import { createHmac, createPrivateKey, createSign } from "node:crypto";

const DEFAULT_TTL_SECONDS = 60 * 60;       // 1h
const MAX_TTL_SECONDS     = 60 * 60 * 24;  // 24h cap — matches pipeline maxDuration

export type WorkerTokenResult = {
  token: string;
  expiresAt: number;
  tenantId: string;
  factoryId: string | null;
};

export type MintWorkerTokenInput = {
  tenantId: string;
  factoryId?: string | null;
  ttlSeconds?: number;
};

/* ── Encoding helpers ───────────────────────────────────────────── */

function base64url(input: Buffer | string): string {
  const b = typeof input === "string" ? Buffer.from(input) : input;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ── HS256 (legacy symmetric) ───────────────────────────────────── */

function signHS256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${base64url(signature)}`;
}

/* ── ES256 (asymmetric P-256) ──────────────────────────────────── */

function signES256(payload: Record<string, unknown>, privateKeyPem: string, kid?: string): string {
  const header: Record<string, unknown> = { alg: "ES256", typ: "JWT" };
  if (kid) header.kid = kid;
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Node's default ECDSA output is DER-encoded. JWT (RFC 7518) requires
  // raw r||s (IEEE P-1363 format). dsaEncoding: "ieee-p1363" switches
  // output so the signature Supabase validates has the expected shape.
  let keyObj;
  try {
    keyObj = createPrivateKey(privateKeyPem);
  } catch (err) {
    const head = privateKeyPem.slice(0, 40).replace(/\n/g, "\\n");
    const tail = privateKeyPem.slice(-40).replace(/\n/g, "\\n");
    throw new Error(
      `Failed to parse SUPABASE_JWT_PRIVATE_KEY as PEM (${(err as Error).message}). ` +
      `Got ${privateKeyPem.length} chars starting with "${head}" and ending with "${tail}". ` +
      `Expected PKCS#8 with BEGIN/END PRIVATE KEY markers and real newlines.`,
    );
  }
  const signature = createSign("sha256")
    .update(signingInput)
    .sign({ key: keyObj, dsaEncoding: "ieee-p1363" });

  return `${signingInput}.${base64url(signature)}`;
}

/* ── Main entry point ──────────────────────────────────────────── */

export function mintWorkerToken(input: MintWorkerTokenInput): WorkerTokenResult {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new Error("tenantId is required");
  const factoryId = input.factoryId?.trim() || null;
  const ttl = Math.min(input.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);

  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttl;

  // `sub` must be a valid UUID because Supabase's auth.uid() helper
  // casts the claim to uuid; any non-UUID string breaks every RLS policy
  // that calls auth.uid() (even transitively via joined tables).
  const payload: Record<string, unknown> = {
    role:      "authenticated",
    sub:       tenantId,
    aud:       "authenticated",
    iat:       now,
    exp,
    iss:       "twinpilot-platform",
    tenant_id: tenantId,
    ...(factoryId ? { factory_id: factoryId } : {}),
    scope:     "worker",
  };

  // Prefer ES256 if an asymmetric key is configured. New Supabase
  // projects need this because the legacy HS256 secret is "verify only"
  // for pre-migration tokens and doesn't accept our newly minted ones.
  const pem = process.env.SUPABASE_JWT_PRIVATE_KEY;
  const kid = process.env.SUPABASE_JWT_KID;
  if (pem) {
    const token = signES256(payload, normalizePem(pem), kid);
    return { token, expiresAt: exp, tenantId, factoryId };
  }

  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    const token = signHS256(payload, secret);
    return { token, expiresAt: exp, tenantId, factoryId };
  }

  throw new Error(
    "Neither SUPABASE_JWT_PRIVATE_KEY (preferred, ES256) nor SUPABASE_JWT_SECRET (legacy HS256) is configured on the platform",
  );
}

/**
 * Some env var stores strip real newlines or wrap keys in quotes. Undo
 * both so we always hand `createPrivateKey` a well-formed PEM.
 */
function normalizePem(raw: string): string {
  let s = raw.trim();
  // Some env var stores wrap the value in quotes.
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
  // Un-escape literal \n that platforms sometimes produce when the
  // value was pasted into a single-line field.
  s = s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
  // Normalise Windows line endings.
  s = s.replace(/\r\n/g, "\n");
  // If the PEM has no newlines at all (happens when a single-line
  // editor swallowed them), re-inject between the headers and base64
  // body so OpenSSL can parse it.
  if (!s.includes("\n") && s.includes("-----BEGIN")) {
    s = s
      .replace(/(-----BEGIN [^-]+-----)/, "$1\n")
      .replace(/(-----END [^-]+-----)/, "\n$1")
      .replace(/([^-\n])(-----END)/, "$1\n$2");
  }
  return s;
}
