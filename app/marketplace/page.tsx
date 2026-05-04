"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import AppSidebar from "@/components/AppSidebar";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { brand } from "@/lib/brand";
import Link from "next/link";
import {
  ChevronDown, ChevronRight, Layers, Store,
  CheckSquare, Download, Check, AlertCircle, ShieldCheck, Package,
  Lock,
} from "lucide-react";

/* ─── Types ─────────────────────────────────────────────── */

interface Listing {
  id: string;
  publisher_id: string;
  publisher_name: string;
  category_slug: string;
  name: string;
  description: string | null;
  avatar: string | null;
  price_cents: number;
  currency: string;
  origin: "tirsa" | "community" | "paid";
  installed: boolean;
  transaction_id: string | null;
}

type CatAgent = {
  slug: string; name: string; level: string | null;
  autonomy: string; enabled: boolean;
  squad_name: string; squad_color: string | null;
};

const ORIGIN_COLOR: Record<string, string> = {
  tirsa: "#1463ff",
  community: "#10b981",
  paid: "#f59e0b",
};

const AGENT_ICON: Record<string, string> = {
  intake: "📥", scout: "🔭", research: "🔬", "product-owner": "🎯", finance: "💰",
  monetization: "💳", portfolio: "📁", architect: "🏗", devops: "🚀",
  plm: "📋", spec: "📐", design: "🎨", brand: "✨", eval: "⚖️",
  security: "🛡", compliance: "⚖️", privacy: "🔒", "b2b-sales": "🤝",
  developer: "⚙️", qa: "✅", debt: "🔧", docs: "📝", review: "👁",
  release: "📦", growth: "📈", experiment: "🧪", localization: "🌍",
  data: "📊", "executive-ux": "🖥", commandops: "⚡", support: "🎧",
  incident: "🚨",
};

type ShelfSection = "stores";
// Shelf entries can be either a section toggle (clicking changes the
// in-page view) or an external link (clicking navigates away). Built-In
// is a link — its content lives at /marketplace/stores/built-in (the
// existing store-detail page; same layout and components as any other
// store), so a separate in-page section was just an extra click.
const SHELF_SECTIONS: { id: string; label: string; icon: React.FC<{ size?: number }>; href?: string; section?: ShelfSection }[] = [
  { id: "stores",   label: "Stores",   icon: Store, section: "stores" },
  { id: "built-in", label: "Built-In", icon: Lock,  href: "/marketplace/stores/built-in" },
];

/* ─── Main ──────────────────────────────────────────────── */

