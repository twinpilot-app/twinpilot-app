"use client";

import React, { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { brand } from "@/lib/brand";
import { Terminal, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

interface Factory { id: string; name: string; slug: string }
interface Tenant  { id: string; name: string; slug: string; factories: Factory[] }

export default function CliAuthPage() {
  return (
    <Suspense fallback={<div style={centeredPage}><Loader2 size={24} color="var(--overlay0)" style={{ animation: "spin 1s linear infinite" }} /></div>}>
      <CliAuthInner />
    </Suspense>
  );
}

function CliAuthInner() {
  const params  = useSearchParams();
  const router  = useRouter();
  const state   = params.get("state") ?? "";
  const port    = params.get("port")  ?? "";

  const [tenants,         setTenants]         = useState<Tenant[]>([]);
  const [selectedTenant,  setSelectedTenant]  = useState<Tenant | null>(null);
  const [selectedFactory, setSelectedFactory] = useState<Factory | null>(null);
  const [loading,         setLoading]         = useState(true);
  const [authorizing,     setAuthorizing]     = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [done,            setDone]            = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        const next = encodeURIComponent(`/cli-auth?state=${state}&port=${port}`);
        router.replace(`/login?next=${next}`);
        return;
      }

      // Load all tenants the user belongs to, with their factories
      const { data: memberships } = await supabase
        .from("tenant_members")
        .select("tenant_id")
        .eq("user_id", session.user.id);

      const tenantIds = (memberships ?? []).map((m) => m.tenant_id as string);
      if (tenantIds.length === 0) { setLoading(false); return; }

      const { data: tenantRows } = await supabase
        .from("tenants")
        .select("id, name, slug")
        .in("id", tenantIds);

      const { data: factoryRows } = await supabase
        .from("factories")
        .select("id, name, slug, tenant_id")
        .in("tenant_id", tenantIds);

      const built: Tenant[] = (tenantRows ?? []).map((t) => ({
        ...t,
        factories: (factoryRows ?? []).filter((f) => f.tenant_id === t.id),
      }));

      setTenants(built);
      if (built[0]) {
        setSelectedTenant(built[0]);
        setSelectedFactory(built[0].factories[0] ?? null);
      }
      setLoading(false);
    });
  }, [router, state, port]);

  async function authorize() {
    if (!selectedTenant || !selectedFactory) return;
    setAuthorizing(true); setError(null);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setError("Session expired. Please log in again."); setAuthorizing(false); return; }

    try {
      const res = await fetch("/api/cli/token", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tenantId: selectedTenant.id, factorySlug: selectedFactory.slug }),
      });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? "Failed to issue token");
      }

      const { apiKey, tenantSlug, factorySlug, email } = await res.json() as {
        apiKey: string; tenantSlug: string; factorySlug: string; email: string;
      };

      // Redirect to local CLI callback
      const callbackUrl = new URL(`http://127.0.0.1:${port}/callback`);
      callbackUrl.searchParams.set("state",   state);
      callbackUrl.searchParams.set("apiKey",  apiKey);
      callbackUrl.searchParams.set("tenant",  tenantSlug);
      callbackUrl.searchParams.set("factory", factorySlug);
      callbackUrl.searchParams.set("email",   email ?? "");

      setDone(true);
      // Small delay so user sees the success state before redirect closes the tab
      setTimeout(() => { window.location.href = callbackUrl.toString(); }, 800);
    } catch (e: unknown) {
      setError((e as Error).message);
      setAuthorizing(false);
    }
  }

  if (loading) {
    return (
      <div style={centeredPage}>
        <Loader2 size={24} color="var(--overlay0)" style={{ animation: "spin 1s linear infinite" }} />
      </div>
    );
  }

  if (done) {
    return (
      <div style={centeredPage}>
        <div style={card}>
          <CheckCircle2 size={40} color="#00c2a8" style={{ marginBottom: 16 }} />
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Authenticated</div>
          <div style={{ fontSize: 13, color: "var(--subtext0)" }}>You can close this window and return to the terminal.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={centeredPage}>
      <div style={card}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "rgba(20,99,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Terminal size={22} color="#1463ff" />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Authorize {brand.shortName} CLI</div>
            <div style={{ fontSize: 12, color: "var(--subtext0)", marginTop: 2 }}>Select a workspace to connect</div>
          </div>
        </div>

        {tenants.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--subtext0)", textAlign: "center", padding: "20px 0" }}>
            No workspaces found. <a href="/onboard" style={{ color: "var(--blue)" }}>Create one first.</a>
          </div>
        ) : (
          <>
            {/* Tenant selector */}
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Workspace</label>
              <select
                value={selectedTenant?.id ?? ""}
                onChange={(e) => {
                  const t = tenants.find((x) => x.id === e.target.value) ?? null;
                  setSelectedTenant(t);
                  setSelectedFactory(t?.factories[0] ?? null);
                }}
                style={selectStyle}
              >
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.slug})</option>)}
              </select>
            </div>

            {/* Factory selector */}
            <div style={{ marginBottom: 24 }}>
              <label style={labelStyle}>Factory</label>
              <select
                value={selectedFactory?.slug ?? ""}
                onChange={(e) => {
                  const f = selectedTenant?.factories.find((x) => x.slug === e.target.value) ?? null;
                  setSelectedFactory(f);
                }}
                style={selectStyle}
              >
                {(selectedTenant?.factories ?? []).map((f) => (
                  <option key={f.id} value={f.slug}>{f.name} ({f.slug})</option>
                ))}
              </select>
            </div>

            {/* Preview */}
            {selectedTenant && selectedFactory && (
              <div style={{
                padding: "10px 14px", borderRadius: 8, marginBottom: 20,
                background: "var(--surface0)", border: "1px solid var(--surface1)",
                fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--subtext1)",
                lineHeight: 1.8,
              }}>
                <div><span style={{ color: "#00c2a8" }}>TIRSA_TENANT</span>=<span style={{ color: "#a78bfa" }}>{selectedTenant.slug}</span></div>
                <div><span style={{ color: "#00c2a8" }}>TIRSA_FACTORY</span>=<span style={{ color: "#a78bfa" }}>{selectedFactory.slug}</span></div>
              </div>
            )}

            {error && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, marginBottom: 16, background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)", color: "var(--red)", fontSize: 13 }}>
                <AlertCircle size={13} /> {error}
              </div>
            )}

            <button
              onClick={authorize}
              disabled={authorizing || !selectedTenant || !selectedFactory}
              style={{
                width: "100%", padding: "11px", borderRadius: 10, border: "none",
                background: "#1463ff", color: "#fff", fontSize: 14, fontWeight: 700,
                cursor: authorizing ? "not-allowed" : "pointer", opacity: authorizing ? 0.7 : 1,
                fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              {authorizing ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Authorizing…</> : "Authorize CLI"}
            </button>

            <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "center", marginTop: 12 }}>
              This grants the CLI access to run pipelines in this workspace.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const centeredPage: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  minHeight: "100vh", width: "100%", flex: 1,
  background: "var(--base)", fontFamily: "var(--font-sans)", color: "var(--text)",
};

const card: React.CSSProperties = {
  background: "var(--mantle)", border: "1px solid var(--surface0)",
  borderRadius: 18, padding: "32px 28px", width: "100%", maxWidth: 400,
};

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 600, color: "var(--subtext1)", marginBottom: 6,
};

const selectStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8, fontSize: 13,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontFamily: "var(--font-sans)", cursor: "pointer", boxSizing: "border-box",
};
