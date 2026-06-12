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
- ✅ **Trial reminder emails** (Feb 2026): APScheduler runs every hour
  in-process and dispatches via Resend. Per-user idempotency through
  `users.trial_email_3d_sent_at` and `users.trial_email_expired_sent_at`.
  Two templates (T-3 days + T-0 expired) styled to match the password-reset
  email. Operator-triggered preview + run from Ops tab → "Trial reminder emails"
  card. Endpoint: `POST /api/operator/cron/trial-reminders?dry_run=bool`.
- ✅ **Operator → Money tab** (Feb 2026): live Stripe / PayPal / NOWPayments
  balances pulled per request (never cached). KPI tiles (total revenue, last
  30 days, pending manual reviews, top method). 30-day revenue sparkline +
  recent payments table. Endpoint: `GET /api/operator/money/dashboard`.
- ✅ **Free-trial / time-limited plans** (Feb 2026): `PlanModel.trial_days` field
  (operator-editable in Plans tab). On activation (registration into default plan,
  Stripe/PayPal/manual confirm) the user gets `plan_started_at` and
  `plan_expires_at` set automatically. Chat API enforces expiry with HTTP 402.
  Dashboard shows a live trial banner (days remaining → amber under 3 days →
  rose when expired) with Upgrade-now CTA. Pricing page shows a "{N}-day free
  trial" badge on trial-enabled plans.
- ✅ **"New session" button** now actually creates a session via API and
  prepends it to the sidebar (was previously only clearing local state).
- ✅ **Operator → Ops tab** (Feb 2026): Live health check (MongoDB ping, env keys
  present, DB-backed settings keys, frontend reachability, supervisor service state,
  disk usage, master-payments flag), one-click Code Review (ruff lint + format
  with inline diffable output), Restart Backend/Frontend/All (supervisor soft-restart),
  and a Deploy/Redeploy guidance card with live latest-commit info.
- ✅ **Projects → "Launch in TBC chat"** (Feb 2026): One click on any project
  card spins up a new chat session pre-seeded with the project brief
  (title, stage, tags, link, description) as the first prompt, then navigates
  the operator straight into `/dashboard/<session_id>`. Cross-links the new
  session back to `projects.chat_session_id` for easy reopen.
- ✅ **Projects tab — 5-stage lifecycle sub-sections** (Feb 2026):
  `Code to expand` → `Start new project` → `Under development` → `Launched` → `Running`.
  Per-stage counts, color-coded pills, quick "Promote →" action, legacy status
  auto-migration (`active`/`paused`→`dev`, `done`→`launched`) on list + update.
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