export default function MarketplacePage() {
  const router = useRouter();
  const { session, loading: authLoading, refreshFactories } = useAuth();

  const [section, setSection] = useState<ShelfSection>("stores");
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  /** BL-26 / Discovery Slice 3 — slug-clash modal. When set, the install
   *  endpoint returned a 409 with structured conflict info; operator
   *  picks Replace / Cancel / Keep before we re-call. */
  const [conflict, setConflict] = useState<{
    listing: { id: string };
    info: { kind: "agent" | "skill"; slug: string; existing_id: string; existing_name: string; scope: string };
  } | null>(null);
  const [expandedListing, setExpandedListing] = useState<string | null>(null);
  const [catAgents, setCatAgents] = useState<CatAgent[]>([]);
  const [catAgentsLoading, setCatAgentsLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  const loadListings = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    const { data: { session: s } } = await supabase.auth.getSession();
    if (!s) return;
    const res = await fetch("/api/marketplace", {
      headers: { Authorization: `Bearer ${s.access_token}` },
    });
    if (res.ok) {
      const body = await res.json() as { listings: Listing[] };
      setListings(body.listings);
    }
    setLoading(false);
  }, [session]);

  useEffect(() => { loadListings(); }, [loadListings]);

  async function handleInstall(listing: { id: string }, onConflict?: "replace" | "cancel"): Promise<void> {
    setInstalling(listing.id);
    setMessage(null);
    const { data: { session: s } } = await supabase.auth.getSession();
    if (!s) return;
    const res = await fetch("/api/marketplace/install", {
      method: "POST",
      headers: { Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ listingId: listing.id, ...(onConflict ? { onConflict } : {}) }),
    });
    const body = await res.json() as {
      message?: string;
      error?:   string;
      conflict?: { kind: "agent" | "skill"; slug: string; existing_id: string; existing_name: string; scope: string };
    };
    setInstalling(null);
    if (res.ok) {
      setMessage({ type: "success", text: body.message ?? "Installed!" });
      await loadListings();
      await refreshFactories();
    } else if (res.status === 409 && body.conflict) {
      // Surface keep / replace / cancel modal — operator picks, then we
      // re-call with the same listing + their decision.
      setConflict({ listing, info: body.conflict });
      return; // don't clear setMessage yet
    } else {
      setMessage({ type: "error", text: body.error ?? "Install failed" });
    }
    setTimeout(() => setMessage(null), 4000);
  }

  async function loadAgents(_categorySlug: string, listingId: string) {
    if (expandedListing === listingId) { setExpandedListing(null); return; }
    setExpandedListing(listingId);
    setCatAgentsLoading(true);
    const { data: squads } = await supabase.from("squads").select("id, name, color").eq("origin", "built-in").order("display_order");
    if (!squads || squads.length === 0) { setCatAgents([]); setCatAgentsLoading(false); return; }
    const squadIds = squads.map((s) => s.id);
    const { data: agents } = await supabase.from("agent_definitions")
      .select("slug, name, level, autonomy, enabled, squad_id")
      .in("squad_id", squadIds)
      .eq("origin", "built-in")
      .order("name");
    const squadMap = new Map(squads.map((s) => [s.id, s]));
    setCatAgents((agents ?? []).map((a) => {
      const sq = squadMap.get(a.squad_id);
      return { slug: a.slug as string, name: a.name as string, level: a.level as string | null, autonomy: a.autonomy as string, enabled: a.enabled as boolean, squad_name: (sq?.name ?? "") as string, squad_color: (sq?.color ?? null) as string | null };
    }));
    setCatAgentsLoading(false);
  }

  const agentIcon = (slug: string) => AGENT_ICON[slug] ?? "🤖";

  function formatPrice(cents: number, currency: string): string {
    if (cents === 0) return "Free";
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }

  /* ── Listing card (kept for future re-use; not rendered in Stores view) ── */
  function ListingCard({ l }: { l: Listing }) {
    const color = ORIGIN_COLOR[l.origin] ?? "#6b7a9e";
    const isExpanded = expandedListing === l.id;
    const isInstalling = installing === l.id;

    return (
      <div style={{
        borderRadius: 14, overflow: "hidden",
        border: `1.5px solid ${l.installed ? "rgba(28,191,107,0.3)" : `${color}30`}`,
        background: l.installed ? "rgba(28,191,107,0.03)" : `${color}04`,
        transition: "all 0.2s",
      }}>
        <div style={{ padding: "22px 22px 18px" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 12 }}>
            {l.avatar ? (
              <img src={l.avatar} alt="" style={{ width: 40, height: 40, borderRadius: 10, objectFit: "cover", flexShrink: 0 }} />
            ) : (
              <div style={{ width: 40, height: 40, borderRadius: 10, background: `${color}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Layers size={20} color={color} />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 800, fontFamily: "var(--font-heading)", color: "var(--text)", marginBottom: 2 }}>{l.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: "var(--overlay0)" }}>by {l.publisher_name}</span>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: `${color}12`, color, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {l.origin === "tirsa" ? brand.name : l.origin}
                </span>
              </div>
            </div>
            {/* Price */}
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: l.price_cents === 0 ? "var(--green)" : "var(--text)", fontFamily: "var(--font-heading)" }}>
                {formatPrice(l.price_cents, l.currency)}
              </div>
            </div>
          </div>

          {/* Description */}
          {l.description && (
            <p style={{ fontSize: 12, color: "var(--subtext0)", marginBottom: 14, lineHeight: 1.6 }}>{l.description}</p>
          )}

          {/* Actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {l.installed ? (
              <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: "var(--green)", padding: "6px 14px", borderRadius: 8, background: "rgba(28,191,107,0.08)", border: "1px solid rgba(28,191,107,0.2)" }}>
                <CheckSquare size={14} /> Installed
              </span>
            ) : (
              <button
                onClick={() => handleInstall(l)}
                disabled={isInstalling}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "7px 18px", borderRadius: 8, border: "none",
                  background: isInstalling ? "var(--surface1)" : `linear-gradient(135deg, ${color} 0%, ${color}dd 100%)`,
                  color: isInstalling ? "var(--overlay0)" : "#fff",
                  fontSize: 12, fontWeight: 700, cursor: isInstalling ? "not-allowed" : "pointer",
                  fontFamily: "var(--font-sans)",
                }}
              >
                <Download size={13} /> {isInstalling ? "Installing…" : l.price_cents === 0 ? "Install — Free" : `Install — ${formatPrice(l.price_cents, l.currency)}`}
              </button>
            )}
            <button
              onClick={() => loadAgents(l.category_slug, l.id)}
              style={{
                padding: "7px 14px", borderRadius: 8,
                border: `1px solid ${color}30`,
                background: isExpanded ? `${color}10` : "transparent",
                color: isExpanded ? color : "var(--subtext0)",
                fontSize: 11, fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 4,
                fontFamily: "var(--font-sans)",
              }}
            >
              {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Explore agents
            </button>
          </div>
        </div>

        {/* Agent table */}
        {isExpanded && (
          <div style={{ borderTop: `1px solid ${color}15`, background: "var(--crust)", padding: "12px 16px", maxHeight: 320, overflowY: "auto" }}>
            {catAgentsLoading ? (
              <div style={{ textAlign: "center", padding: 16, color: "var(--overlay0)", fontSize: 12 }}>Loading agents…</div>
            ) : catAgents.length === 0 ? (
              <div style={{ textAlign: "center", padding: 16, color: "var(--overlay0)", fontSize: 12 }}>No built-in agents found.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--surface0)" }}>
                    {["", "Agent", "Squad", "Level", "Autonomy"].map((h) => (
                      <th key={h} style={{ padding: "6px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {catAgents.map((a) => (
                    <tr key={a.slug} style={{ borderBottom: "1px solid var(--surface0)" }}>
                      <td style={{ padding: "5px 8px", fontSize: 14, width: 28, textAlign: "center" }}>{agentIcon(a.slug)}</td>
                      <td style={{ padding: "5px 8px", fontWeight: 600, color: "var(--text)" }}>{a.name}</td>
                      <td style={{ padding: "5px 8px" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 99, background: `${a.squad_color ?? "#6b7a9e"}18`, color: a.squad_color ?? "#6b7a9e" }}>{a.squad_name}</span>
                      </td>
                      <td style={{ padding: "5px 8px", color: "var(--subtext0)", fontSize: 11 }}>{a.level ?? "—"}</td>
                      <td style={{ padding: "5px 8px" }}>
                        <span style={{ fontSize: 10, fontWeight: 600, color: a.autonomy === "human" ? "var(--peach)" : "var(--green)" }}>
                          {a.autonomy === "human" ? "🧑 human" : "⚡ auto"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", color: "var(--text)", background: "var(--base)" }}>
      <AppSidebar active="marketplace" />

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left nav — Shelf */}
        <div style={{ width: 180, minWidth: 180, borderRight: "1px solid var(--surface0)", background: "var(--crust)", padding: "16px 8px", overflowY: "auto" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "0 10px", marginBottom: 8 }}>Shelf</div>
          {SHELF_SECTIONS.map(({ id, label, icon: Icon, href, section: targetSection }) => {
            const active = targetSection !== undefined && section === targetSection;
            const sharedStyle: React.CSSProperties = {
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "7px 10px", borderRadius: 7, border: "none",
              background: active ? "var(--surface0)" : "transparent",
              color: active ? "var(--text)" : "var(--subtext0)",
              fontSize: 12, fontWeight: active ? 600 : 400, cursor: "pointer",
              fontFamily: "var(--font-sans)", textAlign: "left",
              borderLeft: active ? "2px solid var(--blue)" : "2px solid transparent",
              textDecoration: "none",
            };
            if (href) {
              return (
                <Link key={id} href={href} style={sharedStyle}>
                  <Icon size={14} /> {label}
                </Link>
              );
            }
            return (
              <button key={id} onClick={() => targetSection && setSection(targetSection)} style={sharedStyle}>
                <Icon size={14} /> {label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
          {/* Message */}
          {message && (
            <div style={{ marginBottom: 16, padding: "10px 16px", borderRadius: 10, fontSize: 13, display: "flex", alignItems: "center", gap: 8, background: message.type === "success" ? "rgba(28,191,107,0.08)" : "rgba(228,75,95,0.08)", border: `1px solid ${message.type === "success" ? "rgba(28,191,107,0.3)" : "rgba(228,75,95,0.3)"}`, color: message.type === "success" ? "var(--green)" : "var(--red)" }}>
              {message.type === "success" ? <Check size={14} /> : <AlertCircle size={14} />} {message.text}
            </div>
          )}

          {section === "stores" && (
            <>
              <div style={{ marginBottom: 24 }}>
                <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--font-heading)", margin: 0 }}>Stores</h1>
                <p style={{ fontSize: 13, color: "var(--subtext0)", margin: "6px 0 0" }}>
                  Organizations publishing factories on {brand.name}. Click a store to browse and import agents.
                </p>
              </div>
              <StoresGrid />
            </>
          )}


        </div>
      </div>

      {conflict && (
        <ConflictModal
          info={conflict.info}
          busy={installing === conflict.listing.id}
          onKeep={() => setConflict(null)}
          onReplace={() => {
            const target = conflict.listing;
            setConflict(null);
            void handleInstall(target, "replace");
          }}
          onCancelInstall={() => {
            const target = conflict.listing;
            setConflict(null);
            void handleInstall(target, "cancel");
          }}
        />
      )}
    </div>
  );
}

/* ─── Conflict modal (Discovery Slice 3) ──────────────────── */

function ConflictModal({
  info, busy, onKeep, onReplace, onCancelInstall,
}: {
  info: { kind: "agent" | "skill"; slug: string; existing_id: string; existing_name: string; scope: string };
  busy: boolean;
  onKeep: () => void;
  onReplace: () => void;
  onCancelInstall: () => void;
}) {
  return (
    <div
      onClick={busy ? undefined : onKeep}
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 460,
          background: "var(--mantle)", border: "1px solid var(--surface0)",
          borderRadius: 14, padding: "22px 24px",
          boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
          fontFamily: "var(--font-sans)", color: "var(--text)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <AlertCircle size={18} color="var(--peach)" />
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: "var(--font-heading)" }}>
            Slug already in use
          </div>
        </div>

        <p style={{ fontSize: 13, color: "var(--subtext0)", lineHeight: 1.55, margin: "0 0 12px" }}>
          A {info.kind} with slug{" "}
          <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{info.slug}</code>{" "}
          already exists in {info.scope}:
        </p>

        <div style={{
          padding: "10px 12px", borderRadius: 8, marginBottom: 16,
          background: "var(--base)", border: "1px solid var(--surface0)",
          fontSize: 12, color: "var(--text)",
        }}>
          <div style={{ fontWeight: 700 }}>{info.existing_name}</div>
          <div style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
            {info.existing_id}
          </div>
        </div>

        <p style={{ fontSize: 11, color: "var(--overlay1)", lineHeight: 1.5, margin: "0 0 16px" }}>
          <strong style={{ color: "var(--text)" }}>Replace</strong> deletes the existing {info.kind} and installs the marketplace version in its place.{" "}
          <strong style={{ color: "var(--text)" }}>Keep existing</strong> closes this dialog and leaves both unchanged.
        </p>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={onCancelInstall}
            disabled={busy}
            style={{
              padding: "7px 14px", borderRadius: 7, border: "1px solid var(--surface1)",
              background: "transparent", color: "var(--subtext0)",
              fontSize: 12, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            Cancel install
          </button>
          <button
            onClick={onKeep}
            disabled={busy}
            style={{
              padding: "7px 14px", borderRadius: 7, border: "1px solid var(--surface1)",
              background: "transparent", color: "var(--text)",
              fontSize: 12, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            Keep existing
          </button>
          <button
            onClick={onReplace}
            disabled={busy}
            style={{
              padding: "7px 14px", borderRadius: 7, border: "none",
              background: busy ? "var(--surface1)" : "var(--red)",
              color: busy ? "var(--overlay0)" : "#fff",
              fontSize: 12, fontWeight: 700, cursor: busy ? "wait" : "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            {busy ? "Replacing…" : "Replace"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Stores Grid (primary marketplace view) ──────────────── */

interface StoreCard {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  avatar: string | null;
  verified: boolean;
  factory_count: number;
  github_owner: string | null;
}

function StoresGrid() {
  const [stores, setStores] = useState<StoreCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not signed in");
        const res = await fetch("/api/marketplace/stores", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const body = (await res.json()) as { stores?: StoreCard[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Request failed");
        setStores(body.stores ?? []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div style={{ padding: "40px 0", textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>;
  if (error) return (
    <div style={{
      padding: "12px 16px", borderRadius: 10,
      background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)",
      color: "var(--red)", fontSize: 13,
    }}>{error}</div>
  );
  if (stores.length === 0) return (
    <div style={{ textAlign: "center", padding: "64px 20px", color: "var(--overlay0)" }}>
      <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.3 }}>🌐</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "var(--subtext1)", marginBottom: 6 }}>No stores yet</div>
      <p style={{ fontSize: 13, maxWidth: 420, margin: "0 auto", lineHeight: 1.6 }}>
        Be the first to publish. Configure a verified Marketplace Repository on one of your factories in Factory Settings, then click Publish.
      </p>
    </div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
      {stores.map((s) => <StoreTile key={s.id} store={s} />)}
    </div>
  );
}

function StoreTile({ store }: { store: StoreCard }) {
  const [imgOk, setImgOk] = useState(true);
  const avatarUrl = store.avatar
    || (store.github_owner ? `https://github.com/${store.github_owner}.png?size=240` : null);

  return (
    <Link href={`/marketplace/stores/${store.slug}`} style={{
      background: "var(--mantle)", border: "1px solid var(--surface0)",
      borderRadius: 10, padding: 10, textDecoration: "none", color: "inherit",
      display: "flex", flexDirection: "column", gap: 8,
      transition: "border-color 0.12s",
    }}>
      {/* Square avatar */}
      <div style={{
        aspectRatio: "1 / 1", width: "100%", borderRadius: 8, overflow: "hidden",
        background: "linear-gradient(135deg, var(--mauve), #6344e0)",
        display: "flex", alignItems: "center", justifyContent: "center",
        position: "relative",
      }}>
        {avatarUrl && imgOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={store.name}
            onError={() => setImgOk(false)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <Store size={36} color="#fff" strokeWidth={1.2} />
        )}
        {store.verified && (
          <div style={{
            position: "absolute", top: 5, right: 5,
            background: "rgba(20,99,255,0.9)", borderRadius: 99,
            padding: 2, display: "flex",
          }}>
            <ShieldCheck size={10} color="#fff" />
          </div>
        )}
      </div>

      {/* Name + slug */}
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {store.name}
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 4,
          fontSize: 10, color: "var(--overlay0)",
        }}>
          <Package size={10} />
          {store.factory_count}
        </div>
      </div>
    </Link>
  );
}

/* ─── Built-In Grid (platform-published listings) ──────────── */

