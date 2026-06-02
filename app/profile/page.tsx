"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { UserCircle2, Mail, ShieldCheck, Save, Check, ChevronRight } from "lucide-react";
import PageShell from "@/components/PageShell";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";

const ROLE_LABEL: Record<string, string> = {
  platform_admin: "Platform Admin",
  admin:          "Admin",
  member:         "Member",
};

const ROLE_COLOR: Record<string, { bg: string; color: string }> = {
  platform_admin: { bg: "rgba(245,197,66,0.15)", color: "#f5c542"      },
  admin:          { bg: "rgba(20,99,255,0.12)",  color: "var(--blue)"  },
  member:         { bg: "var(--surface1)",       color: "var(--overlay0)" },
};

const cardStyle: React.CSSProperties = {
  background: "var(--mantle)",
  border: "1px solid var(--surface1)",
  borderRadius: 10,
  padding: "14px 16px",
};

const labelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: "var(--overlay0)",
  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6,
};

const readonlyValueStyle: React.CSSProperties = {
  fontSize: 13, color: "var(--text)", fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "7px 10px", borderRadius: 6,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 13, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box",
};

const saveBtnStyle = (saved: boolean, busy: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 4,
  padding: "6px 12px", borderRadius: 7, border: "none",
  background: saved ? "rgba(28,191,107,0.12)" : "var(--blue)",
  color: saved ? "var(--green)" : "#fff",
  fontSize: 11, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer",
  fontFamily: "var(--font-sans)", flexShrink: 0,
});

