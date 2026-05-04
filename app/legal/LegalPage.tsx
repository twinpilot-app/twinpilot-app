"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronLeft } from "lucide-react";
import { brand } from "@/lib/brand";

export default function LegalPage({ file, title }: { file: string; title: string }) {
  const router = useRouter();
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/legal/${file}`)
      .then((r) => r.text())
      .then(setContent)
      .catch(() => setContent("_Could not load document._"));
  }, [file]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--base)",
      fontFamily: "var(--font-sans)",
      color: "var(--text)",
    }}>
      {/* Top bar */}
      <div style={{
        position: "sticky", top: 0, zIndex: 10,
        background: "var(--mantle)",
        borderBottom: "1px solid var(--surface0)",
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 24px",
      }}>
        <button
          onClick={() => router.back()}
          style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--overlay1)", background: "none", border: "none", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-sans)", padding: 0 }}
        >
          <ChevronLeft size={15} /> Back
        </button>
        <span style={{ color: "var(--surface2)" }}>|</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{title}</span>
        <span style={{ fontSize: 11, color: "var(--overlay0)", marginLeft: "auto" }}>{brand.name} · v1.0</span>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px 80px" }}>
        {content == null ? (
          <div style={{ color: "var(--overlay0)", textAlign: "center", padding: 64, fontSize: 14 }}>Loading…</div>
        ) : (
          <div className="legal-page-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
      </div>

      <style>{`
        .legal-page-md h1 { font-size: 26px; font-weight: 800; margin: 0 0 8px; }
        .legal-page-md h2 { font-size: 16px; font-weight: 700; margin: 36px 0 10px; color: var(--subtext1); border-bottom: 1px solid var(--surface0); padding-bottom: 6px; }
        .legal-page-md h3 { font-size: 14px; font-weight: 700; margin: 20px 0 8px; color: var(--subtext0); }
        .legal-page-md p  { margin: 0 0 12px; color: var(--subtext1); line-height: 1.75; }
        .legal-page-md ul, .legal-page-md ol { margin: 0 0 12px; padding-left: 22px; color: var(--subtext1); line-height: 1.75; }
        .legal-page-md li { margin-bottom: 5px; }
        .legal-page-md strong { color: var(--text); font-weight: 700; }
        .legal-page-md blockquote { margin: 0 0 16px; padding: 12px 16px; border-left: 3px solid rgba(245,159,0,0.5); background: rgba(245,159,0,0.05); border-radius: 0 8px 8px 0; color: var(--yellow); }
        .legal-page-md table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px; }
        .legal-page-md th { text-align: left; padding: 9px 14px; background: var(--surface0); border: 1px solid var(--surface1); font-weight: 700; color: var(--subtext1); }
        .legal-page-md td { padding: 8px 14px; border: 1px solid var(--surface1); color: var(--subtext0); vertical-align: top; }
        .legal-page-md a  { color: var(--blue); }
        .legal-page-md hr { border: none; border-top: 1px solid var(--surface0); margin: 32px 0; }
        .legal-page-md code { background: var(--surface1); border-radius: 4px; padding: 2px 6px; font-size: 12px; }
      `}</style>
    </div>
  );
}
