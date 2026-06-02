"use client";

/**
 * FactorySection — collapsible card used by every subsection of the
 * Factory Manager. Until now Extensions, Guidelines, Skills, Marketplace
 * Repository, Output Destinations and Harness Presets all rolled their
 * own header style; this component is the single source of truth so they
 * line up visually.
 *
 * The pattern: a `mantle` card with a 14px icon, a 13/600 title, an
 * optional subtitle / badge in the middle, and a chevron on the right
 * that flips when the section opens. The body sits below the header
 * with a top divider; padding is consistent across sections.
 *
 * Components that prefer to render their own body (e.g. SkillsSection,
 * FactoryOutputDestinations) accept a `headerless` prop and let this
 * component own the chrome.
 */

import React, { type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface FactorySectionProps {
  /** Section title — shown in 13/600. */
  title:    string;
  /** Lucide icon at the leading edge of the header. Sized 14 by convention. */
  icon:     ReactNode;
  /** Short hint or count — rendered after the title in 11/400. */
  subtitle?: ReactNode;
  /** Optional pill badge (e.g. "legacy") — rendered between title and subtitle. */
  badge?:   ReactNode;
  /** Trailing content on the right of the header, BEFORE the chevron.
   *  Useful for status indicators (e.g. green check when verified). */
  right?:   ReactNode;
  open:     boolean;
  onToggle: () => void;
  children?: ReactNode;
  /** Override the header bg — defaults to var(--mantle). */
  bg?:       string;
  /** Skip the body padding. Useful when children render their own padded
   *  layout (tables, JSON editors). */
  flushBody?: boolean;
}

export function FactorySection({
  title, icon, subtitle, badge, right,
  open, onToggle, children, bg, flushBody,
}: FactorySectionProps) {
  return (
    <div style={{
      marginTop: 12,
      border: "1px solid var(--surface1)",
      borderRadius: 10,
      overflow: "hidden",
      background: bg ?? "var(--mantle)",
    }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          width: "100%", padding: "12px 14px",
          background: "transparent", border: "none",
          color: "var(--text)", fontSize: 13, fontWeight: 600,
          cursor: "pointer", textAlign: "left",
          fontFamily: "var(--font-sans)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", color: "var(--subtext0)", flexShrink: 0 }}>
          {icon}
        </span>
        <span style={{ flexShrink: 0 }}>{title}</span>
        {badge && (
          <span style={{ flexShrink: 0 }}>{badge}</span>
        )}
        {subtitle && (
          <span style={{
            fontSize: 11, color: "var(--overlay0)", fontWeight: 400,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            minWidth: 0, flex: 1,
          }}>
            {subtitle}
          </span>
        )}
        {!subtitle && <div style={{ flex: 1 }} />}
        {right && <span style={{ flexShrink: 0 }}>{right}</span>}
        <span style={{ flexShrink: 0, color: "var(--overlay0)", display: "inline-flex", alignItems: "center" }}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open && (
        <div style={{
          borderTop: "1px solid var(--surface1)",
          padding: flushBody ? 0 : "12px 14px",
        }}>
          {children}
        </div>
      )}
    </div>
  );
}
