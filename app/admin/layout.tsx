"use client";

import React, { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { brand } from "@/lib/brand";
import { LayoutDashboard, Users, ChevronLeft, ShieldAlert, Plug, PowerOff, Ticket, Bell, ClipboardList, Shield, Rocket, Database } from "lucide-react";

const NAV = [
  { href: "/admin",               label: "Overview",       icon: LayoutDashboard },
  { href: "/admin/tenants",       label: "Tenants",        icon: Users           },
  { href: "/admin/storage",       label: "Storage",        icon: Database        },
  { href: "/admin/invites",       label: "Invite Codes",   icon: Ticket          },
  { href: "/admin/waiting-list",  label: "Waiting List",   icon: ClipboardList   },
  { href: "/admin/beta-testers",  label: "Beta Testers",   icon: Rocket          },
  { href: "/admin/integrations",  label: "Integrations",   icon: Plug            },
  { href: "/admin/notifications", label: "Notifications",  icon: Bell            },
  { href: "/admin/rls",           label: "RLS Audit",      icon: Shield          },
  { href: "/admin/maintenance",   label: "Maintenance",    icon: PowerOff        },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const [ready, setReady]   = useState(false);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user;
      if (!user) { router.replace("/login"); return; }
      const role = (user.app_metadata as Record<string, unknown>)?.role;
      if (role !== "admin") { setDenied(true); setReady(true); return; }
      setReady(true);
    });
  }, [router]);

  if (!ready) return null;

  if (denied) {
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16, color: "var(--text)", fontFamily: "var(--font-sans)", background: "var(--base)" }}>
        <ShieldAlert size={40} color="var(--red)" />
        <div style={{ fontSize: 18, fontWeight: 700 }}>Access denied</div>
        <div style={{ fontSize: 14, color: "var(--subtext0)" }}>Your account does not have platform admin privileges.</div>
        <a href="/" style={{ color: "var(--blue)", fontSize: 13 }}>← Back to Pipeline</a>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", color: "var(--text)", background: "var(--base)" }}>

      {/* Sidebar */}
      <aside style={{
        width: 220, minWidth: 220, height: "100vh", flexShrink: 0,
        background: "var(--crust)", borderRight: "1px solid var(--surface0)",
        display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{ padding: "20px 16px 16px", borderBottom: "1px solid var(--surface0)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <img src={brand.assets.logoMark} alt={brand.shortName} style={{ width: 28, height: 28 }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{brand.holdingName}</div>
              <div style={{ fontSize: 10, color: "var(--red)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>Platform Admin</div>
            </div>
          </div>
          <a href="/" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--overlay1)", textDecoration: "none" }}>
            <ChevronLeft size={12} /> Back to Pipeline
          </a>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "12px 8px" }}>
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== "/admin" && pathname.startsWith(href));
            return (
              <a key={href} href={href} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "7px 10px", borderRadius: 7, marginBottom: 2,
                background: active ? "var(--surface0)" : "transparent",
                color: active ? "var(--text)" : "var(--subtext0)",
                textDecoration: "none", fontSize: 13, fontWeight: active ? 600 : 400,
                borderLeft: active ? "2px solid var(--red)" : "2px solid transparent",
                transition: "all 0.12s ease",
              }}>
                <Icon size={15} strokeWidth={active ? 2 : 1.5} />
                {label}
              </a>
            );
          })}
        </nav>
      </aside>

      {/* Main */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {children}
      </div>
    </div>
  );
}
