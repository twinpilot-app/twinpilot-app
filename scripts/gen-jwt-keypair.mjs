#!/usr/bin/env node
/**
 * Generate an ES256 (P-256) key pair for signing worker JWTs.
 *
 *   node scripts/gen-jwt-keypair.mjs
 *
 * Outputs three things:
 *   1. Private key as PKCS#8 PEM  → Vercel (SUPABASE_JWT_PRIVATE_KEY).
 *   2. Private key as JWK         → Supabase "Import Signing Key".
 *   3. Public key  as JWK         → only needed if you want to verify
 *                                   it matches what Supabase exposes.
 *
 * Keep the PRIVATE key somewhere safe; it's not recoverable.
 */
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const privateJwkRaw = privateKey.export({ format: "jwk" });
const publicJwkRaw  = publicKey.export({ format: "jwk" });

// Augment JWKs with the algorithm fields Supabase expects. Supabase
// assigns its OWN kid when the key is imported — don't set one here.
const privateJwk = { ...privateJwkRaw, alg: "ES256", use: "sig" };
const publicJwk  = { ...publicJwkRaw,  alg: "ES256", use: "sig" };

console.log("─── Private key (PKCS#8 PEM) — save this NOW, cannot be recovered ───");
console.log(privatePem);
console.log("─── Private key (JWK) — paste into Supabase \"Import Signing Key\" ───");
console.log(JSON.stringify(privateJwk, null, 2));
console.log();
console.log("─── Public key (JWK) — for reference; Supabase will derive this itself ───");
console.log(JSON.stringify(publicJwk, null, 2));
console.log();
console.log("Next steps:");
console.log("  1. Supabase Dashboard → Authentication → JWT Keys");
console.log("     - Add new Signing Key → ES256 → \"Import\" → paste the PRIVATE JWK above");
console.log("     - Start it as \"Standby\" (Supabase will only verify tokens signed with it,");
console.log("       not sign new sessions — which is what we want).");
console.log("     - Supabase will assign a kid — copy it from the new key's details.");
console.log("  2. Vercel → Settings → Environment Variables");
console.log("     - SUPABASE_JWT_PRIVATE_KEY = <the PEM block above, BEGIN/END lines included>");
console.log("     - SUPABASE_JWT_KID         = <the kid Supabase assigned>");
console.log("  3. Trigger a redeploy in Vercel so the new env vars take effect.");
console.log("  4. Verify via GET /api/admin/jwt-debug — it should show kidMatchesJwks: true.");
console.log("  5. Once signing works, you can revoke the legacy HS256 secret in Supabase");
console.log("     and remove SUPABASE_JWT_SECRET from Vercel.");
