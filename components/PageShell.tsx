"use client";

import React from "react";
import AppSidebar, { type AppSection } from "./AppSidebar";

/**
 * Standardised page shell for command-center screens.
 *
 * Before this existed every page rolled its own outer layout — some
 * full-bleed, some modal, some with half-width content — which made
 * the app feel stitched together. Pages that adopt <PageShell> get:
 *   - the sidebar at the left
 *   - a scrollable main column that fills the remaining width
 *   - a consistent side gutter (24px on mobile, 40px on desktop)
 *   - an optional `maxWidth` cap so long-form screens (profile, help)
 *     don't stretch on ultra-wide monitors
 *   - a header block with title + optional description
 *
 * The shell is deliberately minimal. Pages that need a custom header
 * (tab bar, contextual actions) can omit `title` and render anything
 * they want as children — the gutter still applies.
 *
 * Adoption is incremental. Pages can migrate one at a time and the
 * shell absorbs the AppSidebar, so the call-site drops from ~20 lines
 * of layout boilerplate to one wrapper.
 */
export interface PageShellProps {
  active: AppSection;
  /** Optional page title rendered as h1 at the top of the content area. */
  title?: string;
  /** Short description under the title. Pass omit to skip. */
  description?: React.ReactNode;
  /**
   * Cap the content column width. Defaults to 1120 — wide enough for
   * two-column forms, narrow enough that text doesn't become a rag on
   * 27"+ displays. Pass a different number (or `undefined` explicitly
   * wrapped in a children div with its own max-width) if you need
   * something else.
   */
  maxWidth?: number;
  children: React.ReactNode;
  /** Rendered to the right of the title, e.g. action buttons. */
  headerActions?: React.ReactNode;
}

export default function PageShell({
  active,
  title,
  description,
  maxWidth = 1120,
  children,
  headerActions,
}: PageShellProps) {
  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", color: "var(--text)", background: "var(--base)" }}>
      <AppSidebar active={active} />

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div
          style={{
            width: "100%",
            maxWidth,
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
                <h1
                  style={{
                    color: "var(--text)",
                    fontSize: 24,
                    fontWeight: 700,
                    fontFamily: "var(--font-heading)",
                    margin: 0,
                    marginBottom: description ? 8 : 0,
                  }}
                >
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
