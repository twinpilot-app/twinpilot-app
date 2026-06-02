"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { X, AlertCircle, CheckCircle2 } from "lucide-react";
import { brand } from "@/lib/brand";

interface WaitlistModalProps {
  open: boolean;
  onClose: () => void;
  defaultEmail?: string;
}

type Status = "idle" | "submitting" | "success" | "error";

export default function WaitlistModal({ open, onClose, defaultEmail }: WaitlistModalProps) {
  const [organization, setOrganization] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string>("");
  const firstInputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setTimeout(() => firstInputRef.current?.focus(), 60);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeRef.current();
    }
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setStatus("idle");
      setMessage("");
    }
  }, [open]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("submitting");
    setMessage("");
    try {
      const res = await fetch("/api/waiting-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organization: organization.trim(), name: name.trim(), email: email.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        setStatus("success");
        setMessage("Thanks — we'll be in touch soon.");
        setOrganization("");
        setName("");
        setTimeout(() => closeRef.current(), 2000);
      } else {
        setStatus("error");
        setMessage(body.error ?? "Could not submit — please try again.");
      }
    } catch {
      setStatus("error");
      setMessage("Network error — please try again.");
    }
  }, [organization, name, email]);

  if (!open) return null;

  const inputStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    marginTop: 6,
    padding: "10px 12px",
    background: "var(--base)",
    border: "1px solid var(--surface0)",
    borderRadius: 8,
    color: "var(--text)",
    fontSize: 14,
    fontFamily: "var(--font-sans)",
    outline: "none",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: 14,
    fontSize: 12,
    fontWeight: 600,
    color: "var(--overlay1)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="waitlist-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8,9,15,0.85)",
        backdropFilter: "blur(6px)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div style={{
        background: "var(--mantle)",
        border: "1px solid var(--surface1)",
        borderRadius: 16,
        padding: "36px 32px 32px",
        maxWidth: 440,
        width: "100%",
        position: "relative",
        boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
      }}>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            background: "transparent",
            border: "none",
            color: "var(--overlay0)",
            fontSize: 22,
            lineHeight: 1,
            cursor: "pointer",
            padding: "6px 10px",
            borderRadius: 8,
            fontFamily: "var(--font-sans)",
          }}
        >
          <X size={18} />
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <img
            src={brand.assets.logoMark}
            alt={brand.shortName}
            style={{ width: 28, height: 28, flexShrink: 0 }}
          />
          <h3 id="waitlist-title" style={{
            fontFamily: "var(--font-heading)",
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            margin: 0,
          }}>
            Join the waiting list
          </h3>
        </div>
        <p style={{ fontSize: 14, color: "var(--subtext0)", marginBottom: 22, lineHeight: 1.5 }}>
          We&apos;ll email you as soon as your organization is eligible.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <label style={labelStyle}>
            Organization
            <input
              ref={firstInputRef}
              type="text"
              required
              maxLength={120}
              autoComplete="organization"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              disabled={status === "submitting" || status === "success"}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Name
            <input
              type="text"
              required
              maxLength={80}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={status === "submitting" || status === "success"}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Email
            <input
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={status === "submitting" || status === "success"}
              style={inputStyle}
            />
          </label>

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={status === "submitting"}
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                background: "transparent",
                border: "1px solid var(--surface1)",
                color: "var(--text)",
                fontWeight: 600,
                fontSize: 14,
                cursor: status === "submitting" ? "not-allowed" : "pointer",
                fontFamily: "var(--font-sans)",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={status === "submitting" || status === "success"}
              style={{
                padding: "10px 24px",
                borderRadius: 8,
                background: status === "submitting" || status === "success" ? "var(--surface1)" : "var(--tirsa-gradient)",
                color: "#fff",
                border: "none",
                fontWeight: 700,
                fontSize: 14,
                cursor: status === "submitting" || status === "success" ? "not-allowed" : "pointer",
                fontFamily: "var(--font-sans)",
              }}
            >
              {status === "submitting" ? "Submitting…" : status === "success" ? "Done" : "Join"}
            </button>
          </div>

          {message && (
            <div style={{
              marginTop: 16,
              padding: "10px 14px",
              borderRadius: 8,
              fontSize: 13,
              lineHeight: 1.5,
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: status === "success" ? "rgba(28,191,107,0.1)" : "rgba(228,75,95,0.1)",
              border: `1px solid ${status === "success" ? "rgba(28,191,107,0.3)" : "rgba(228,75,95,0.3)"}`,
              color: status === "success" ? "var(--green)" : "var(--red)",
            }}>
              {status === "success" ? <CheckCircle2 size={14} style={{ flexShrink: 0 }} /> : <AlertCircle size={14} style={{ flexShrink: 0 }} />}
              {message}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
