"use client";

/**
 * Small "preview rendered markdown" button + modal.
 *
 * Reusable everywhere we render a textarea that takes markdown as input
 * (project briefing, PRD, guidelines, agent instructions, etc.). The
 * button is a single Eye icon meant to live next to the field's label;
 * clicking opens a wide modal that renders the textarea's CURRENT value
 * via the shared MD_COMPONENTS theme + GFM (tables, strikethrough,
 * task lists). The textarea remains the source of truth — this is
 * preview-only.
 *
 * Disabled when `value` is empty (nothing to preview); ESC + backdrop
 * click both close the modal.
 */
import React, { useEffect, useState } from "react";
import { Eye, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MD_COMPONENTS from "@/lib/md-components";

interface Props {
  /** Current markdown text. Reactive — modal re-renders as the textarea
   *  updates. */
  value:     string;
  /** Display label for the modal header (e.g. "Briefing", "PRD"). */
  label:     string;
  /** Optional explainer line under the modal header. */
  hint?:     string;
}

export default function MarkdownPreviewButton({ value, label, hint }: Props) {
  const [open, setOpen] = useState(false);
  const empty = value.trim().length === 0;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => { if (!empty) setOpen(true); }}
        disabled={empty}
        title={empty ? "Nothing to preview yet" : `Preview ${label} as rendered markdown`}
        aria-label={`Preview ${label}`}
        style={{
          display: "inline-flex", alignItems: "center", gap: 3,
          padding: "2px 6px", borderRadius: 4,
          border: "1px solid var(--surface1)",
          background: "transparent",
          color: empty ? "var(--overlay0)" : "var(--subtext0)",
          fontSize: 10, fontWeight: 600,
          cursor: empty ? "not-allowed" : "pointer",
          opacity: empty ? 0.5 : 1,
          fontFamily: "var(--font-sans)",
        }}
      >
        <Eye size={11} /> Preview
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 200,
            background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={`${label} preview`}
            style={{
              background: "var(--mantle)", border: "1px solid var(--surface0)",
              borderRadius: 14, width: "min(960px, 96vw)", height: "min(88vh, 880px)",
              display: "flex", flexDirection: "column",
              boxShadow: "0 32px 80px rgba(0,0,0,0.55)",
              overflow: "hidden",
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "12px 16px", borderBottom: "1px solid var(--surface0)",
              background: "var(--surface0)",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{label} · preview</div>
                {hint && (
                  <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>{hint}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close preview"
                title="Close (Esc)"
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "5px 10px", borderRadius: 6,
                  border: "1px solid var(--surface1)", background: "transparent",
                  color: "var(--subtext0)", fontSize: 11, fontWeight: 600, cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                }}
              >
                <X size={12} /> Close
              </button>
            </div>

            <div style={{
              flex: 1, minHeight: 0, overflow: "auto",
              padding: "20px 28px",
              fontFamily: "var(--font-sans)", color: "var(--text)",
              background: "var(--mantle)",
            }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {value}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
