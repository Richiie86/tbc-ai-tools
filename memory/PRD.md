# TBC AI Control — PRD

## Original problem statement
Self-replica of an elite AI assistant ("TBC AI Control" + "TBC2 AI Control")
with multi-provider LLM chat, TOTP 2FA, automated + manual payments
(Stripe, Crypto via NOWPayments, Bank, PayPal), 10% referral system,
royalties, and a comprehensive Operator console. Dark ink + champagne
gold theme. Domain: **tbctools.org**.

## Personas
- **End user (member)** — Chats with the AI builder, manages plan, copies referral link.
- **Operator** — Configures plans, treasury, payment gateways, licenses, royalties, projects.

## Implemented
- ✅ React + FastAPI + MongoDB stack with dark ink / champagne gold theme.
- ✅ Auth (email/password) + TOTP 2FA.
- ✅ Multi-LLM chat (GPT-5, Claude, Gemini) via **Emergent LLM Key**, SSE streaming.
- ✅ TBC1 + TBC2 dashboards with session history.
- ✅ Stripe Checkout (native Apple Pay / Google Pay on supported devices).
- ✅ **PayPal Orders v2 REST** (sandbox + live, operator-configurable) — redirect flow.
- ✅ Manual Crypto + Bank Transfer with QR codes + PDF receipts.
- ✅ Referral system (10%) with social-share, landing pages.
- ✅ **Referral sidebar banner** on every chat session (copy-link CTA).
- ✅ Royalties + licenses module.
- ✅ Operator Console (Plans / Treasury / Settings / Payments / Licenses / Royalties / Projects / Users).
- ✅ **Self-serve 2FA reset** — operator can clear any user's TOTP from the Users tab (`POST /api/operator/users/:id/reset-2fa`).
- ✅ **Password reset via email (Resend)** — `/forgot-password` + `/reset-password?token=...` magic-link flow with 30-min expiry, anti-enumeration response, automatic sign-in on success.
- ✅ **Forgot-password rate limit** — 3 / 15 min per email, 10 / 15 min per IP (silent — same generic 200 response). MongoDB TTL collection auto-cleans entries.
- ✅ **Password-strength enforcer** — min 10 chars + 3 of {upper, lower, digit, symbol}; live meter on register + reset pages.
- ✅ Custom TBC gold-swirl logo (Navbar + Footer).

## Architecture cleanup (Feb 2026)
- ✅ Removed circular import between `server.py` ↔ `payments_ext.py` / `referrals_ext.py`
  by extracting the shared Mongo client into `/app/backend/db.py`. Both `server.py`
  and the extension modules now import `db` from there with a one-way dependency.
- ✅ Reduced empty `catch {}` blocks in critical paths (Dashboard, ReferralLanding).
- ✅ Replaced array-index React keys with stable composite keys (PlansTab, Landing).
- ✅ Logo extracted to `/app/frontend/src/components/Logo.jsx` (reusable component).

## Known tech debt (deferred — listed P2 in roadmap)
- 🟡 **localStorage auth tokens** — code review flagged XSS exposure.
  Migrating to httpOnly cookies requires backend session middleware + sameSite/CSRF
  rework + Stripe webhook impact. Deferred — JWT bearer flow currently works.
- 🟡 **High-complexity functions** — `Dashboard.jsx` (333 LOC), `Operator.jsx` (170 LOC),
  `Landing.jsx` (246 LOC), backend `chat_stream()` (94 LOC, CC=17), `op_tx_export()` (CC=20).
  Functional; could be split for maintainability.
- 🟡 27 missing React-hook deps (mostly false positives from `eslint-disable-next-line`
  patterns that are deliberate to prevent re-fetch loops).
- 🟡 NOWPayments crypto-auto flow is key-gated stub (operator-configurable).

## Backlog (P1)
- Wire NOWPayments crypto-auto end-to-end.
- Analytics dashboard (MRR, churn, conversion).
- Email notifications on payment confirmation.

## Backlog (P2)
- Team workspaces / org accounts.
- Discount codes & lifetime deals.
- Split `Operator.jsx` into per-tab route files.
- Migrate auth to httpOnly cookies.

## Deployment
- **Deploy button** (top-right of Emergent chat) → publishes to `*.emergent.host`.
- **Custom domain** (`tbctools.org`): Deployments → Domains → Add custom domain →
  copy CNAME/A record from Emergent → paste into DNS registrar (GoDaddy/Cloudflare/etc.).
- After deploy: Operator Console → Settings → paste Stripe / PayPal / NOWPayments keys.

## Operator credentials
See `/app/memory/test_credentials.md`.
