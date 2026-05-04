# Privacy Policy

**{{brand.name}}** · Version 1.0 · Effective April 9, 2025

> **Legal notice:** This document was drafted to reflect the operational model of the platform and should be reviewed by a qualified attorney, particularly for compliance with Brazil's LGPD (Lei Geral de Proteção de Dados — Law No. 13,709/2018) and the EU GDPR where applicable.

---

## 1. Who We Are

**{{brand.holdingName}}** operates {{brand.name}}, an AI pipeline orchestration platform. We are the data controller for the personal data described in this policy.

Contact: contact@tirsa.software

---

## 2. Data We Collect

### 2.1 Account Data
When you register, we collect:
- Full name or company name
- Email address
- Password (stored as a bcrypt hash — never in plain text)
- Workspace and factory identifiers (slug names)
- Subscription plan

### 2.2 Integration Credentials
When you configure integrations, we store:
- API keys for AI providers (Anthropic, OpenAI, Google, Mistral, Perplexity, xAI, DeepSeek, Qwen, Moonshot AI)
- Trigger.dev secret key
- GitHub personal access token and owner identifier
- Telegram bot token and chat ID

See Section 4 for how these credentials are protected.

### 2.3 Usage Data
We may collect:
- Log data (pipeline executions, errors, timestamps)
- Feature usage patterns (which tabs, integrations, and models are used)
- Browser type, OS, and general location (country level) via server logs

### 2.4 Payment Data
Payment processing is handled by **Stripe** (for web subscriptions). We do not store full card numbers. Stripe's privacy policy governs payment data.

---

## 3. How We Use Your Data

| Purpose | Legal Basis (LGPD) |
|---|---|
| Provide and operate the Platform | Performance of contract |
| Authenticate and authorize access | Legitimate interest / contract |
| Send transactional emails (password reset, alerts) | Contract |
| Improve platform features | Legitimate interest |
| Comply with legal obligations | Legal obligation |
| Marketing communications (opt-in only) | Consent |

We do not sell your personal data to third parties.

---

## 4. API Keys and Sensitive Credential Protection

This section describes the technical and organizational measures applied to integration credentials, which we classify as **sensitive data**.

### Storage
- Credentials are stored in an isolated, access-controlled database table (`tenant_integrations`).
- Values are encrypted at rest by the database infrastructure.
- Access is controlled by Supabase Row Level Security (RLS) and a service-role key that is never exposed to the browser.

### Access Controls
- Credentials are accessed **server-side only**, at the moment a pipeline run requires them.
- No credential value is ever returned in an API response to the browser after the initial save.
- The browser only receives confirmation that a key has been set (masked preview).

### Transit Security
- All communication between your browser, our servers, and our database is encrypted using **TLS 1.2+**.

### Isolation
- Each tenant's credentials are logically isolated. A tenant's credentials are never accessible to another tenant's processes.

### What We Do Not Do
- We do not log API key values in application logs.
- We do not use your credentials for any purpose other than executing the pipelines you configure.
- We do not share credentials with any third party except the intended provider endpoint at runtime.

---

## 5. Third-Party Services

The Platform integrates with the following third-party services, using credentials you supply:

| Service | Purpose | Their Privacy Policy |
|---|---|---|
| Anthropic | AI model inference | anthropic.com/privacy |
| OpenAI | AI model inference | openai.com/policies/privacy-policy |
| Google (Gemini) | AI model inference | policies.google.com/privacy |
| Mistral AI | AI model inference | mistral.ai/terms |
| Perplexity AI | AI model inference | perplexity.ai/privacy |
| xAI | AI model inference | x.ai/legal/privacy |
| DeepSeek | AI model inference | deepseek.com/privacy |
| Qwen (Alibaba) | AI model inference | alibabacloud.com/help/legal |
| Moonshot AI | AI model inference | moonshot.cn/privacy |
| Trigger.dev | Pipeline task orchestration | trigger.dev/legal/privacy |
| GitHub | Code hosting & PR delivery | docs.github.com/en/site-policy/privacy-policies |
| Telegram | Gate notifications | telegram.org/privacy |
| Stripe | Payment processing | stripe.com/privacy |
| Supabase | Database & auth infrastructure | supabase.com/privacy |

When you configure one of these integrations, your credentials are sent to that provider's API endpoints during pipeline execution. We are not responsible for those providers' data practices.

---

## 6. Data Retention

| Data Type | Retention Period |
|---|---|
| Account data | Until account deletion + 90 days |
| Integration credentials | Until you delete the key or cancel account |
| Pipeline execution logs | 90 days rolling |
| Payment records | 7 years (legal requirement, Brazil) |
| Consent records | Duration of account + 5 years |

---

## 7. Your Rights Under LGPD and GDPR

You have the right to:

- **Access** — Request a copy of the personal data we hold about you
- **Correction** — Request correction of inaccurate or incomplete data
- **Deletion** — Request deletion of your personal data (subject to legal retention requirements)
- **Portability** — Receive your data in a structured, machine-readable format
- **Restriction** — Request that we restrict processing in certain circumstances
- **Objection** — Object to processing based on legitimate interests
- **Revoke consent** — Where processing is based on consent, withdraw it at any time
- **Complaint** — Lodge a complaint with Brazil's ANPD (Autoridade Nacional de Proteção de Dados) or your local supervisory authority

To exercise any of these rights, email: **contact@tirsa.software**

---

## 8. Cookies

The Platform uses the following cookies:

| Cookie | Purpose | Expiry |
|---|---|---|
| `supabase-auth-token` | Authentication session | Session / 7 days |
| `tirsa_lang` | UI language preference (local storage) | Persistent |
| `tirsa_wizard_enabled_*` | Feature settings (local storage) | Persistent |
| `tirsa_factory_consent_*` | Consent record (local storage) | Persistent |

We do not use third-party advertising or tracking cookies.

---

## 9. Data Transfers

Our infrastructure is hosted via **Supabase** and may process data in the United States and/or the European Union. We rely on standard contractual clauses and Supabase's DPA for cross-border transfers where required by LGPD or GDPR.

---

## 10. Children

The Platform is not directed at children under 18 years of age. We do not knowingly collect data from minors. If you believe a minor has registered, contact us immediately.

---

## 11. Changes to This Policy

We will notify registered users by email of material changes to this policy at least 15 days before they take effect. Continued use of the Platform after changes constitutes acceptance.

---

## 12. Contact and DPO

For privacy inquiries, data subject requests, or to reach our Data Protection Officer:

**{{brand.holdingName}}**  
Email: contact@tirsa.software  
Website: tirsa.software

Brazil's data protection authority: **ANPD** — gov.br/anpd
