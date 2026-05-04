"use client";

import React, { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import NotificationBell from "./NotificationBell";
import {
  LayoutDashboard,
  Layers,
  Dna,
  LogOut,
  Plug2,
  ChevronDown,
  Wand2,
  KeyRound,
  Terminal,
  Factory as FactoryIcon,
  Store,
  HelpCircle,
  Sparkles,
  Rocket,
  Crown,
  Activity,
  Zap,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useIntegrationStatus } from "@/lib/use-integration-status";
import { brand } from "@/lib/brand";

export type AppSection =
  | "command-center"
  | "studio"
  | "projects"
  | "providers"
  | "storage"
  | "orchestration"
  | "notifications"
  | "dna"
  | "wizard"
  | "api-keys"
  | "knowledge"
  | "mcp-servers"
  | "agents"
  | "admin-access"
  | "settings"
  | "factory-settings"
  | "marketplace"
  | "help"
  | "status"
  | "profile"
  | "cli"
  | "cli-providers"
  | "triggers";

type NavGroup = "factory" | "org" | "config" | "cli" | "marketplace" | "help" | "status";

interface NavItem {
  id: AppSection;
  label: string;
  icon: React.FC<{ size?: number; strokeWidth?: number }>;
  href: string;
  group: NavGroup;
}

const NAV: NavItem[] = [
  { id: "dna",              label: "DNA",             icon: Dna,             href: "/dna",               group: "factory"     },
  { id: "studio",           label: "Studio",          icon: Layers,          href: "/studio",            group: "factory"     },
  { id: "command-center",   label: "Office",          icon: LayoutDashboard, href: "/",                  group: "factory"     },
  { id: "triggers",         label: "Triggers",        icon: Zap,             href: "/triggers",          group: "factory"     },
  { id: "factory-settings", label: "Factory Manager", icon: FactoryIcon,     href: "/factory-settings",  group: "org"         },
  { id: "wizard",           label: "Wizard",          icon: Wand2,           href: "/wizard",            group: "config"      },
  { id: "api-keys",         label: "API Keys",        icon: KeyRound,        href: "/api-keys",          group: "config"      },
  { id: "cli",              label: "CLI",             icon: Terminal,        href: "/cli",               group: "cli"         },
  { id: "marketplace",      label: "Marketplace",     icon: Store,           href: "/marketplace",       group: "marketplace" },
  { id: "help",             label: "User Guides",     icon: HelpCircle,      href: "/help",              group: "help"        },
  { id: "status",           label: "Status",          icon: Activity,        href: "/status",            group: "status"      },
  // "Access" was previously a top-level group "admin" — it's now
  // surfaced inside /profile for OWNER-role users only, to avoid
  // cluttering the nav for everyone.
];

// Groups that render without a separator before them — they visually
// fuse with the previous group. Integrations (within "config") flows
// into CLI, CLI flows into Marketplace, so neither takes a separator.
// Status sits under User Guides without a separator too.
const GROUP_ORDER: NavGroup[] = ["org", "factory", "config", "cli", "marketplace", "help", "status"];
const NO_SEPARATOR_BEFORE: Set<NavGroup> = new Set(["cli", "marketplace", "status"]);

const OWNER_ONLY_GROUPS: NavGroup[] = [];

const INTEGRATION_IDS = new Set<AppSection>([
  "orchestration", "providers", "cli-providers", "storage",
  "notifications", "knowledge", "mcp-servers",
]);

const SIDEBAR_WIDTH = 240;

interface AppSidebarProps {
  active: AppSection;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

/* ── Plan badge ─────────────────────────────────────────────
 * Three buckets for tenant plans (starter/pro/enterprise), plus a
 * special "owner" bucket for platform administrators — they run the
 * platform itself, so their badge sits above the normal tenant plans
 * instead of hiding it behind a plan-tier assumption.
 *
 * planKind() normalises whatever string the tenants.plan column
 * carries (free/basic/pro/team/growth/enterprise/business/…) into
 * one of the three tenant buckets. Hover title surfaces the raw plan
 * name so users can see exactly what the DB has.
 */
type PlanKind = "owner" | "starter" | "pro" | "enterprise";

function planKind(plan: string | null | undefined): Exclude<PlanKind, "owner"> {
  const p = (plan ?? "").toLowerCase();
  if (p.includes("enterprise") || p.includes("business")) return "enterprise";
  if (p.includes("pro") || p.includes("team") || p.includes("growth")) return "pro";
  return "starter";
}

function PlanBadge({
  plan,
  isPlatformAdmin,
}: {
  plan: string | null | undefined;
  isPlatformAdmin?: boolean;
}) {
  const kind: PlanKind = isPlatformAdmin ? "owner" : planKind(plan);
  const label = isPlatformAdmin
    ? "Platform owner"
    : plan ? plan[0]!.toUpperCase() + plan.slice(1) : "Starter";
  const Icon  =
    kind === "owner"      ? Crown    :
    kind === "enterprise" ? Crown    :
    kind === "pro"        ? Rocket   :
                            Sparkles;
  const color =
    kind === "owner"      ? "#f5c542" :
    kind === "enterprise" ? "#f5c542" :
    kind === "pro"        ? "#1463ff" :
                            "var(--overlay1)";
  return (
    <span
      title={kind === "owner" ? "Platform owner — full admin access" : `${label} plan`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        padding: "1px 5px", borderRadius: 4,
        background: "var(--surface0)",
        color,
        fontSize: 9, fontWeight: 800,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        flexShrink: 0,
      }}
    >
      <Icon size={9} strokeWidth={2} />
      {kind}
    </span>
  );
}

/**
 * AppSidebar — always-expanded left navigation.
 *
 * Earlier iterations layered a hover-expanding panel on top of a thin
 * icon rail; it caused visual jank, a `transform` ancestor broke
 * `position: fixed` descendants (notifications rendered on the wrong
 * side), and users couldn't scan submenus without cursor gymnastics.
 * Now the sidebar is a single fixed panel of width SIDEBAR_WIDTH.
 *
 * Submenu behavior is "accordion": only one expandable section is open
 * at a time. Integrations is currently the only one — if a future group
 * grows its own submenu, it should flow through the same
 * `openSection` state so opening it closes the previous.
 */
export default function AppSidebar({ active }: AppSidebarProps) {
  const router = useRouter();

  const {
    tenantId,
    tenantName,
    tenantPlan,
    memberRole,
    factories,
    setActiveFactory,
    factoryId,
    session,
  } = useAuth();
  const isAdmin = memberRole === "admin" || memberRole === "platform_admin";
  // Platform admin lives in tenant_members.role = 'platform_admin' —
  // exactly one user (filipe@tirsa.software in the tirsa-software
  // tenant) holds it. Platform admins get the gold "Platform owner"
  // plan badge that sits above the regular tenant tiers.
  const isPlatformAdmin = memberRole === "platform_admin";
  const integrationAlerts = useIntegrationStatus();

  const factoryAvatarUrl = factories.find((f) => f.id === factoryId)?.avatar ?? null;
  const userMeta = session?.user?.user_metadata as Record<string, unknown> | undefined;
  const userAvatarUrl = userMeta?.avatar_url as string | undefined;
  const userDisplayName = userMeta?.display_name as string | undefined;

  // Update page title + favicon when tenant/factory changes
  useEffect(() => {
    if (!tenantName) return;
    document.title = `${tenantName} | ${brand.name}`;

    if (factoryAvatarUrl) {
      let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
      if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
      link.href = factoryAvatarUrl;
      return;
    }

    const ini = initials(tenantName);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${brand.theme.primary}"/>
        <stop offset="100%" stop-color="${brand.theme.accent}"/>
      </linearGradient></defs>
      <rect width="64" height="64" rx="14" fill="url(#g)"/>
      <text x="32" y="32" dominant-baseline="central" text-anchor="middle"
        font-family="system-ui,sans-serif" font-size="${ini.length > 1 ? 26 : 32}"
        font-weight="800" fill="#fff">${ini}</text>
    </svg>`;
    const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
    link.href = url;
  }, [tenantName, factoryAvatarUrl]);

  const handleLogout = useCallback(async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  }, [router]);

  const visibleGroups = GROUP_ORDER.filter((g) => {
    if (OWNER_ONLY_GROUPS.includes(g) && !isAdmin) return false;
    return NAV.filter((n) => n.group === g).length > 0;
  });

  return (
    <>
      {/* Spacer keeps page layout stable; the real sidebar overlays at fixed position */}
      <div aria-hidden style={{ width: SIDEBAR_WIDTH, flexShrink: 0 }} className="app-sidebar-spacer" />

      <aside
        className="app-sidebar"
        style={{
          position: "fixed", top: 0, left: 0,
          width: SIDEBAR_WIDTH, height: "100vh",
          background: "var(--crust)",
          borderRight: "1px solid var(--surface0)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          zIndex: 50,
        }}
      >
        {/* Hover emphasis + active state live in CSS so every Link/button
         *  picks them up without each call-site repeating the rules. */}
        <style>{`
          .sb-item {
            transition: background 0.12s ease, color 0.12s ease;
            text-decoration: none;
          }
          .sb-item:hover {
            background: var(--surface0);
            color: var(--text);
          }
          .sb-item.sb-item--active {
            background: var(--surface0);
            color: var(--text);
          }
          .sb-subitem:hover {
            background: var(--surface0);
            color: var(--text);
          }
        `}</style>

        {/* ── Header ───────────────────────────────────────── */}
        <div style={{ padding: "20px 16px 16px", borderBottom: "1px solid var(--surface0)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <Link href="/profile" title={tenantName ? `${tenantName} — your profile` : "Your profile"} style={{ textDecoration: "none", flexShrink: 0 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 9,
                background: "var(--tirsa-gradient)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 800, color: "#fff",
                cursor: "pointer", overflow: "hidden",
              }}>
                {userAvatarUrl
                  ? <img src={userAvatarUrl} alt="" style={{ width: 36, height: 36, objectFit: "cover" }} />
                  : tenantName ? initials(tenantName) : "…"}
              </div>
            </Link>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {tenantName ?? "Loading…"}
              </div>
              {userDisplayName && (
                <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {userDisplayName}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
              flex: 1, position: "relative",
              display: "flex", alignItems: "center",
              borderRadius: 8,
              minHeight: 30,
              background: factoryId ? "rgba(20,99,255,0.06)" : "rgba(245,159,0,0.05)",
              border: `1px solid ${factoryId ? "rgba(20,99,255,0.18)" : "rgba(245,159,0,0.2)"}`,
              boxShadow: factoryId
                ? "0 0 12px rgba(20,99,255,0.12), inset 0 0 8px rgba(20,99,255,0.05)"
                : "0 0 12px rgba(245,159,0,0.08), inset 0 0 8px rgba(245,159,0,0.03)",
              overflow: "hidden",
            }}>
              {factoryId && factoryAvatarUrl ? (
                <img src={factoryAvatarUrl} alt="" style={{ width: 16, height: 16, borderRadius: 3, objectFit: "cover", flexShrink: 0, position: "absolute", left: 8, pointerEvents: "none" }} />
              ) : (
                <div style={{
                  width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                  position: "absolute", left: 10, pointerEvents: "none",
                  background: factoryId ? "#1463ff" : "#f59f00",
                  boxShadow: factoryId
                    ? "0 0 6px 2px rgba(20,99,255,0.6), 0 0 12px 4px rgba(20,99,255,0.25)"
                    : "0 0 6px 2px rgba(245,159,0,0.5), 0 0 12px 4px rgba(245,159,0,0.2)",
                }} />
              )}
              <select
                value={factoryId ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "") {
                    if (tenantId) { try { localStorage.setItem(`tirsa_active_factory_${tenantId}`, "__none__"); } catch { /* noop */ } }
                    window.location.href = "/factory-settings";
                  } else {
                    setActiveFactory(val);
                    window.location.reload();
                  }
                }}
                style={{
                  width: "100%",
                  padding: factoryId && factoryAvatarUrl ? "7px 10px 7px 30px" : "7px 10px 7px 24px",
                  background: "transparent", border: "none",
                  color: factoryId ? "#5b9aff" : "#f5c542",
                  fontSize: 10, fontWeight: 700,
                  letterSpacing: "0.04em", textTransform: "uppercase",
                  outline: "none", cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                  appearance: "none", WebkitAppearance: "none",
                }}
              >
                <option value="" style={{ textTransform: "none", color: "var(--text)", background: "var(--crust)" }}>None</option>
                {factories.filter((f) => f.enabled !== false).map((f) => (
                  <option key={f.id} value={f.id} style={{ textTransform: "none", color: "var(--text)", background: "var(--crust)" }}>
                    {f.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} color={factoryId ? "#5b9aff" : "#f5c542"} style={{ position: "absolute", right: 8, pointerEvents: "none" }} />
            </div>
            <NotificationBell />
          </div>
        </div>

        {/* ── Nav ──────────────────────────────────────────── */}
        <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "10px 8px" }}>
          {visibleGroups.map((group, idx) => (
            <React.Fragment key={group}>
              {idx > 0 && !NO_SEPARATOR_BEFORE.has(group) && <PanelSeparator />}
              {NAV.filter((n) => n.group === group).map((item) => (
                <PanelItem
                  key={item.id}
                  href={item.href}
                  label={item.label}
                  icon={item.icon}
                  isActive={active === item.id}
                />
              ))}
              {group === "config" && (
                /* Flat "Integrations" entry — clicking takes the user to
                 * /integrations which redirects to the last visited
                 * integration page (or /orchestration by default). The
                 * vertical rail inside <IntegrationsShell> replaces the
                 * old accordion submenu. */
                <Link
                  href="/integrations"
                  className={`sb-item${INTEGRATION_IDS.has(active) ? " sb-item--active" : ""}`}
                  style={panelItemBaseStyle(INTEGRATION_IDS.has(active))}
                >
                  <Plug2 size={16} strokeWidth={INTEGRATION_IDS.has(active) ? 2 : 1.5} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>Integrations</span>
                  {integrationAlerts.platforms && (
                    <span style={{
                      width: 16, height: 16, borderRadius: 99,
                      background: integrationAlerts.platforms === "red" ? "rgba(228,75,95,0.15)" : "rgba(245,159,0,0.15)",
                      color: integrationAlerts.platforms === "red" ? "var(--red)" : "var(--peach)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, fontWeight: 800, flexShrink: 0,
                    }}>!</span>
                  )}
                </Link>
              )}
            </React.Fragment>
          ))}
        </nav>

        {/* ── Bottom ───────────────────────────────────────── */}
        <div style={{
          padding: "12px 8px",
          borderTop: "1px solid var(--surface0)",
          display: "flex", flexDirection: "column", gap: 2,
        }}>
          {/* Sign out row: button fills the row, plan badge sits at the
           *  far right. Badge was previously next to the org name up
           *  top — moving it here frees the header width and surfaces
           *  the plan at the same vertical spot the user is about to
           *  sign out from. */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={handleLogout}
              className="sb-item"
              style={{ ...panelItemBaseStyle(false, "var(--overlay1)"), flex: 1 }}
            >
              <LogOut size={16} strokeWidth={1.5} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>Sign out</span>
            </button>
            {tenantName && <PlanBadge plan={tenantPlan} isPlatformAdmin={isPlatformAdmin} />}
          </div>
          <div style={{ display: "flex", gap: 10, padding: "6px 8px 2px", flexWrap: "wrap" }}>
            <Link href="/legal/tos"     style={{ fontSize: 10, color: "var(--overlay0)", textDecoration: "none" }} title="Terms of Service">Terms</Link>
            <Link href="/legal/privacy" style={{ fontSize: 10, color: "var(--overlay0)", textDecoration: "none" }} title="Privacy Policy">Privacy</Link>
          </div>
        </div>
      </aside>

      {/* ── Mobile bottom nav ────────────────────── */}
      <nav className="bottom-nav">
        {NAV.filter((n) => n.group === "factory").slice(0, 3).map((item) => {
          const isActive = item.id === active;
          const Icon = item.icon;
          return (
            <Link
              key={item.id}
              href={item.href}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                gap: 3, padding: "8px 0", flex: 1,
                color: isActive ? "var(--blue)" : "var(--overlay1)",
                textDecoration: "none", fontSize: 10,
              }}
            >
              <Icon size={18} strokeWidth={isActive ? 2 : 1.5} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

/* ── Panel pieces ─────────────────────────────────────────── */

function panelItemBaseStyle(isActive: boolean, colorOverride?: string): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 10,
    padding: "0 10px", borderRadius: 7, marginBottom: 1,
    height: 30,
    width: "100%",
    color: colorOverride ?? (isActive ? "var(--text)" : "var(--subtext0)"),
    background: "transparent", border: "none",
    cursor: "pointer", textAlign: "left",
    fontSize: 13, fontWeight: isActive ? 600 : 400,
    fontFamily: "var(--font-sans)",
    borderLeft: isActive ? "2px solid var(--blue)" : "2px solid transparent",
    textDecoration: "none",
  };
}

function PanelItem({ href, label, icon: Icon, isActive }: {
  href: string; label: string;
  icon: React.FC<{ size?: number; strokeWidth?: number; style?: React.CSSProperties }>;
  isActive: boolean;
}) {
  return (
    <Link
      href={href}
      className={`sb-item${isActive ? " sb-item--active" : ""}`}
      style={panelItemBaseStyle(isActive)}
    >
      <Icon size={16} strokeWidth={isActive ? 2 : 1.5} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </Link>
  );
}

function PanelSeparator() {
  return (
    <div style={{ padding: "10px 10px 8px" }}>
      <div style={{ height: 1, background: "var(--surface0)" }} />
    </div>
  );
}
