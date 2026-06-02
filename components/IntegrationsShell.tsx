"use client";

import React, { useEffect } from "react";
import Link from "next/link";
import {
  Zap,
  Cpu,
  Bot,
  HardDrive,
  Bell,
  Brain,
  Wrench,
  Plug2,
} from "lucide-react";
import AppSidebar, { type AppSection } from "./AppSidebar";
import { useIntegrationStatus } from "@/lib/use-integration-status";

/**
 * Dedicated shell for the Integrations area.
 *
 * The sidebar used to expand an accordion with these seven entries;
 * that worked but didn't scale — every new integration stretched the
 * sidebar, and scanning a dense submenu was awkward next to the rest
 * of the nav. The shell moves those seven into a vertical rail within
 * the content area, keeping the outer sidebar flat.
 *
 * URLs do NOT change — each integration still owns its own /{slug}
 * route. Pages wrap their content in <IntegrationsShell active="…">
 * and the shell renders the rail + title block around them.
 */

export type IntegrationKey =
  | "orchestration"
  | "providers"
  | "cli-providers"
  | "storage"
  | "notifications"
  | "knowledge"
  | "mcp-servers";

interface RailItem {
  key:   IntegrationKey;
  label: string;
  href:  string;
  icon:  React.FC<{ size?: number; strokeWidth?: number }>;
  // Resolved at render time from useIntegrationStatus; can't live in
  // the static list.
  alert?: "red" | "orange" | null;
}

const ITEMS: RailItem[] = [
  { key: "orchestration", label: "Processing",           icon: Zap,       href: "/orchestration" },
  { key: "providers",     label: "API Providers",        icon: Cpu,       href: "/providers"     },
  { key: "cli-providers", label: "CLI Providers",        icon: Bot,       href: "/cli-providers" },
  { key: "storage",       label: "Storage",              icon: HardDrive, href: "/storage"       },
  { key: "notifications", label: "Notifications",        icon: Bell,      href: "/notifications" },
  { key: "knowledge",     label: "Knowledge Base (RAG)", icon: Brain,     href: "/knowledge"     },
  { key: "mcp-servers",   label: "Tools",                icon: Wrench,    href: "/mcp-servers"   },
];

const RAIL_WIDTH = 220;

export interface IntegrationsShellProps {
  active: IntegrationKey;
  /** Optional page title above the content — mirrors PageShell. */
  title?: string;
  description?: React.ReactNode;
  headerActions?: React.ReactNode;
  /** Cap for the content column. Falls back to fluid. */
  maxWidth?: number;
  children: React.ReactNode;
}

const LAST_VISITED_KEY = "twinpilot.integrations.last";

export default function IntegrationsShell({
  active,
  title,
  description,
  headerActions,
  maxWidth,
  children,
}: IntegrationsShellProps) {
  const alerts = useIntegrationStatus();
  // The shell is selected in the outer AppSidebar as "Integrations" too,
  // but AppSection only has the specific integration keys — map to them
  // so the sidebar highlights the right entry.
  const outerActive = active as AppSection;

  // Remember the current integration so /integrations (the sidebar
  // entry point) can take the user back here on the next visit.
  useEffect(() => {
    const item = ITEMS.find((i) => i.key === active);
    if (!item) return;
    try { localStorage.setItem(LAST_VISITED_KEY, item.href); } catch { /* noop */ }
  }, [active]);
  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", color: "var(--text)", background: "var(--base)" }}>
      <AppSidebar active={outerActive} />

      {/* Internal vertical rail — replaces the old sidebar accordion */}
      <aside
        style={{
          width: RAIL_WIDTH,
          flexShrink: 0,
          borderRight: "1px solid var(--surface0)",
          background: "var(--mantle)",
          overflowY: "auto",
          padding: "24px 12px",
        }}
        className="integrations-rail"
      >
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "0 10px 12px",
          color: "var(--overlay1)",
        }}>
          <Plug2 size={15} />
          <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Integrations
          </span>
        </div>

        <style>{`
          .int-rail-item { transition: background 0.12s ease, color 0.12s ease; text-decoration: none; }
          .int-rail-item:hover { background: var(--surface0); color: var(--text); }
          .int-rail-item.is-active { background: var(--surface0); color: var(--text); }
        `}</style>

        <nav style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {ITEMS.map((item) => {
            const isActive = item.key === active;
            // Alert only surfaces on "orchestration" today (platforms
            // readiness). If useIntegrationStatus expands, map here.
            const alert = item.key === "orchestration" ? alerts.platforms : null;
            const Icon = item.icon;
            return (
              <Link
                key={item.key}
                href={item.href}
                className={`int-rail-item ${isActive ? "is-active" : ""}`}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px",
                  borderRadius: 7,
                  color: isActive ? "var(--text)" : "var(--subtext0)",
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  borderLeft: isActive ? "2px solid var(--blue)" : "2px solid transparent",
                }}
              >
                <Icon size={14} strokeWidth={isActive ? 2 : 1.5} />
                <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.label}
                </span>
                {alert && (
                  <span style={{
                    width: 14, height: 14, borderRadius: 99,
                    background: alert === "red" ? "rgba(228,75,95,0.15)" : "rgba(245,159,0,0.15)",
                    color: alert === "red" ? "var(--red)" : "var(--peach)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 800, flexShrink: 0,
                  }}>!</span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div
          style={{
            width: "100%",
            maxWidth: maxWidth ?? "100%",
            margin: "0 auto",
            padding: "32px clamp(24px, 4vw, 40px) 80px",
          }}
        >
          {title && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 16,
                marginBottom: description ? 24 : 32,
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <h1 style={{ color: "var(--text)", fontSize: 24, fontWeight: 700, fontFamily: "var(--font-heading)", margin: 0, marginBottom: description ? 8 : 0 }}>
                  {title}
                </h1>
                {description && (
                  <div style={{ color: "var(--subtext0)", fontSize: 14, lineHeight: 1.5 }}>
                    {description}
                  </div>
                )}
              </div>
              {headerActions && <div style={{ flexShrink: 0 }}>{headerActions}</div>}
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
