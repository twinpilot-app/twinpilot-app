/**
 * Sprint-intent badge (mig 169 vocabulary: discovery / planning / execution / review).
 *
 * Shared across every surface that lists sprints — Office sprint history
 * (SprintHistoryPanel via ProjectCard.SprintRow), project detail timeline,
 * canvas segment header, etc. Keeping the colour palette + icon set in
 * one place avoids drift between renders.
 *
 * Renders null when intent is null (sprints from before mig 117 backfill,
 * or when the dashboard didn't surface the field) — caller decides
 * whether to render a placeholder or just skip the badge.
 */
import React from "react";
import { Sparkles, ListTodo, FileText, Bot } from "lucide-react";

export function IntentBadge({ intent }: { intent: string | null | undefined }) {
  if (!intent) return null;
  const v =
    intent === "discovery" ? { bg: "rgba(20,99,255,0.08)",   fg: "var(--blue)",  icon: <Sparkles size={9} />, title: "Discovery sprint — agents decide what to work on" }
    : intent === "planning" ? { bg: "rgba(203,166,247,0.08)", fg: "var(--mauve)", icon: <ListTodo size={9} />, title: "Planning sprint — product owner grooms the backlog" }
    : intent === "review"   ? { bg: "rgba(245,159,0,0.08)",   fg: "var(--peach)", icon: <FileText size={9} />, title: "Review sprint — qa / eval inspects recent work" }
    :                          { bg: "rgba(28,191,107,0.08)",  fg: "var(--green)", icon: <Bot size={9} />,      title: "Execution sprint — delivers the defined backlog item" };
  return (
    <span
      title={v.title}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
        padding: "1px 5px", borderRadius: 3,
        background: v.bg, color: v.fg,
      }}
    >
      {v.icon}
      {intent}
    </span>
  );
}

export default IntentBadge;