export default function ProfilePage() {
  const router = useRouter();
  const { session, loading, tenantName, factoryName, factoryId, memberRole, factories, refreshFactories } = useAuth();

  const [avatarUrl, setAvatarUrl] = useState("");
  const [userAvatarUrl, setUserAvatarUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [userSaving, setUserSaving] = useState(false);
  const [userSaved, setUserSaved] = useState(false);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  useEffect(() => {
    if (!loading && !session) router.replace("/login");
  }, [loading, session, router]);

  useEffect(() => {
    const active = factories.find((f) => f.id === factoryId);
    setAvatarUrl(active?.avatar ?? "");
  }, [factories, factoryId]);

  useEffect(() => {
    const meta = session?.user?.user_metadata as Record<string, unknown> | undefined;
    setUserAvatarUrl((meta?.avatar_url as string) ?? "");
    setDisplayName((meta?.display_name as string) ?? "");
  }, [session]);

  async function saveDisplayName() {
    setNameSaving(true);
    await supabase.auth.updateUser({ data: { display_name: displayName.trim() || null } });
    setNameSaving(false);
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  }

  async function saveUserAvatar() {
    setUserSaving(true);
    await supabase.auth.updateUser({ data: { avatar_url: userAvatarUrl.trim() || null } });
    setUserSaving(false);
    setUserSaved(true);
    setTimeout(() => setUserSaved(false), 2000);
  }

  async function saveAvatar() {
    if (!factoryId) return;
    setSaving(true);
    await supabase.from("factories").update({ avatar: avatarUrl.trim() || null }).eq("id", factoryId);
    await refreshFactories();
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const email = session?.user?.email ?? "—";
  const role  = memberRole ?? "member";
  const roleColors = ROLE_COLOR[role] ?? ROLE_COLOR.member;

  return (
    <PageShell active="profile" maxWidth={840}>
      {/* Header — avatar + Profile title + role badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14, flexShrink: 0,
          background: "linear-gradient(135deg, #1463ff, #00c2a8)",
          display: "flex", alignItems: "center", justifyContent: "center",
          overflow: "hidden",
        }}>
          {userAvatarUrl ? (
            <img src={userAvatarUrl} alt="" style={{ width: 56, height: 56, objectFit: "cover" }} />
          ) : (
            <UserCircle2 size={28} color="#fff" strokeWidth={1.5} />
          )}
        </div>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--font-heading)", marginBottom: 4 }}>
            <span>Profile</span>
          </h1>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99,
            background: roleColors.bg, color: roleColors.color,
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            <span>{ROLE_LABEL[role] ?? role}</span>
          </span>
        </div>
      </div>

      {loading ? (
        <div style={{ color: "var(--subtext0)", fontSize: 14 }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Identity card — name + email + role on one card */}
          <div style={cardStyle}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 0.8fr", gap: 16, alignItems: "end" }}>
              <div>
                <div style={labelStyle}>Name</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    value={displayName}
                    onChange={(e) => { setDisplayName(e.target.value); setNameSaved(false); }}
                    placeholder="Your name"
                    style={inputStyle}
                  />
                  <button onClick={saveDisplayName} disabled={nameSaving} style={saveBtnStyle(nameSaved, nameSaving)}>
                    {nameSaved ? <><Check size={12} /> Saved</> : <><Save size={12} /> Save</>}
                  </button>
                </div>
              </div>
              <div>
                <div style={labelStyle}>Email</div>
                <div style={{ ...readonlyValueStyle, display: "flex", alignItems: "center", gap: 6 }}>
                  <Mail size={13} color="var(--overlay0)" />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
                </div>
              </div>
              <div>
                <div style={labelStyle}>Role</div>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 99,
                  background: roleColors.bg, color: roleColors.color,
                }}>
                  <ShieldCheck size={11} />
                  <span>{ROLE_LABEL[role] ?? role}</span>
                </span>
              </div>
            </div>
          </div>

          {/* Avatars card — your avatar + factory avatar side by side */}
          <div style={cardStyle}>
            <div style={{ display: "grid", gridTemplateColumns: factoryId ? "1fr 1fr" : "1fr", gap: 16 }}>
              <div>
                <div style={labelStyle}>Your avatar</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {userAvatarUrl ? (
                    <img src={userAvatarUrl} alt="" style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: "1px solid var(--surface1)" }} />
                  ) : (
                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--surface0)", border: "1px solid var(--surface1)", flexShrink: 0 }} />
                  )}
                  <input
                    value={userAvatarUrl}
                    onChange={(e) => { setUserAvatarUrl(e.target.value); setUserSaved(false); }}
                    placeholder="https://example.com/photo.jpg"
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 11 }}
                  />
                  <button onClick={saveUserAvatar} disabled={userSaving} style={saveBtnStyle(userSaved, userSaving)}>
                    {userSaved ? <><Check size={12} /> Saved</> : <><Save size={12} /> Save</>}
                  </button>
                </div>
              </div>
              {factoryId && (
                <div>
                  <div style={labelStyle}>Factory avatar</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: "cover", flexShrink: 0, border: "1px solid var(--surface1)" }} />
                    ) : (
                      <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--surface0)", border: "1px solid var(--surface1)", flexShrink: 0 }} />
                    )}
                    <input
                      value={avatarUrl}
                      onChange={(e) => { setAvatarUrl(e.target.value); setSaved(false); }}
                      placeholder="https://example.com/logo.png"
                      style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 11 }}
                    />
                    <button onClick={saveAvatar} disabled={saving} style={saveBtnStyle(saved, saving)}>
                      {saved ? <><Check size={12} /> Saved</> : <><Save size={12} /> Save</>}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Workspace card — organization + factory side by side, read-only */}
          <div style={cardStyle}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div>
                <div style={labelStyle}>Organization</div>
                <div style={readonlyValueStyle}>
                  <span>{tenantName ?? "—"}</span>
                </div>
              </div>
              <div>
                <div style={labelStyle}>Factory</div>
                <div style={readonlyValueStyle}>
                  <span>{factoryName ?? "—"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Admin card — platform-admin-only, separate (renamed from "Access") */}
          {role === "platform_admin" && (
            <Link
              href="/admin"
              style={{
                ...cardStyle,
                display: "flex", alignItems: "center", gap: 12,
                textDecoration: "none", color: "inherit",
                transition: "background 0.12s ease",
                marginTop: 8,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface0)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--mantle)"; }}
            >
              <div style={{ color: "var(--overlay1)", flexShrink: 0 }}><ShieldCheck size={15} /></div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                  <span>Admin</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 2 }}>
                  <span>Invite members, manage roles, review audit log.</span>
                </div>
              </div>
              <ChevronRight size={16} style={{ color: "var(--overlay0)", flexShrink: 0 }} />
            </Link>
          )}
        </div>
      )}
    </PageShell>
  );
}
