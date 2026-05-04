"use client";

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type TenantPlan = string | null;
export type MemberRole = "platform_admin" | "admin" | "member" | null;

export interface FactoryInfo {
  id: string;
  slug: string;
  name: string;
  category: string;
  avatar: string | null;
  origin?: "tirsa" | "community" | "paid" | "custom";
  type?: "factory" | "extension";
  extends_factory_id?: string | null;
  enabled?: boolean;
  listing_id?: string | null;
  inherits?: string[];  // IDs of factories this factory inherits from
  config?: Record<string, unknown> | null;
  /** Factory-wide guidelines that merge with project + agent guidelines
   *  at sprint dispatch (factory < project < agent ordering).
   *  Markdown supported. Empty/null means no factory-level rules. */
  guidelines?: string | null;
}

interface AuthContextValue {
  session: Session | null;
  tenantId: string | null;
  tenantName: string | null;
  tenantPlan: TenantPlan;
  memberRole: MemberRole;
  loading: boolean;

  // Active factory (derived from factories list + user preference)
  factoryId: string | null;
  factorySlug: string | null;
  factoryName: string | null;

  // Multi-factory support
  factories: FactoryInfo[];
  setActiveFactory: (factoryId: string) => void;
  refreshFactories: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  session: null, tenantId: null,
  tenantName: null, tenantPlan: null, memberRole: null,
  loading: true,
  factoryId: null, factorySlug: null, factoryName: null,
  factories: [],
  setActiveFactory: () => {},
  refreshFactories: async () => {},
});

export function useAuth() { return useContext(AuthContext); }

const NONE_SENTINEL = "__none__";

function getStoredFactory(tenantId: string): string | null | "none" {
  try {
    const v = localStorage.getItem(`tirsa_active_factory_${tenantId}`);
    if (v === NONE_SENTINEL) return "none";
    return v;
  } catch { return null; }
}
function storeActiveFactory(tenantId: string, factoryId: string | null) {
  try {
    localStorage.setItem(`tirsa_active_factory_${tenantId}`, factoryId ?? NONE_SENTINEL);
  } catch { /* noop */ }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session,    setSession]    = useState<Session | null>(null);
  const [tenantId,   setTenantId]   = useState<string | null>(null);
  const [tenantName, setTenantName] = useState<string | null>(null);
  const [tenantPlan, setTenantPlan] = useState<TenantPlan>(null);
  const [memberRole, setMemberRole] = useState<MemberRole>(null);
  const [factories,  setFactories]  = useState<FactoryInfo[]>([]);
  const [activeId,   setActiveId]   = useState<string | null>(null);
  const [loading,    setLoading]    = useState(true);
  const fetchedRef = useRef(false);

  // Derive active factory from list
  const active = factories.find((f) => f.id === activeId) ?? null;

  const setActiveFactory = useCallback((fid: string) => {
    setActiveId(fid);
    if (tenantId) storeActiveFactory(tenantId, fid);
  }, [tenantId]);

  const refreshFactories = useCallback(async () => {
    if (!tenantId) return;
    const { data } = await supabase
      .from("factories")
      .select("id, slug, name, category, avatar, origin, type, extends_factory_id, enabled, listing_id, config")
      .eq("tenant_id", tenantId)
      .order("created_at");
    if (data && data.length > 0) {
      const list = data as FactoryInfo[];
      // Fetch inheritance relationships
      const factoryIds = list.map((f) => f.id);
      const { data: inhData } = await supabase
        .from("factory_inheritance")
        .select("factory_id, inherits_id")
        .in("factory_id", factoryIds);
      const inhMap = new Map<string, string[]>();
      for (const row of inhData ?? []) {
        const fid = row.factory_id as string;
        if (!inhMap.has(fid)) inhMap.set(fid, []);
        inhMap.get(fid)!.push(row.inherits_id as string);
      }
      for (const f of list) f.inherits = inhMap.get(f.id) ?? [];
      setFactories(list);
      const stored = getStoredFactory(tenantId);
      // User explicitly chose "None" — respect it
      if (stored === "none") {
        setActiveId(null);
      } else {
        const enabled = list.filter((f) => f.enabled !== false);
        const match = enabled.find((f) => f.id === stored) ?? enabled[0] ?? null;
        setActiveId(match?.id ?? null);
        if (match && tenantId) storeActiveFactory(tenantId, match.id);
      }
    } else {
      setFactories([]);
      setActiveId(null);
    }
  }, [tenantId]);

  useEffect(() => {
    supabase.auth.getSession().catch(() => {});

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, sess) => {
      setSession(sess);

      if (event === "SIGNED_OUT") {
        fetchedRef.current = false;
        setTenantId(null); setTenantName(null); setTenantPlan(null);
        setMemberRole(null); setFactories([]); setActiveId(null);
        setLoading(false);
        return;
      }

      if (!sess) {
        if (event === "INITIAL_SESSION") setLoading(false);
        return;
      }

      if (fetchedRef.current) return;
      fetchedRef.current = true;

      void (async () => {
        try {
          const { data: member } = await supabase
            .from("tenant_members")
            .select("tenant_id, role")
            .eq("user_id", sess.user.id)
            .single();

          if (!member) { setLoading(false); return; }
          const tid = member.tenant_id as string;
          setTenantId(tid);
          setMemberRole((member.role as MemberRole) ?? null);

          const [tenantRes, factoriesRes] = await Promise.all([
            supabase.from("tenants").select("name, plan").eq("id", tid).single(),
            supabase.from("factories").select("id, slug, name, category, avatar, origin, type, extends_factory_id, enabled, listing_id, config").eq("tenant_id", tid).order("created_at"),
          ]);

          if (tenantRes.data) {
            setTenantName(tenantRes.data.name as string);
            setTenantPlan((tenantRes.data.plan as string) ?? null);
          }

          const list = (factoriesRes.data ?? []) as FactoryInfo[];
          // Fetch inheritance
          if (list.length > 0) {
            const fids = list.map((f) => f.id);
            const { data: inhData } = await supabase.from("factory_inheritance").select("factory_id, inherits_id").in("factory_id", fids);
            const inhMap = new Map<string, string[]>();
            for (const row of inhData ?? []) { const fid = row.factory_id as string; if (!inhMap.has(fid)) inhMap.set(fid, []); inhMap.get(fid)!.push(row.inherits_id as string); }
            for (const f of list) f.inherits = inhMap.get(f.id) ?? [];
          }
          setFactories(list);

          if (list.length > 0) {
            const stored = getStoredFactory(tid);
            if (stored === "none") {
              setActiveId(null);
            } else {
              const enabled = list.filter((f) => f.enabled !== false);
              const match = enabled.find((f) => f.id === stored) ?? enabled[0] ?? null;
              if (match) {
                setActiveId(match.id);
                storeActiveFactory(tid, match.id);
              }
            }
          }
        } catch (err) {
          console.error("[AuthProvider] tenant fetch failed:", err);
        } finally {
          setLoading(false);
        }
      })();
    });
    return () => subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{
      session, tenantId, tenantName, tenantPlan, memberRole, loading,
      factoryId: active?.id ?? null,
      factorySlug: active?.slug ?? null,
      factoryName: active?.name ?? null,
      factories,
      setActiveFactory,
      refreshFactories,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
