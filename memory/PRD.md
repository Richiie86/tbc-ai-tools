# TBC AI Control — PRD

## Original problem statement
Build a self-replica of an elite AI assistant ("TBC AI Control" + variant "TBC2 AI Control")
with multi-provider LLM chat, TOTP 2FA, automated + manual payments (Stripe, Crypto via
NOWPayments, Bank transfer, PayPal), referral system (10% commission), royalties system,
and a comprehensive Operator console. Dark ink + champagne gold theme. Domain: tbctools.org.

## Personas
- **End user (member)** — Chats with the AI builder, manages plan, copies referral links.
- **Operator** — Configures plans, treasury, payment gateways, licenses, royalties, projects.

## What's implemented
- ✅ React + FastAPI + MongoDB full stack with dark ink / champagne gold theme.
- ✅ Auth (email/password) + TOTP 2FA (PyOTP, qrcode).
- ✅ Multi-LLM chat (GPT-5, Claude, Gemini) via **Emergent LLM Key**, SSE streaming.
- ✅ TBC1 + TBC2 Dashboard variants with sessions & history.
- ✅ Stripe Checkout (incl. native Apple Pay / Google Pay on supported devices).
- ✅ **PayPal Orders v2 REST integration** (sandbox/live, operator-configurable) — redirect flow.
- ✅ Manual Crypto + Bank Transfer flows with QR codes, PDF receipts (ReportLab + Segno).
- ✅ Referral system (10%) with social-share buttons & landing pages.
- ✅ Royalties & licenses module (operator-managed).
- ✅ Operator Console (Plans / Treasury / Settings / Payments / Licenses / Royalties / Projects / Users).
- ✅ Custom TBC gold-swirl logo wired into Navbar + Footer (`/brand/logo.jpg`).

## Backlog (P1)
- Wire NOWPayments crypto-auto flow end-to-end (currently key-gated stub).
- Break up `Operator.jsx` into per-tab route files for maintainability.
- Per-environment webhook secret rotation UI.

## Backlog (P2)
- Team workspaces / org accounts.
- Discount codes & lifetime deals.
- Analytics dashboard for the operator (MRR, churn, conversion).

## Deployment
- Use the **Deploy** button (top-right of Emergent chat) to deploy to `*.emergent.host`.
- For custom domain `tbctools.org`: go to **Deployments → Domains → Add custom domain**, then
  add the CNAME / A records shown by Emergent at the user's registrar (GoDaddy/Cloudflare/etc.).
