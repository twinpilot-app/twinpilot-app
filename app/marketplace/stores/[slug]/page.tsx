"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import AppSidebar from "@/components/AppSidebar";
import { Store, ChevronRight, GitBranch, Package, ShieldCheck } from "lucide-react";

interface StoreMeta {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  avatar: string | null;
  verified: boolean;
}

interface FactoryListing {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
  category_slug: string;
  factory_slug: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  repo_branch: string | null;
}


async function fetchWithAuth(url: string) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export default function MarketplaceStoreDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [store, setStore] = useState<StoreMeta | null>(null);
  const [factories, setFactories] = useState<FactoryListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = (await fetchWithAuth(`/api/marketplace/stores/${slug}`)) as {
        store: StoreMeta;
        factories: FactoryListing[];
      };
      setStore(body.store);
      setFactories(body.factories);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", color: "var(--text)", background: "var(--base)" }}>
      <AppSidebar active="marketplace" />
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 860, margin: "0 auto", padding: "40px 28px 80px" }}>

          {/* Breadcrumb */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--overlay0)", marginBottom: 16 }}>
            <Link href="/marketplace" style={{ color: "var(--overlay1)", textDecoration: "none" }}>Marketplace</Link>
            <ChevronRight size={12} />
            <span style={{ color: "var(--text)" }}>{store?.name ?? slug}</span>
          </div>

          {loading && <div style={{ padding: "40px 0", color: "var(--overlay0)", fontSize: 14 }}>Loading…</div>}

          {error && (
            <div style={{
              padding: "12px 16px", borderRadius: 10,
              background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)",
              color: "var(--red)", fontSize: 13,
            }}>{error}</div>
          )}

          {store && !loading && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
                <div style={{
                  width: 56, height: 56, borderRadius: 14, flexShrink: 0,
                  background: "linear-gradient(135deg, var(--mauve), #6344e0)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <Store size={28} color="#fff" strokeWidth={1.5} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", margin: 0 }}>{store.name}</h1>
                    {store.verified && (
                      <span title="Verified store" style={{ color: "var(--blue)", display: "flex" }}>
                        <ShieldCheck size={16} />
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--overlay0)", fontFamily: "var(--font-mono)", marginTop: 3 }}>
                    @{store.slug}
                  </div>
                  {store.description && (
                    <p style={{ fontSize: 14, color: "var(--subtext0)", margin: "8px 0 0", lineHeight: 1.5 }}>
                      {store.description}
                    </p>
                  )}
                </div>
              </div>

              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
                Factories ({factories.length})
              </div>

              {factories.length === 0 ? (
                <div style={{
                  padding: "32px 20px", textAlign: "center",
                  background: "var(--mantle)", border: "1px solid var(--surface0)",
                  borderRadius: 12, color: "var(--overlay0)", fontSize: 13,
                }}>
                  This store has no published factories yet.
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
                  {factories.map((f) => (
                    <Link key={f.id} href={`/marketplace/listings/${f.id}`} style={{
                      background: "var(--mantle)", border: "1px solid var(--surface0)",
                      borderRadius: 12, padding: "16px 18px",
                      textDecoration: "none", color: "inherit",
                      transition: "border-color 0.12s",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                        <Package size={18} color="var(--mauve)" />
                        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{f.name}</div>
                      </div>
                      {f.description && (
                        <div style={{ fontSize: 12, color: "var(--subtext0)", lineHeight: 1.5, marginBottom: 10 }}>
                          {f.description}
                        </div>
                      )}
                      {f.repo_owner && (
                        <div style={{
                          display: "flex", alignItems: "center", gap: 5,
                          fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)",
                        }}>
                          <GitBranch size={11} />
                          {f.repo_owner}/{f.repo_name}#{f.repo_branch}
                        </div>
                      )}
                    </Link>
                  ))}
                </div>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
