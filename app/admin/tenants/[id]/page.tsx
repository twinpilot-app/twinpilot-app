"use client";

import React, { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { brand } from "@/lib/brand";
import { ChevronLeft, Users, Factory, FolderOpen, Activity, DollarSign, AlertTriangle, Trash2, X, KeyRound } from "lucide-react";

const PLAN_COLOR: Record<string, string> = {
  starter: "#6b7a9e", pro: "#1463ff", enterprise: "#00c2a8", owner: "#a78bfa",
};

const PLANS = ["starter", "pro", "enterprise", "owner"];

interface Member {
  id: string; user_id: string; role: string; created_at: string; email?: string | null;
}
interface TenantFactory {
  id: string; name: string; slug: string; created_at: string;
}
interface Project {
  id: string; name: string; factory_id: string; created_at: string;
}
interface Run {
  id: string; agent: string; status: string; cost_usd: number | null;
  started_at: string; finished_at: string | null; project_id: string;
}
interface TenantDetail {
  id: string; name: string; slug: string; plan: string; created_at: string; suspended?: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  completed: "#00c2a8", running: "#1463ff", failed: "#e44b5f",
  pending: "#6b7a9e", cancelled: "#6b7a9e",
};

export default function AdminTenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [tenant,    setTenant]    = useState<TenantDetail | null>(null);
  const [members,   setMembers]   = useState<Member[]>([]);
  const [factories, setFactories] = useState<TenantFactory[]>([]);
  const [projects,  setProjects]  = useState<Project[]>([]);
  const [runs,      setRuns]      = useState<Run[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  const [planEdit,   setPlanEdit]   = useState("");
  const [saving,     setSaving]     = useState(false);
  const [actionMsg,  setActionMsg]  = useState<string | null>(null);
  const [deleting,   setDeleting]   = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.replace("/login"); return; }
      const res = await fetch(`/api/admin/tenants/${id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const body = await res.json() as {
          tenant: TenantDetail; members: Member[]; factories: TenantFactory[];
          projects: Project[]; recentRuns: Run[]; totalCost: number;
        };
        setTenant(body.tenant);
        setPlanEdit(body.tenant.plan);
        setMembers(body.members);
        setFactories(body.factories);
        setProjects(body.projects);
        setRuns(body.recentRuns);
        setTotalCost(body.totalCost);
      } else {
        setError("Failed to load tenant.");
      }
      setLoading(false);
    });
  }, [id, router]);

  async function patch(update: { plan?: string; suspended?: boolean }) {
    setSaving(true); setActionMsg(null);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/admin/tenants/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    setSaving(false);
    if (res.ok) {
      if (update.plan)       setTenant((t) => t ? { ...t, plan: update.plan! } : t);
      if (update.suspended !== undefined) setTenant((t) => t ? { ...t, suspended: update.suspended } : t);
      setActionMsg("Saved.");
      setTimeout(() => setActionMsg(null), 3000);
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string };
      setActionMsg(`Error: ${body.error ?? "saving"}`);
    }
  }

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmSlug, setDeleteConfirmSlug] = useState("");
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState<{ userId: string; password: string; email: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function deleteTenant() {
    setDeleting(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/admin/tenants/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    setDeleting(false);
    if (res.ok) {
      router.replace("/admin/tenants");
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string };
      setActionMsg(`Delete failed: ${body.error ?? "unknown error"}`);
      setShowDeleteModal(false);
    }
  }

  async function handleResetPassword() {
    if (!resetUserId || resetPassword.length < 8) return;
    setResetting(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/admin/tenants/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ resetPassword: { userId: resetUserId, newPassword: resetPassword } }),
    });
    setResetting(false);
    if (res.ok) {
      const member = members.find((m) => m.user_id === resetUserId);
      setResetDone({ userId: resetUserId, password: resetPassword, email: member?.email ?? resetUserId });
      setResetUserId(null);
      setResetPassword("");
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string };
      setActionMsg(`Reset failed: ${body.error ?? "unknown"}`);
    }
  }

  function copyCredentials() {
    if (!resetDone || !tenant) return;
    const text = `Your ${brand.name} credentials have been reset.\n\nLogin: ${window.location.origin}/login\nEmail: ${resetDone.email}\nPassword: ${resetDone.password}\nTenant: ${tenant.name} (${tenant.slug})`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const cell: React.CSSProperties = { padding: "12px 18px", fontSize: 13, color: "var(--subtext1)", borderBottom: "1px solid var(--surface0)" };
  const hcell: React.CSSProperties = { padding: "9px 18px", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid var(--surface0)", textAlign: "left" };

  if (loading) {
    return <div style={{ padding: 60, textAlign: "center", color: "var(--overlay0)", fontSize: 14 }}>Loading…</div>;
  }
  if (error || !tenant) {
    return <div style={{ padding: 60, textAlign: "center", color: "var(--red)", fontSize: 14 }}>{error ?? "Tenant not found."}</div>;
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 28px 80px" }}>

      {/* Back */}
      <a href="/admin/tenants" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: "var(--blue)", textDecoration: "none", marginBottom: 24 }}>
        <ChevronLeft size={14} /> All Tenants
      </a>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 32, gap: 20 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <h1 style={{ fontSize: 24, fontWeight: 800, fontFamily: "var(--font-heading)", margin: 0 }}>{tenant.name}</h1>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: "2px 10px", borderRadius: 99,
              background: `${PLAN_COLOR[tenant.plan] ?? "#6b7a9e"}18`,
              color: PLAN_COLOR[tenant.plan] ?? "#6b7a9e", textTransform: "uppercase",
            }}>{tenant.plan}</span>
            {tenant.suspended && (
              <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, color: "var(--red)", textTransform: "uppercase" }}>
                <AlertTriangle size={12} /> Suspended
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>/{tenant.slug}</div>
          <div style={{ fontSize: 12, color: "var(--overlay0)", marginTop: 4 }}>
            Joined {new Date(tenant.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {/* Plan selector */}
          <select
            value={planEdit}
            onChange={(e) => setPlanEdit(e.target.value)}
            style={{
              padding: "8px 12px", borderRadius: 8, fontSize: 13,
              background: "var(--mantle)", border: "1px solid var(--surface1)",
              color: "var(--text)", fontFamily: "var(--font-sans)", cursor: "pointer",
            }}
          >
            {PLANS.map((p) => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
          </select>
          <button
            disabled={saving || planEdit === tenant.plan}
            onClick={() => patch({ plan: planEdit })}
            style={{
              padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: planEdit !== tenant.plan ? "var(--blue)" : "var(--surface0)",
              color: planEdit !== tenant.plan ? "#fff" : "var(--overlay0)",
              border: "none", opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? "Saving…" : "Change plan"}
          </button>

          {/* Suspend / Unsuspend */}
          <button
            disabled={saving}
            onClick={() => patch({ suspended: !tenant.suspended })}
            style={{
              padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: tenant.suspended ? "rgba(0,194,168,0.12)" : "rgba(228,75,95,0.12)",
              color: tenant.suspended ? "var(--teal)" : "var(--red)",
              border: `1px solid ${tenant.suspended ? "rgba(0,194,168,0.3)" : "rgba(228,75,95,0.3)"}`,
              opacity: saving ? 0.6 : 1,
            }}
          >
            {tenant.suspended ? "Unsuspend" : "Suspend"}
          </button>

          {/* Delete */}
          <button
            onClick={() => { setShowDeleteModal(true); setDeleteConfirmSlug(""); }}
            style={{
              padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: "rgba(228,75,95,0.08)",
              color: "var(--red)",
              border: "1px solid rgba(228,75,95,0.25)",
              display: "flex", alignItems: "center", gap: 6,
            }}
          >
            <Trash2 size={13} /> Delete
          </button>

          {actionMsg && <span style={{ fontSize: 12, color: "var(--overlay0)" }}>{actionMsg}</span>}
        </div>
      </div>

      {/* Password reset credentials banner */}
      {resetDone && (
        <div style={{
          marginBottom: 20, padding: "14px 18px", borderRadius: 10,
          background: "rgba(28,191,107,0.06)", border: "1px solid rgba(28,191,107,0.25)",
          display: "flex", alignItems: "center", gap: 14,
        }}>
          <KeyRound size={16} color="var(--green)" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--green)", marginBottom: 4 }}>Password reset for {resetDone.email}</div>
            <div style={{ fontSize: 12, color: "var(--subtext0)" }}>
              New password: <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: "var(--text)", background: "var(--surface0)", padding: "2px 6px", borderRadius: 4 }}>{resetDone.password}</code>
            </div>
          </div>
          <button onClick={copyCredentials} style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "6px 14px", borderRadius: 7, border: "1px solid rgba(28,191,107,0.3)",
            background: copied ? "rgba(28,191,107,0.12)" : "transparent",
            color: "var(--green)", fontSize: 11, fontWeight: 700,
            cursor: "pointer", fontFamily: "var(--font-sans)", whiteSpace: "nowrap",
          }}>
            {copied ? "Copied!" : "Copy credentials"}
          </button>
          <button onClick={() => setResetDone(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4, display: "flex" }}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* Stat strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 32 }}>
        {[
          { icon: Users,     label: "Members",   value: members.length,   color: "#1463ff" },
          { icon: Factory,   label: "Factories", value: factories.length, color: "#00c2a8" },
          { icon: FolderOpen,label: "Projects",  value: projects.length,  color: "#a78bfa" },
          { icon: DollarSign,label: "LLM Cost",  value: `$${totalCost.toFixed(2)}`, color: "#f59f00" },
        ].map(({ icon: Icon, label, value, color }) => (
          <div key={label} style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 12, padding: "16px 18px", display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, background: `${color}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon size={16} color={color} />
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", color: "var(--text)", lineHeight: 1.1 }}>{value}</div>
              <div style={{ fontSize: 12, color: "var(--overlay0)", marginTop: 1 }}>{label}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>

        {/* Members */}
        <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", gap: 8 }}>
            <Users size={14} color="var(--overlay0)" />
            <span style={{ fontSize: 13, fontWeight: 700 }}>Members</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={hcell}>Email</th>
                <th style={hcell}>Role</th>
                <th style={hcell}>Joined</th>
                <th style={hcell}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 && (
                <tr><td colSpan={4} style={{ ...cell, textAlign: "center", color: "var(--overlay0)" }}>No members</td></tr>
              )}
              {members.map((m) => (
                <tr key={m.id}>
                  <td style={{ ...cell, fontSize: 12 }}>
                    {m.email ?? <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--overlay0)" }}>{m.user_id.slice(0, 8)}…</span>}
                  </td>
                  <td style={cell}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99, textTransform: "uppercase",
                      background: m.role === "platform_admin" ? "rgba(245,197,66,0.15)" : m.role === "admin" ? "rgba(167,139,250,0.12)" : "rgba(107,122,158,0.12)",
                      color: m.role === "platform_admin" ? "#f5c542" : m.role === "admin" ? "#a78bfa" : "#6b7a9e",
                    }}>{m.role}</span>
                  </td>
                  <td style={{ ...cell, fontSize: 12, color: "var(--overlay0)" }}>{new Date(m.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                  <td style={cell}>
                    {resetUserId === m.user_id ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && resetPassword.length >= 8) handleResetPassword(); }}
                          type="text"
                          placeholder="New password (min 8)"
                          autoFocus
                          style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--surface1)", background: "var(--surface0)", color: "var(--text)", fontSize: 11, outline: "none", fontFamily: "var(--font-mono)", width: 150 }}
                        />
                        <button onClick={handleResetPassword} disabled={resetting || resetPassword.length < 8}
                          style={{ padding: "3px 8px", borderRadius: 5, border: "none", background: resetPassword.length >= 8 ? "#1463ff" : "var(--surface1)", color: resetPassword.length >= 8 ? "#fff" : "var(--overlay0)", fontSize: 10, fontWeight: 700, cursor: resetPassword.length >= 8 ? "pointer" : "not-allowed", fontFamily: "var(--font-sans)" }}>
                          {resetting ? "…" : "Set"}
                        </button>
                        <button onClick={() => { setResetUserId(null); setResetPassword(""); }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "flex" }}>
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => { setResetUserId(m.user_id); setResetPassword(""); }}
                        title="Reset password"
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4, display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontFamily: "var(--font-sans)" }}>
                        <KeyRound size={12} /> Reset pwd
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Factories */}
        <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", gap: 8 }}>
            <Factory size={14} color="var(--overlay0)" />
            <span style={{ fontSize: 13, fontWeight: 700 }}>Factories</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={hcell}>Name</th>
                <th style={hcell}>Slug</th>
                <th style={hcell}>Created</th>
              </tr>
            </thead>
            <tbody>
              {factories.length === 0 && (
                <tr><td colSpan={3} style={{ ...cell, textAlign: "center", color: "var(--overlay0)" }}>No factories</td></tr>
              )}
              {factories.map((f) => (
                <tr key={f.id}>
                  <td style={{ ...cell, fontWeight: 600 }}>{f.name}</td>
                  <td style={{ ...cell, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--overlay0)" }}>{f.slug}</td>
                  <td style={{ ...cell, fontSize: 12, color: "var(--overlay0)" }}>{new Date(f.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent agent runs */}
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", gap: 8 }}>
          <Activity size={14} color="var(--overlay0)" />
          <span style={{ fontSize: 13, fontWeight: 700 }}>Recent Agent Runs</span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--overlay0)" }}>Last 50</span>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={hcell}>Agent</th>
              <th style={hcell}>Status</th>
              <th style={hcell}>Cost</th>
              <th style={hcell}>Started</th>
              <th style={hcell}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr><td colSpan={5} style={{ ...cell, textAlign: "center", color: "var(--overlay0)" }}>No runs</td></tr>
            )}
            {runs.map((r) => {
              const dur = r.finished_at && r.started_at
                ? Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)
                : null;
              return (
                <tr key={r.id}>
                  <td style={{ ...cell, fontWeight: 600, fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.agent}</td>
                  <td style={cell}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99, textTransform: "uppercase",
                      background: `${STATUS_COLOR[r.status] ?? "#6b7a9e"}18`,
                      color: STATUS_COLOR[r.status] ?? "#6b7a9e",
                    }}>{r.status}</span>
                  </td>
                  <td style={{ ...cell, fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : "—"}
                  </td>
                  <td style={{ ...cell, fontSize: 12, color: "var(--overlay0)", whiteSpace: "nowrap" }}>
                    {new Date(r.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{" "}
                    {new Date(r.started_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td style={{ ...cell, fontSize: 12, color: "var(--overlay0)" }}>
                    {dur != null ? (dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && tenant && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 440, background: "var(--mantle)", border: "1px solid rgba(228,75,95,0.3)", borderRadius: 14, padding: "24px", boxShadow: "0 32px 80px rgba(0,0,0,0.5)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AlertTriangle size={18} color="var(--red)" />
                <span style={{ fontSize: 16, fontWeight: 800, color: "var(--red)", fontFamily: "var(--font-heading)" }}>Delete Tenant</span>
              </div>
              <button onClick={() => setShowDeleteModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4, display: "flex" }}>
                <X size={16} />
              </button>
            </div>

            <p style={{ fontSize: 13, color: "var(--subtext1)", lineHeight: 1.6, marginBottom: 8 }}>
              This will <strong style={{ color: "var(--red)" }}>permanently delete</strong> the tenant <strong style={{ color: "var(--text)" }}>{tenant.name}</strong> and all its data:
            </p>
            <ul style={{ fontSize: 12, color: "var(--subtext0)", lineHeight: 1.8, marginBottom: 16, paddingLeft: 18 }}>
              <li>All factories, projects, and sprints</li>
              <li>All custom squads, agents, and pipelines</li>
              <li>All integrations, API keys, and knowledge bases</li>
              <li>All marketplace transactions</li>
              <li>All member associations</li>
            </ul>

            <p style={{ fontSize: 13, color: "var(--subtext1)", marginBottom: 8 }}>
              To confirm, type the tenant slug: <code style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, color: "var(--red)", background: "rgba(228,75,95,0.08)", padding: "2px 6px", borderRadius: 4 }}>{tenant.slug}</code>
            </p>

            <input
              value={deleteConfirmSlug}
              onChange={(e) => setDeleteConfirmSlug(e.target.value)}
              placeholder={tenant.slug}
              autoFocus
              style={{
                width: "100%", padding: "10px 14px", borderRadius: 8,
                background: "var(--surface0)", border: `1px solid ${deleteConfirmSlug === tenant.slug ? "rgba(228,75,95,0.5)" : "var(--surface1)"}`,
                color: "var(--text)", fontSize: 14, fontFamily: "var(--font-mono)",
                outline: "none", boxSizing: "border-box", marginBottom: 16,
              }}
            />

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowDeleteModal(false)} style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                Cancel
              </button>
              <button
                onClick={deleteTenant}
                disabled={deleteConfirmSlug !== tenant.slug || deleting}
                style={{
                  padding: "8px 18px", borderRadius: 8, border: "none",
                  background: deleteConfirmSlug === tenant.slug && !deleting ? "var(--red)" : "var(--surface1)",
                  color: deleteConfirmSlug === tenant.slug && !deleting ? "#fff" : "var(--overlay0)",
                  fontSize: 13, fontWeight: 700, cursor: deleteConfirmSlug === tenant.slug && !deleting ? "pointer" : "not-allowed",
                  fontFamily: "var(--font-sans)",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                <Trash2 size={13} /> {deleting ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
