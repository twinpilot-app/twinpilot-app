import { brand } from "@/lib/brand";

export default function MaintenancePage() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      minHeight: "100vh", fontFamily: "system-ui, sans-serif",
      background: "#0e1117", color: "#cdd6f4",
      padding: "24px", textAlign: "center",
    }}>
      <img src={brand.assets.logoOnDark} alt={brand.shortName} style={{ width: 52, height: 52, marginBottom: 28, opacity: 0.7 }} />

      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 12, letterSpacing: "-0.02em" }}>
        We'll be right back.
      </h1>
      <p style={{ fontSize: 15, color: "#a6adc8", maxWidth: 380, lineHeight: 1.7, marginBottom: 8 }}>
        {brand.copy.maintenanceMessage}
        {" "}We expect to be back shortly.
      </p>
      <p style={{ fontSize: 13, color: "#6c7086" }}>
        If you have questions, contact your workspace administrator.
      </p>
    </div>
  );
}
