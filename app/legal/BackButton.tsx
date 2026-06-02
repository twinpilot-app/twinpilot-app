"use client";

/**
 * Small client-island for the legal pages' Back button — needs
 * `useRouter().back()` so it has to ship as a Client Component.
 * Everything else on the legal pages is rendered server-side.
 */
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

export default function BackButton() {
  const router = useRouter();
  return (
    <button
      onClick={() => router.back()}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        color: "var(--overlay1)", background: "none", border: "none",
        cursor: "pointer", fontSize: 13, fontFamily: "var(--font-sans)",
        padding: 0,
      }}
    >
      <ChevronLeft size={15} /> Back
    </button>
  );
}
