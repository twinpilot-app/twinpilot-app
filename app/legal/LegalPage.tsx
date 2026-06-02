/**
 * LegalPage — Server Component.
 *
 * Reads the brand-prepared markdown from `public/legal/{file}` at build
 * time, renders to HTML server-side with react-markdown + remark-gfm,
 * and ships pre-rendered HTML to the browser. Avoids dragging
 * `react-markdown` + `remark-gfm` into the client bundle for what is
 * static legal content.
 *
 * The "Back" button needs `useRouter().back()` so it's a small Client
 * Component island; everything else is server-rendered.
 */
import { readFileSync } from "fs";
import { join } from "path";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { brand } from "@/lib/brand";
import BackButton from "./BackButton";

export default function LegalPage({ file, title }: { file: string; title: string }) {
  // brand-prebuild materialises `public/legal/${file}` before next build,
  // so this read is safe in the Server Component render pass.
  let content: string;
  try {
    content = readFileSync(join(process.cwd(), "public", "legal", file), "utf-8");
  } catch {
    content = "_Could not load document._";
  }

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
        <BackButton />
        <span style={{ color: "var(--surface2)" }}>|</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{title}</span>
        <span style={{ fontSize: 11, color: "var(--overlay0)", marginLeft: "auto" }}>{brand.name} · v1.0</span>
      </div>

      {/* Content — rendered at build time, ships as static HTML. */}
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px 80px" }}>
        <div className="legal-page-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
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
