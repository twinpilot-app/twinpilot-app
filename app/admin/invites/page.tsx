"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { slugify } from "@/lib/slugify";
import { Copy, Check, Trash2, ToggleLeft, ToggleRight, Plus, Ticket, ChevronDown } from "lucide-react";

interface InviteCode {
  id: string;
  code: string;
  email: string;
  plan: string;
  role: string | null;
  max_uses: number;
  used_count: number;
  expires_at: string;
  created_at: string;
  active: boolean;
  tenant_id: string | null;
  tenant_slug: string | null;          // synthesised by GET when tenant_id is set
  target_tenant_slug: string | null;
  target_tenant_name: string | null;
}

interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  plan: string | null;
}

const PLAN_COLOR: Record<string, string> = {
  starter:    "#6b7a9e",
  pro:        "#1463ff",
  enterprise: "#00c2a8",
};

const ROLE_COLOR: Record<string, string> = {
  admin:  "#a78bfa",
  member: "#6b7a9e",
};

async function fetchWithAuth(url: string, token: string, opts?: RequestInit) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...opts?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" })) as { error?: string };
    throw new Error(body.error ?? "Request failed");
  }
  return res.json();
}

function getStatus(code: InviteCode): { label: string; color: string } {
  if (!code.active) return { label: "Inactive", color: "var(--overlay0)" };
  if (new Date(code.expires_at) < new Date()) return { label: "Expired", color: "var(--red)" };
  if (code.used_count >= code.max_uses) return { label: "Depleted", color: "var(--yellow)" };
  return { label: "Active", color: "var(--green)" };
}

