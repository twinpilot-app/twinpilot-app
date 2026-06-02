"use client";

import React, { useEffect, useState, useCallback, useId } from "react";
import { createPortal } from "react-dom";
import { Bell } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import NotificationCenter from "./NotificationCenter";

export default function NotificationBell() {
  const { session, tenantId } = useAuth();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  // Unique suffix so multiple bells in the tree (e.g. rail + panel in
  // AppSidebar) don't collide on the Supabase realtime channel name.
  const instanceId = useId();

  const fetchCount = useCallback(async () => {
    if (!session || !tenantId) return;
    const res = await fetch(`/api/notifications/unread-count?tenantId=${tenantId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      const body = await res.json() as { count: number };
      setCount(body.count);
    }
  }, [session, tenantId]);

  // Initial fetch
  useEffect(() => { fetchCount(); }, [fetchCount]);

  // Realtime subscription for live updates
  useEffect(() => {
    if (!tenantId) return;
    const channel = supabase
      .channel(`notifications:${tenantId}:${instanceId}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: `tenant_id=eq.${tenantId}`,
      }, () => {
        setCount((c) => c + 1);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [tenantId, instanceId]);

  if (!session || !tenantId) return null;

  return (
    <>
      <button
        onClick={() => { setOpen((o) => !o); if (!open) fetchCount(); }}
        title="Notifications"
        style={{
          position: "relative",
          background: "none", border: "none", cursor: "pointer",
          padding: 6, display: "flex", alignItems: "center", justifyContent: "center",
          color: open ? "var(--text)" : "var(--overlay1)",
        }}
      >
        <Bell size={18} strokeWidth={1.5} />
        {count > 0 && (
          <div style={{
            position: "absolute", top: 2, right: 2,
            minWidth: 14, height: 14, borderRadius: 99,
            background: "var(--red)", color: "#fff",
            fontSize: 9, fontWeight: 800, lineHeight: "14px",
            textAlign: "center", padding: "0 3px",
          }}>
            {count > 99 ? "99+" : count}
          </div>
        )}
      </button>

      {/* Portal to <body> so the fixed panel isn't captured by the sidebar's
       *  transform ancestor (AppSidebar uses translateX on its panel which
       *  makes any descendant `position: fixed` resolve against that
       *  transformed box instead of the viewport — which was rendering the
       *  drawer on the left side, covering the navbar). */}
      {open && typeof document !== "undefined" && createPortal(
        <NotificationCenter
          onClose={() => setOpen(false)}
          onCountChange={setCount}
        />,
        document.body,
      )}
    </>
  );
}
