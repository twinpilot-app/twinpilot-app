"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Building2, Ticket, CheckCircle2,
  ChevronRight, ChevronLeft, Check,
  Mail, Eye, EyeOff,
  Lock, AlertCircle, Shield, X, FileText,
} from "lucide-react";
import { supabase } from "../../lib/supabase";
import { brand } from "@/lib/brand";
import { slugify } from "@/lib/slugify";
import WaitlistModal from "@/components/WaitlistModal";

/* ─── Types ──────────────────────────────────────────────── */

type Step = 1 | 2 | 3;

interface FormState {
  tenantName: string;
  tenantSlug: string;
  adminEmail: string;
  password: string;
}

/* ─── Helpers ────────────────────────────────────────────── */

const slug = (text: string) => slugify(text);

const INVITE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STEPS: { n: Step; label: string; icon: React.FC<{ size?: number }> }[] = [
  { n: 1, label: "Access",    icon: Ticket       },
  { n: 2, label: "Workspace", icon: Building2    },
  { n: 3, label: "Ready",     icon: CheckCircle2 },
];

const LEGAL_VERSION = "1.0";

/* ─── Legal modal ────────────────────────────────────────── */

function LegalModal({ type, onClose }: { type: "tos" | "privacy"; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    const path = type === "tos" ? "/legal/tos.md" : "/legal/privacy.md";
    fetch(path).then((r) => r.text()).then(setContent).catch(() => setContent("_Could not load document._"));
  }, [type]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = type === "tos" ? "Terms of Service & EULA" : "Privacy Policy";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", backdropFilter: "blur(6px)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
      <div style={{ background: "var(--mantle)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, width: "min(760px, 100%)", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 32px 80px rgba(0,0,0,0.6)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.07)", flexShrink: 0 }}>
          <FileText size={16} color="var(--overlay1)" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
            <div style={{ fontSize: 11, color: "var(--overlay0)" }}>Version {LEGAL_VERSION} · {brand.name}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4, display: "flex" }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", color: "var(--text)", fontSize: 13, lineHeight: 1.75 }}>
          {content == null ? (
            <div style={{ color: "var(--overlay0)", textAlign: "center", padding: 32 }}>Loading…</div>
          ) : (
            <div className="legal-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
        </div>
        <div style={{ padding: "12px 20px", borderTop: "1px solid rgba(255,255,255,0.07)", flexShrink: 0, display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "9px 24px", borderRadius: 9, border: "none", background: "var(--blue)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
            Close
          </button>
        </div>
      </div>
      <style>{`
        .legal-md h1 { font-size: 20px; font-weight: 800; margin: 0 0 20px; }
        .legal-md h2 { font-size: 15px; font-weight: 700; margin: 28px 0 10px; color: var(--subtext1); }
        .legal-md h3 { font-size: 13px; font-weight: 700; margin: 18px 0 8px; color: var(--subtext0); }
        .legal-md p  { margin: 0 0 10px; color: var(--subtext1); }
        .legal-md ul, .legal-md ol { margin: 0 0 10px; padding-left: 20px; color: var(--subtext1); }
        .legal-md li { margin-bottom: 4px; }
        .legal-md strong { color: var(--text); font-weight: 700; }
        .legal-md blockquote { margin: 0 0 14px; padding: 10px 14px; border-left: 3px solid rgba(245,159,0,0.5); background: rgba(245,159,0,0.06); border-radius: 0 8px 8px 0; color: var(--yellow); }
        .legal-md table { width: 100%; border-collapse: collapse; margin-bottom: 14px; font-size: 12px; }
        .legal-md th { text-align: left; padding: 8px 12px; background: var(--surface0); border: 1px solid var(--surface1); font-weight: 700; color: var(--subtext1); }
        .legal-md td { padding: 7px 12px; border: 1px solid var(--surface1); color: var(--subtext0); }
        .legal-md a  { color: var(--blue); }
        .legal-md hr { border: none; border-top: 1px solid var(--surface1); margin: 24px 0; }
        .legal-md code { background: var(--surface1); border-radius: 4px; padding: 1px 5px; font-size: 11px; }
      `}</style>
    </div>
  );
}

/* ─── Shared styles ──────────────────────────────────────── */

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "11px 14px",
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10, color: "var(--text)", fontSize: 15, outline: "none",
  fontFamily: "var(--font-sans)",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 13, fontWeight: 600, color: "var(--subtext1)", marginBottom: 6,
};
const hintStyle: React.CSSProperties = { fontSize: 12, color: "var(--overlay0)", marginTop: 5 };

const PLAN_COLOR: Record<string, string> = {
  starter:    "#6b7a9e",
  pro:        "#1463ff",
  enterprise: "#00c2a8",
  owner:      "#a78bfa",
};

/* ─── Main ───────────────────────────────────────────────── */

export default function OnboardPage() {
  const router = useRouter();

  const [step, setStep]             = useState<Step>(1);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [slugStatus, setSlugStatus] = useState<"idle" | "checking" | "available" | "taken">("idle");
  const slugTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [tosAccepted, setTosAccepted]         = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [showLegal, setShowLegal]             = useState<"tos" | "privacy" | null>(null);
  const [waitlistOpen, setWaitlistOpen]       = useState(false);

  // Step 1 state — email + slug + invite code
  const [inviteCode, setInviteCode]             = useState<string[]>(["", "", "", "", "", "", "", ""]);
  const [inviteValidating, setInviteValidating] = useState(false);
  const [inviteValid, setInviteValid]           = useState(false);
  const [invitePlan, setInvitePlan]             = useState<string | null>(null);
  const [inviteRole, setInviteRole]             = useState<"admin" | "member" | null>(null);
  const [joinTenant, setJoinTenant]             = useState<{ id: string; slug: string; name: string } | null>(null);
  const [inviteError, setInviteError]           = useState<string | null>(null);
  const inviteRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Result
  const [redirectIn, setRedirectIn] = useState<number>(2);

  const [form, setForm] = useState<FormState>({
    tenantName: "", tenantSlug: "", adminEmail: "", password: "",
  });

  function update<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  /* ── Debounced slug check (active in step 2) ── */
  useEffect(() => {
    const s = form.tenantSlug;
    if (s.length < 2 || step !== 2) { setSlugStatus("idle"); return; }
    setSlugStatus("checking");
    if (slugTimer.current) clearTimeout(slugTimer.current);
    slugTimer.current = setTimeout(async () => {
      const { data } = await supabase
        .from("tenants")
        .select("id")
        .eq("slug", s)
        .maybeSingle();
      setSlugStatus(data ? "taken" : "available");
    }, 400);
    return () => { if (slugTimer.current) clearTimeout(slugTimer.current); };
  }, [form.tenantSlug, step]);

  /* ── Step 3 auto-redirect countdown ── */
  useEffect(() => {
    if (step !== 3) return;
    setRedirectIn(2);
    const iv = setInterval(() => {
      setRedirectIn((n) => {
        if (n <= 1) {
          clearInterval(iv);
          router.replace(`/login?email=${encodeURIComponent(form.adminEmail)}`);
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [step, form.adminEmail, router]);

  /* ── Invite code helpers ── */
  function handleInviteChar(index: number, value: string) {
    const char = value.toUpperCase().slice(-1);
    if (char && !INVITE_CHARS.includes(char)) return;
    const next = [...inviteCode];
    next[index] = char;
    setInviteCode(next);
    setInviteError(null);
    setInviteValid(false);
    setInvitePlan(null);
    if (char && index < 7) inviteRefs.current[index + 1]?.focus();
  }

  function handleInviteKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !inviteCode[index] && index > 0) {
      inviteRefs.current[index - 1]?.focus();
    }
  }

  function handleInvitePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!pasted) return;
    const next = [...inviteCode];
    for (let i = 0; i < 8; i++) next[i] = pasted[i] ?? "";
    setInviteCode(next);
    setInviteError(null);
    setInviteValid(false);
    setInvitePlan(null);
    inviteRefs.current[Math.min(pasted.length, 7)]?.focus();
  }

  function getInviteCodeString(): string {
    return inviteCode.slice(0, 4).join("") + "-" + inviteCode.slice(4).join("");
  }

  async function handleValidateAndNext() {
    setError(null);
    const emailOk = EMAIL_RE.test(form.adminEmail.trim());
    if (!emailOk) {
      setInviteError("Please enter a valid email");
      return;
    }
    const slugOk = form.tenantSlug.trim().length >= 2;
    if (!slugOk) {
      setInviteError("Please enter the org slug from your invite");
      return;
    }
    if (inviteCode.join("").length < 8) {
      setInviteError("Please enter the full 8-character code");
      return;
    }
    setInviteValidating(true);
    setInviteError(null);
    try {
      const res = await fetch("/api/invite/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code:  getInviteCodeString(),
          email: form.adminEmail.trim().toLowerCase(),
          slug:  form.tenantSlug.trim(),
        }),
      });
      const body = (await res.json()) as {
        valid: boolean;
        error?: string;
        plan?: string;
        role?: "admin" | "member";
        joinTenant?:   { id: string; slug: string; name: string } | null;
        createTenant?: { slug: string; name: string | null }       | null;
      };
      if (body.valid) {
        setInviteValid(true);
        setInvitePlan(body.plan ?? null);
        setInviteRole(body.role ?? "admin");
        if (body.joinTenant) {
          setJoinTenant(body.joinTenant);
          // Pre-fill the tenant name from the resolved tenant — the
          // slug is already what the user typed, but for the join-flow
          // UI we want to show the org's display name too.
          setForm((prev) => ({
            ...prev,
            tenantName: body.joinTenant!.name,
            tenantSlug: body.joinTenant!.slug,
          }));
        } else {
          setJoinTenant(null);
          // Pre-fill the tenant name from the invite's reservation if
          // the platform admin recorded one; the user can still edit.
          if (body.createTenant?.name) {
            setForm((prev) => ({ ...prev, tenantName: body.createTenant!.name! }));
          }
        }
        setStep(2);
      } else {
        setInviteError(body.error ?? "Invalid code");
      }
    } catch {
      setInviteError("Could not validate code");
    } finally {
      setInviteValidating(false);
    }
  }

  /* ── Create account + tenant (step 2 submit) ── */
  async function handleCreateAccount() {
    if (!tosAccepted || !privacyAccepted) {
      setError("Please accept the Terms of Service and Privacy Policy.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/onboard/create-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantName: form.tenantName,
          tenantSlug: form.tenantSlug,
          email: form.adminEmail,
          password: form.password,
          inviteCode: getInviteCodeString(),
        }),
      });
      const body = (await res.json()) as { tenantId?: string; plan?: string; error?: string; redirect?: string };
      if (!res.ok) {
        if (body.redirect) { router.replace(body.redirect); return; }
        throw new Error(body.error ?? "Registration failed");
      }
      setStep(3);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const passwordOk = form.password.length >= 8;
  const canSubmitStep2 = joinTenant
    ? passwordOk && tosAccepted && privacyAccepted
    : (form.tenantName.length >= 2 &&
       form.tenantSlug.length >= 2 &&
       passwordOk &&
       tosAccepted &&
       privacyAccepted);

  const closeLegal = useCallback(() => setShowLegal(null), []);

  return (
    <div translate="no" style={{
      flex: 1, width: "100%", minHeight: "100vh",
      background: "radial-gradient(ellipse 80% 50% at 50% -5%, rgba(20,99,255,0.18) 0%, transparent 65%), var(--base)",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "flex-start", padding: "48px 16px 80px",
      fontFamily: "var(--font-sans)", color: "var(--text)",
      position: "relative",
    }}>
      {showLegal && <LegalModal type={showLegal} onClose={closeLegal} />}

      {step < 3 && (
        <a href="/" style={{
          position: "absolute", top: 20, left: 24,
          color: "var(--overlay1)", fontSize: 13, textDecoration: "none",
          display: "flex", alignItems: "center", gap: 4,
        }}>
          <ChevronLeft size={14} /> Home
        </a>
      )}

      <div style={{
        width: "100%", maxWidth: 480, margin: "0 auto",
        display: "flex", flexDirection: "column", alignItems: "stretch",
      }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <img src={brand.assets.logoWordmark} alt={brand.name}
            style={{ maxWidth: 180, height: "auto", margin: "0 auto 16px", display: "block", opacity: 0.92 }} />
          <p style={{ color: "var(--subtext0)", fontSize: 14 }}>
            {step === 2 && "Set up your organization workspace."}
            {step === 3 && "Your account is ready."}
          </p>
        </div>

        {/* Progress */}
        {step < 3 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 0, marginBottom: 28 }}>
            {STEPS.slice(0, 2).map((s, i) => {
              const done = step > s.n;
              const active = step === s.n;
              const Icon = s.icon;
              return (
                <React.Fragment key={s.n}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: "50%",
                      background: done ? "var(--blue)" : active ? "rgba(20,99,255,0.15)" : "var(--surface0)",
                      border: `2px solid ${done || active ? "var(--blue)" : "var(--surface1)"}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {done
                        ? <Check size={14} color="#fff" />
                        : <span style={{ color: active ? "var(--blue)" : "var(--overlay0)", display: "flex" }}><Icon size={13} /></span>}
                    </div>
                    <span style={{ fontSize: 10, color: active ? "var(--text)" : "var(--overlay0)", fontWeight: active ? 700 : 400 }}>
                      {s.label}
                    </span>
                  </div>
                  {i < 1 && (
                    <div style={{
                      width: 48, height: 2, marginBottom: 18,
                      background: done ? "var(--blue)" : "var(--surface1)",
                    }} />
                  )}
                </React.Fragment>
              );
            })}
          </div>
        )}

        <div style={{
          width: "100%",
          background: "rgba(17,24,40,0.88)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 18, padding: "28px",
          backdropFilter: "blur(16px)",
          boxShadow: "0 32px 80px rgba(0,0,0,0.45)",
        }}>

          {/* ── Step 1: email + invite code ─────────────────────────── */}
          {step === 1 && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Enter your invite</h2>
              <p style={{ color: "var(--subtext0)", fontSize: 13, marginBottom: 20 }}>
                Provide the email your invite was sent to and the 8-character code.
              </p>

              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Email</label>
                <div style={{ position: "relative" }}>
                  <Mail size={15} color="var(--overlay0)" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
                  <input
                    style={{ ...inputStyle, paddingLeft: 36 }}
                    type="email"
                    placeholder="you@company.com"
                    autoFocus
                    value={form.adminEmail}
                    onChange={(e) => update("adminEmail", e.target.value)}
                  />
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Org slug</label>
                <input
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  type="text"
                  placeholder="acme"
                  value={form.tenantSlug}
                  onChange={(e) => update("tenantSlug", slug(e.target.value))}
                />
                <p style={hintStyle}>
                  <span>The slug your platform admin set for the org — </span>
                  <span>existing orgs join, new orgs are created.</span>
                </p>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Invite code</label>
                <div style={{
                  padding: "16px 14px", borderRadius: 12,
                  background: inviteValid ? "rgba(28,191,107,0.06)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${inviteValid ? "rgba(28,191,107,0.3)" : "rgba(255,255,255,0.08)"}`,
                  transition: "all 0.25s",
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                    {inviteCode.map((ch, i) => (
                      <React.Fragment key={i}>
                        {i === 4 && (
                          <span style={{ fontSize: 20, fontWeight: 700, color: "var(--overlay0)", margin: "0 4px" }}>-</span>
                        )}
                        <input
                          ref={(el) => { inviteRefs.current[i] = el; }}
                          value={ch}
                          onChange={(e) => handleInviteChar(i, e.target.value)}
                          onKeyDown={(e) => handleInviteKeyDown(i, e)}
                          onPaste={handleInvitePaste}
                          maxLength={1}
                          disabled={inviteValid}
                          style={{
                            width: 38, height: 44, textAlign: "center",
                            fontSize: 18, fontWeight: 800, fontFamily: "var(--font-mono)",
                            borderRadius: 8,
                            border: `2px solid ${inviteValid ? "rgba(28,191,107,0.4)" : ch ? "rgba(20,99,255,0.4)" : "rgba(255,255,255,0.12)"}`,
                            background: inviteValid ? "rgba(28,191,107,0.08)" : "rgba(255,255,255,0.04)",
                            color: inviteValid ? "var(--green)" : "var(--text)",
                            outline: "none", textTransform: "uppercase",
                          }}
                        />
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              </div>

              {inviteError && (
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)", color: "var(--red)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  <AlertCircle size={13} style={{ flexShrink: 0 }} /> {inviteError}
                </div>
              )}

              {(() => {
                const ready = !inviteValidating
                  && EMAIL_RE.test(form.adminEmail.trim())
                  && form.tenantSlug.trim().length >= 2
                  && inviteCode.join("").length >= 8;
                return (
                  <button
                    onClick={handleValidateAndNext}
                    disabled={!ready}
                    style={{
                      width: "100%", padding: "12px 0", borderRadius: 10, border: "none",
                      background: ready ? "var(--tirsa-gradient)" : "var(--surface1)",
                      color:      ready ? "#fff"                  : "var(--overlay0)",
                      fontSize: 15, fontWeight: 700,
                      cursor: inviteValidating ? "not-allowed" : "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    {inviteValidating ? "Validating…" : <>Continue <ChevronRight size={15} /></>}
                  </button>
                );
              })()}

              <div style={{ display: "flex", flexDirection: "column", gap: 6, textAlign: "center", marginTop: 20, fontSize: 13, color: "var(--subtext0)" }}>
                <div>
                  Don&apos;t have an invite?{" "}
                  <button
                    type="button"
                    onClick={() => setWaitlistOpen(true)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--blue)",
                      textDecoration: "none",
                      fontWeight: 500,
                      cursor: "pointer",
                      fontSize: 13,
                      padding: 0,
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    Join the waiting list →
                  </button>
                </div>
                <div>
                  Already have an account?{" "}
                  <a href="/login" style={{ color: "var(--blue)", textDecoration: "none" }}>Sign in</a>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 2: tenant + password + legal ───────────────────── */}
          {step === 2 && (
            <div key={joinTenant ? `join-${joinTenant.id}` : "create-new"}>
              <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
                <span>{joinTenant ? `Join ${joinTenant.name}` : "Your workspace"}</span>
              </h2>
              <p style={{ color: "var(--subtext0)", fontSize: 13, marginBottom: 20 }}>
                <span>Signing up as </span>
                <strong style={{ color: "var(--text)" }}>{form.adminEmail}</strong>
                {invitePlan && <> · <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: `${PLAN_COLOR[invitePlan] ?? "#6b7a9e"}18`, color: PLAN_COLOR[invitePlan] ?? "#6b7a9e", textTransform: "uppercase" }}>{invitePlan}</span></>}
              </p>

              {joinTenant ? (
                <div key="join-panel" style={{
                  marginBottom: 20, padding: "14px 16px", borderRadius: 10,
                  background: "rgba(20,99,255,0.06)", border: "1px solid rgba(20,99,255,0.25)",
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--blue)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                    <span>{inviteRole === "admin" ? "Joining as admin" : "Joining as member"}</span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                    <span>{joinTenant.name}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--overlay0)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                    <span>@{joinTenant.slug}</span>
                  </div>
                  <p style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 8, lineHeight: 1.5 }}>
                    {inviteRole === "admin"
                      ? <span>You&apos;ll be able to manage members, factories, and settings.</span>
                      : <span>You&apos;ll have full access to projects, factories, and settings — same as other members.</span>}
                  </p>
                </div>
              ) : (
                <div key="create-panel" style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>Organization name</label>
                  <input style={inputStyle} placeholder="Acme Corp" autoFocus value={form.tenantName}
                    onChange={(e) => update("tenantName", e.target.value)} />
                  <p style={hintStyle}>
                    <span>Slug: </span>
                    <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>@{form.tenantSlug}</strong>
                    <span> · {brand.domain}/{form.tenantSlug}</span>
                  </p>
                </div>
              )}

              <div style={{ marginBottom: 20 }}>
                <label style={labelStyle}>Password</label>
                <div style={{ position: "relative" }}>
                  <Lock size={15} color="var(--overlay0)" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
                  <input
                    style={{ ...inputStyle, paddingLeft: 36, paddingRight: 38 }}
                    type={showPassword ? "text" : "password"}
                    placeholder="Min. 8 characters"
                    value={form.password}
                    onChange={(e) => update("password", e.target.value)}
                  />
                  <button type="button" onClick={() => setShowPassword((v) => !v)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4 }}>
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {form.password.length > 0 && !passwordOk && (
                  <p style={{ ...hintStyle, color: "var(--red)" }}>At least 8 characters.</p>
                )}
              </div>

              <div style={{ marginBottom: 20, padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,0.03)", border: `1px solid ${tosAccepted && privacyAccepted ? "rgba(28,191,107,0.3)" : "rgba(255,255,255,0.08)"}`, transition: "border-color 0.25s" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <Shield size={13} color={tosAccepted && privacyAccepted ? "var(--green)" : "var(--overlay0)"} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: tosAccepted && privacyAccepted ? "var(--green)" : "var(--subtext1)" }}>Legal agreements</span>
                </div>

                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", marginBottom: 8 }}>
                  <div onClick={() => setTosAccepted((v) => !v)}
                    style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, marginTop: 1, border: `2px solid ${tosAccepted ? "var(--blue)" : "rgba(255,255,255,0.2)"}`, background: tosAccepted ? "var(--blue)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {tosAccepted && <Check size={10} color="#fff" strokeWidth={3} />}
                  </div>
                  <span style={{ fontSize: 12, color: "var(--subtext1)", lineHeight: 1.5 }}>
                    I agree to the{" "}
                    <button type="button" onClick={(e) => { e.stopPropagation(); setShowLegal("tos"); }}
                      style={{ background: "none", border: "none", color: "var(--blue)", fontSize: 12, cursor: "pointer", padding: 0, textDecoration: "underline", fontFamily: "var(--font-sans)" }}>
                      Terms of Service & EULA
                    </button>
                  </span>
                </label>

                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <div onClick={() => setPrivacyAccepted((v) => !v)}
                    style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, marginTop: 1, border: `2px solid ${privacyAccepted ? "var(--blue)" : "rgba(255,255,255,0.2)"}`, background: privacyAccepted ? "var(--blue)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {privacyAccepted && <Check size={10} color="#fff" strokeWidth={3} />}
                  </div>
                  <span style={{ fontSize: 12, color: "var(--subtext1)", lineHeight: 1.5 }}>
                    I agree to the{" "}
                    <button type="button" onClick={(e) => { e.stopPropagation(); setShowLegal("privacy"); }}
                      style={{ background: "none", border: "none", color: "var(--blue)", fontSize: 12, cursor: "pointer", padding: 0, textDecoration: "underline", fontFamily: "var(--font-sans)" }}>
                      Privacy Policy
                    </button>
                  </span>
                </label>
              </div>

              {error && (
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)", color: "var(--red)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  <AlertCircle size={13} style={{ flexShrink: 0 }} /> {error}
                </div>
              )}

              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => { setStep(1); setError(null); }}
                  style={{ padding: "11px 18px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "var(--subtext1)", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                  <ChevronLeft size={15} /> Back
                </button>
                <button
                  onClick={handleCreateAccount}
                  disabled={loading || !canSubmitStep2}
                  style={{
                    flex: 1, padding: "11px 0", borderRadius: 10, border: "none",
                    background: canSubmitStep2 && !loading ? "var(--tirsa-gradient)" : "var(--surface1)",
                    color: canSubmitStep2 && !loading ? "#fff" : "var(--overlay0)",
                    fontSize: 15, fontWeight: 700,
                    cursor: canSubmitStep2 && !loading ? "pointer" : "not-allowed",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  {loading ? "Creating account…" : <>Create account <ChevronRight size={15} /></>}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: success + auto-redirect ─────────────────────── */}
          {step === 3 && (
            <div style={{ textAlign: "center" }}>
              <div style={{ width: 60, height: 60, borderRadius: "50%", margin: "0 auto 16px", background: "rgba(28,191,107,0.12)", border: "2px solid var(--green)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <CheckCircle2 size={30} color="var(--green)" />
              </div>
              <h2 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", marginBottom: 6 }}>Account created!</h2>
              <p style={{ fontSize: 13, color: "var(--subtext1)", marginBottom: 24 }}>
                Redirecting to sign in{redirectIn > 0 ? ` in ${redirectIn}…` : "…"}
              </p>

              <a href={`/login?email=${encodeURIComponent(form.adminEmail)}`} style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                width: "100%", padding: "13px 0", borderRadius: 12,
                background: "var(--tirsa-gradient)",
                color: "#fff", fontWeight: 700, fontSize: 15, textDecoration: "none",
              }}>
                Sign in now <ChevronRight size={15} />
              </a>
            </div>
          )}
        </div>
      </div>

      <WaitlistModal open={waitlistOpen} onClose={() => setWaitlistOpen(false)} defaultEmail={form.adminEmail} />
    </div>
  );
}