export default function AdminInvitesPage() {
  const [codes, setCodes]       = useState<InviteCode[]>([]);
  const [tenants, setTenants]   = useState<TenantSummary[]>([]);
  const [loading, setLoading]   = useState(true);
  const [generating, setGenerating]   = useState(false);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [copied, setCopied]     = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);

  // Generate form state
  const [tenantSlug, setTenantSlug]     = useState("");
  const [tenantName, setTenantName]     = useState("");
  const [role, setRole]                 = useState<"admin" | "member">("admin");
  const [plan, setPlan]                 = useState<"starter" | "pro" | "enterprise">("starter");
  const [inviteEmail, setInviteEmail]   = useState("");
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [maxUses, setMaxUses]           = useState(1);
  const [comboOpen, setComboOpen]       = useState(false);
  const comboRef = useRef<HTMLDivElement | null>(null);

  // The slug field is a combobox: typeable, with the existing tenants
  // as a filtered dropdown. Three meaningful states:
  //   - blank        → invitee picks any slug (founder, role=admin)
  //   - matches one  → join existing org (admin or member)
  //   - typed/no match → reserves slug for new org (founder, role=admin)
  const matchedTenant = useMemo(
    () => tenants.find((t) => t.slug === tenantSlug.trim()),
    [tenants, tenantSlug],
  );
  const isJoinFlow   = !!matchedTenant;
  const slugFilled   = tenantSlug.trim().length > 0;

  // Anything that's not a clean join-existing flow forces role=admin.
  useEffect(() => {
    if (!isJoinFlow && role !== "admin") setRole("admin");
  }, [isJoinFlow, role]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!comboRef.current) return;
      if (!comboRef.current.contains(e.target as Node)) setComboOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filteredTenants = useMemo(() => {
    const q = tenantSlug.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter((t) =>
      t.slug.toLowerCase().includes(q) || t.name.toLowerCase().includes(q),
    );
  }, [tenants, tenantSlug]);

  const loadAll = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    try {
      const [invitesRes, tenantsRes] = await Promise.all([
        fetchWithAuth("/api/admin/invites",  session.access_token) as Promise<{ codes:   InviteCode[] }>,
        fetchWithAuth("/api/admin/tenants",  session.access_token) as Promise<{ tenants: TenantSummary[] }>,
      ]);
      setCodes(invitesRes.codes);
      setTenants(tenantsRes.tenants
        .map((t) => ({ id: t.id, slug: t.slug, name: t.name, plan: t.plan }))
        .sort((a, b) => a.slug.localeCompare(b.slug)));
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleGenerate() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    setGenerating(true);
    setError(null);
    setGeneratedCode(null);
    try {
      const body = (await fetchWithAuth("/api/admin/invites", session.access_token, {
        method: "POST",
        body: JSON.stringify({
          email:      inviteEmail.trim(),
          tenantSlug: tenantSlug.trim(),
          tenantName: tenantName.trim() || undefined,
          role,
          plan,
          expiresInDays,
          maxUses,
        }),
      })) as { code: { code: string } };
      setGeneratedCode(body.code.code);
      await loadAll();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleToggle(id: string) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    try {
      await fetchWithAuth(`/api/admin/invites/${id}`, session.access_token, { method: "PATCH" });
      await loadAll();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this invite code?")) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    try {
      await fetchWithAuth(`/api/admin/invites/${id}`, session.access_token, { method: "DELETE" });
      await loadAll();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  function copyCode(code: string) {
    navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  }

  const thStyle: React.CSSProperties = {
    padding: "10px 18px", textAlign: "left", fontSize: 11,
    fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase",
    letterSpacing: "0.06em", whiteSpace: "nowrap",
  };
  const tdStyle: React.CSSProperties = { padding: "12px 18px", fontSize: 13 };
  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "8px 12px", borderRadius: 8,
    background: "var(--surface0)", border: "1px solid var(--surface1)",
    color: "var(--text)", fontSize: 13, outline: "none",
    fontFamily: "var(--font-sans)", boxSizing: "border-box",
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 28px 80px" }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", marginBottom: 4 }}>Invite Codes</h1>
        <p style={{ fontSize: 14, color: "var(--subtext0)" }}>
          Pick an existing org to add a member, or leave the slug blank to invite a new admin who&apos;ll create their org.
        </p>
      </div>

      {error && (
        <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)", color: "var(--red)", fontSize: 13, marginBottom: 24 }}>
          {error}
        </div>
      )}

      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, padding: "24px 24px", marginBottom: 28 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <Plus size={16} /> Generate Code
        </div>

        {/* Row 1: slug combobox + email */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 14 }}>
          <div ref={comboRef} style={{ position: "relative" }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--subtext0)", marginBottom: 6 }}>Org slug</label>
            <div style={{ position: "relative" }}>
              <input
                type="text"
                value={tenantSlug}
                onFocus={() => setComboOpen(true)}
                onChange={(e) => { setTenantSlug(slugify(e.target.value)); setComboOpen(true); }}
                placeholder="Leave blank for new org · or pick existing"
                style={{ ...inputStyle, paddingRight: 30, fontFamily: "var(--font-mono)" }}
              />
              <button
                type="button"
                onClick={() => setComboOpen((v) => !v)}
                style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4, display: "flex" }}
              >
                <ChevronDown size={14} />
              </button>
            </div>
            {comboOpen && filteredTenants.length > 0 && (
              <div style={{
                position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 10,
                background: "var(--mantle)", border: "1px solid var(--surface1)", borderRadius: 8,
                maxHeight: 220, overflowY: "auto", boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
              }}>
                {filteredTenants.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => { setTenantSlug(t.slug); setComboOpen(false); }}
                    style={{
                      width: "100%", textAlign: "left", padding: "8px 12px",
                      background: tenantSlug === t.slug ? "var(--surface0)" : "transparent",
                      border: "none", cursor: "pointer", color: "var(--text)",
                      fontSize: 12, display: "flex", alignItems: "center", gap: 8,
                      fontFamily: "var(--font-sans)",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface0)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = tenantSlug === t.slug ? "var(--surface0)" : "transparent"; }}
                  >
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--blue)", fontWeight: 700 }}>@{t.slug}</span>
                    <span style={{ color: "var(--subtext0)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                    {t.plan && (
                      <span style={{ fontSize: 9, fontWeight: 700, color: PLAN_COLOR[t.plan] ?? "var(--overlay0)", textTransform: "uppercase" }}>
                        {t.plan}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--overlay0)" }}>
              {!slugFilled  && <span style={{ color: "var(--subtext0)" }}>↪ New org · slug chosen by invitee · founder admin</span>}
              {slugFilled && isJoinFlow && (
                <span style={{ color: "var(--blue)" }}>↪ Joins existing <strong>{matchedTenant!.name}</strong></span>
              )}
              {slugFilled && !isJoinFlow && (
                <span style={{ color: "var(--green)" }}>✓ Reserves slug for a new org · founder admin</span>
              )}
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--subtext0)", marginBottom: 6 }}>Invite email</label>
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="user@example.com"
              style={inputStyle}
            />
          </div>
        </div>

        {/* Row 2: role + (plan + name) only when creating new */}
        <div style={{ display: "grid", gridTemplateColumns: isJoinFlow ? "1fr" : "auto 1fr 1fr", gap: 16, marginBottom: 14, alignItems: "end" }}>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--subtext0)", marginBottom: 6 }}>
              Role
              {!isJoinFlow && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--overlay0)", fontWeight: 500 }}>(locked — founder is admin)</span>}
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              {(["admin", "member"] as const).map((r) => {
                const disabled = !isJoinFlow && r === "member";
                const selected = role === r;
                return (
                  <button
                    key={r}
                    onClick={() => { if (!disabled) setRole(r); }}
                    disabled={disabled}
                    title={disabled ? "Member role only applies to existing orgs" : ""}
                    style={{
                      padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 700,
                      border: `1.5px solid ${selected ? ROLE_COLOR[r] : "var(--surface1)"}`,
                      background: selected ? `${ROLE_COLOR[r]}18` : "transparent",
                      color: disabled ? "var(--overlay0)" : (selected ? ROLE_COLOR[r] : "var(--subtext0)"),
                      cursor: disabled ? "not-allowed" : "pointer",
                      opacity: disabled ? 0.4 : 1,
                      textTransform: "capitalize",
                    }}
                  >
                    {r}
                  </button>
                );
              })}
            </div>
          </div>

          {!isJoinFlow && (
            <>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--subtext0)", marginBottom: 6 }}>Plan</label>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["starter", "pro", "enterprise"] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPlan(p)}
                      style={{
                        padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 700,
                        border: `1.5px solid ${plan === p ? PLAN_COLOR[p] : "var(--surface1)"}`,
                        background: plan === p ? `${PLAN_COLOR[p]}18` : "transparent",
                        color: plan === p ? PLAN_COLOR[p] : "var(--subtext0)",
                        cursor: "pointer", textTransform: "capitalize",
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--subtext0)", marginBottom: 6 }}>Org name (optional)</label>
                <input
                  type="text"
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  placeholder="Acme Corp"
                  style={inputStyle}
                />
              </div>
            </>
          )}
        </div>

        {/* Row 3: expiration + max uses + button */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 16, alignItems: "end" }}>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--subtext0)", marginBottom: 6 }}>Expires in (days)</label>
            <input
              type="number"
              min={1}
              max={365}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value) || 90)}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--subtext0)", marginBottom: 6 }}>Max uses</label>
            <input
              type="number"
              min={1}
              max={1000}
              value={maxUses}
              onChange={(e) => setMaxUses(Number(e.target.value) || 1)}
              style={inputStyle}
            />
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating || !inviteEmail.trim()}
            style={{
              padding: "9px 20px", borderRadius: 9, border: "none",
              background: (generating || !inviteEmail.trim()) ? "var(--surface1)" : "linear-gradient(135deg, #1463ff 0%, #0f4ed0 100%)",
              color: (generating || !inviteEmail.trim()) ? "var(--overlay0)" : "#fff",
              fontSize: 13, fontWeight: 700,
              cursor: (generating || !inviteEmail.trim()) ? "not-allowed" : "pointer",
              whiteSpace: "nowrap", fontFamily: "var(--font-sans)",
            }}
          >
            {generating ? "Generating..." : "Generate Code"}
          </button>
        </div>

        {generatedCode && (
          <div style={{
            marginTop: 20, padding: "16px 20px", borderRadius: 10,
            background: "rgba(28,191,107,0.08)", border: "1px solid rgba(28,191,107,0.3)",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--green)", marginBottom: 4 }}>Code generated</div>
              <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--text)", letterSpacing: "0.06em" }}>
                {generatedCode}
              </div>
            </div>
            <button
              onClick={() => copyCode(generatedCode)}
              style={{
                padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(28,191,107,0.3)",
                background: "rgba(28,191,107,0.1)", color: "var(--green)",
                fontSize: 12, fontWeight: 700, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              {copied === generatedCode ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
            </button>
          </div>
        )}
      </div>

      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", gap: 8 }}>
          <Ticket size={15} color="var(--overlay1)" />
          <span style={{ fontSize: 14, fontWeight: 700 }}>All Codes</span>
          <span style={{ fontSize: 12, color: "var(--overlay0)", marginLeft: 4 }}>{codes.length} total</span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--surface0)" }}>
              {["Code", "Email", "Org", "Role", "Plan", "Uses", "Expires", "Status", "Actions"].map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} style={{ padding: "32px 20px", textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>Loading...</td></tr>
            )}
            {!loading && codes.length === 0 && (
              <tr><td colSpan={9} style={{ padding: "32px 20px", textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>No invite codes yet. Generate one above.</td></tr>
            )}
            {codes.map((c) => {
              const status = getStatus(c);
              // Org cell prefers tenant_slug (join flow), then target slug
              // (reserved new), then "any" (founder slug TBD).
              const slug    = c.tenant_slug ?? c.target_tenant_slug ?? null;
              const isJoin  = !!c.tenant_id;
              const r = c.role ?? "admin";
              return (
                <tr key={c.id} style={{ borderBottom: "1px solid var(--surface0)" }}>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <code style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13, letterSpacing: "0.04em" }}>{c.code}</code>
                      <button
                        onClick={() => copyCode(c.code)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "flex" }}
                      >
                        {copied === c.code ? <Check size={12} color="var(--green)" /> : <Copy size={12} />}
                      </button>
                    </div>
                  </td>
                  <td style={{ ...tdStyle, fontSize: 12, color: "var(--subtext0)" }}>
                    {c.email ?? "—"}
                  </td>
                  <td style={{ ...tdStyle, fontSize: 12, fontFamily: "var(--font-mono)" }}>
                    {slug
                      ? <span style={{ color: isJoin ? "var(--blue)" : "var(--green)" }}>@{slug}</span>
                      : <span style={{ color: "var(--overlay0)" }}>any (new)</span>}
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 99,
                      background: `${ROLE_COLOR[r] ?? "#6b7a9e"}18`,
                      color: ROLE_COLOR[r] ?? "#6b7a9e",
                      textTransform: "uppercase",
                    }}>
                      {r}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 99,
                      background: `${PLAN_COLOR[c.plan] ?? "#6b7a9e"}18`,
                      color: PLAN_COLOR[c.plan] ?? "#6b7a9e",
                      textTransform: "uppercase",
                    }}>
                      {c.plan}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, fontSize: 12, color: "var(--subtext0)" }}>
                    {c.used_count} / {c.max_uses}
                  </td>
                  <td style={{ ...tdStyle, fontSize: 12, color: new Date(c.expires_at) < new Date() ? "var(--red)" : "var(--subtext0)" }}>
                    {new Date(c.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 99,
                      background: `${status.color}18`, color: status.color,
                    }}>
                      {status.label}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        onClick={() => handleToggle(c.id)}
                        title={c.active ? "Deactivate" : "Activate"}
                        style={{ background: "none", border: "none", cursor: "pointer", color: c.active ? "var(--green)" : "var(--overlay0)", padding: 4, display: "flex" }}
                      >
                        {c.active ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                      </button>
                      <button
                        onClick={() => handleDelete(c.id)}
                        title="Delete"
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)", padding: 4, display: "flex", opacity: 0.7 }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
