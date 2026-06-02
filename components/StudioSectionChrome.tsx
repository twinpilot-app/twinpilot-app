"use client";

/**
 * Shared chrome for Studio section panels — Skills, Commands, Hooks,
 * Output Styles, and any future sibling. Gives them the same look as
 * the Agents and Projects tabs:
 *
 *   · max-width 920 container centered with 28/24 padding
 *   · h2 page title (18/700) + subtitle (13/subtext0)
 *   · primary CTA matches Projects' "+ New project" button (8/16
 *     padding, 13px, 700, #1463ff) — bigger and louder than the
 *     previous tiny 11px caption-style header
 *
 * Sub-actions (Browse, Import, Curated) keep the ghost style next to
 * the primary so a section can offer a row of related actions.
 */
import React from "react";

export const studioSectionContainer: React.CSSProperties = {
  maxWidth: 920,
  margin:   "0 auto",
  padding:  "28px 24px",
};

export const studioBtnPrimary: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 7,
  padding: "8px 16px", borderRadius: 9,
  border: "none", background: "#1463ff", color: "#fff",
  fontSize: 13, fontWeight: 700, cursor: "pointer",
  fontFamily: "var(--font-sans)", whiteSpace: "nowrap",
};

export const studioBtnGhost: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 9,
  background: "transparent", color: "var(--subtext0)",
  border: "1px solid var(--surface1)",
  fontSize: 12, fontWeight: 600, cursor: "pointer",
  fontFamily: "var(--font-sans)", whiteSpace: "nowrap",
};

export const studioInputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 12px", borderRadius: 7,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 13, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box",
};

export const studioErrBanner: React.CSSProperties = {
  fontSize: 12, color: "var(--red)", padding: "8px 12px",
  background: "rgba(255,77,77,0.08)", border: "1px solid rgba(255,77,77,0.25)",
  borderRadius: 8, marginBottom: 12, fontWeight: 600,
};

export const studioMuted: React.CSSProperties = {
  fontSize: 13, color: "var(--overlay0)", padding: "12px 0",
};

export function StudioSectionHeader({ title, subtitle, actions }: {
  title:    string;
  subtitle: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start",
      justifyContent: "space-between", marginBottom: 20, gap: 16, flexWrap: "wrap",
    }}>
      <div style={{ flex: "1 1 320px", minWidth: 220 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>{title}</h2>
        <p style={{ fontSize: 13, color: "var(--subtext0)", margin: 0, lineHeight: 1.5 }}>
          {subtitle}
        </p>
      </div>
      {actions && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {actions}
        </div>
      )}
    </div>
  );
}
