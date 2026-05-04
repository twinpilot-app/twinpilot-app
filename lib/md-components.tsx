/**
 * Shared ReactMarkdown component overrides for the dark Catppuccin theme.
 * Import and pass as the `components` prop to <ReactMarkdown>.
 */
import ReactMarkdown from "react-markdown";

const MD_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  h1: ({ children }) => <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: "0 0 12px" }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: "20px 0 8px", borderBottom: "1px solid var(--surface1)", paddingBottom: 4 }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--subtext1)", margin: "16px 0 6px" }}>{children}</h3>,
  p:  ({ children }) => <p  style={{ color: "var(--subtext0)", margin: "0 0 10px", lineHeight: 1.7 }}>{children}</p>,
  a:  ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--blue)", textDecoration: "underline" }}>{children}</a>,
  strong: ({ children }) => <strong style={{ color: "var(--text)", fontWeight: 600 }}>{children}</strong>,
  em:     ({ children }) => <em style={{ color: "var(--subtext1)", fontStyle: "italic" }}>{children}</em>,
  ul: ({ children }) => <ul style={{ color: "var(--subtext0)", paddingLeft: 20, margin: "0 0 10px" }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ color: "var(--subtext0)", paddingLeft: 20, margin: "0 0 10px" }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: 4, lineHeight: 1.6 }}>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote style={{
      borderLeft: "3px solid var(--overlay0)", paddingLeft: 12,
      color: "var(--overlay1)", margin: "10px 0", fontStyle: "italic",
    }}>{children}</blockquote>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = className?.startsWith("language-");
    return isBlock ? (
      <code style={{
        display: "block", fontFamily: "var(--font-mono)", fontSize: 12,
        color: "var(--text)", lineHeight: 1.6,
      }} {...props}>{children}</code>
    ) : (
      <code style={{
        fontFamily: "var(--font-mono)", fontSize: 12,
        background: "var(--surface2)", color: "var(--peach)",
        padding: "1px 5px", borderRadius: 4,
      }} {...props}>{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre style={{
      background: "var(--surface1)", borderRadius: 8, padding: 14,
      overflowX: "auto", margin: "0 0 12px",
      fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6,
    }}>{children}</pre>
  ),
  hr: () => <hr style={{ border: "none", borderTop: "1px solid var(--surface1)", margin: "16px 0" }} />,
  table: ({ children }) => (
    <div style={{ overflowX: "auto", marginBottom: 12 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tr:   ({ children }) => <tr style={{ borderBottom: "1px solid var(--surface2)" }}>{children}</tr>,
  th:   ({ children }) => <th style={{ color: "var(--subtext0)", fontWeight: 600, padding: "5px 10px", textAlign: "left", whiteSpace: "nowrap" }}>{children}</th>,
  td:   ({ children }) => <td style={{ color: "var(--text)", padding: "5px 10px" }}>{children}</td>,
};

export default MD_COMPONENTS;
