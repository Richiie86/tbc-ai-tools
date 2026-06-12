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
- ✅ **Credit packs auto-seeded** (Feb 2026): `DEFAULT_CREDIT_PACKS` in
  `payments_ext.py` now seeds three packs at startup
  (`credits_100` $9, `credits_500` $39, `credits_1000` $69) idempotently —
  upsert-per-id so re-runs roll forward price edits and existing deployments
  pick them up on next restart. Packs carry `hidden: True` so the public
  `/api/payments/plans` (consumed by /pricing) filters them out, while
  `/api/operator/plans` (Plans tab in the operator console) still lists them
  for price tuning. `_plan_activation_set` was made credit-pack-aware: for
  `kind: 'credit_pack'` purchases we only stamp `credits_last_topped_up_at`
  and rely on the existing `$inc: {credits}` so the user's subscription plan
  is never overwritten by a top-up. Two new regression tests in
  `TestCreditPacks` verify the hidden-from-public + visible-to-operator
  behaviour. Full suite: **19/19 passing**.

- ✅ **Stripe Customer Portal + Credits modal + Ops warn state** (Feb 2026):
  - **Stripe Customer Portal** (`/app/backend/billing_portal_ext.py`,
    `POST /api/billing/portal`): one-tap self-serve invoices / payment method /
    cancellation for any paying user. Looks up the Stripe customer by email
    (no schema change), creates a portal session, returns the URL. Constrains
    the `return_url` to the requesting origin so it can't be used as an open
    redirect. Surfaces a clean 404 with an "upgrade first" hint for users with
    no billing history. Wired into the Navbar dropdown as "Manage billing ·
    invoices" — hidden for free/operator accounts. Helpful error message when
    the Stripe portal config hasn't been activated by the operator yet.
  - **OutOfCreditsDialog** (`/app/frontend/src/pages/dashboard/OutOfCreditsDialog.jsx`):
    fires the moment a user with ≤0 credits hits Send. Three top-up packs
    (100/500/1000 credits, $9/$39/$69) with per-credit price shown, "Popular"
    badge on the 500 pack, graceful fallback to `/pricing` if the pack plan_id
    isn't configured. The draft message stays in the composer so the user can
    send it immediately after top-up.
  - **Ops health-check warn state**: non-RUNNING sidecar services (e.g.
    `code-server`) now render as **amber `warn`** tiles instead of silently
    going green. Backend `_check_services` returns `level: ok | warn | fail`
    (keeps the `ok` boolean for back-compat). Summary now includes
    `warning` count and the header pill reads "N warning — operational" or
    "N issues detected" appropriately. Verified live: 19 ok / 1 warn / 0 fail.
  - Regression tests: `/app/backend/tests/test_p1_refactor.py` now includes
    `TestBillingPortal` (unauth → 401, no-billing-history → 404/503). Full
    suite: **17/17 passing** (1 prior skip preserved).

- ✅ **Credits visibility + P2 cleanup** (Feb 2026):
  - New `CreditsBadge` component (`/app/frontend/src/components/CreditsBadge.jsx`)
    surfaces remaining credits with a colour-coded tone (default tbc-gold,
    amber when ≤25, rose when ≤0) and links to `/pricing` for one-tap top-up.
    Operators see an infinity glyph since their usage is uncapped.
  - Wired into three places so credits are always one glance away:
    (1) global Navbar pill (visible on every authenticated page),
    (2) Dashboard chat header next to the model picker,
    (3) Dashboard sidebar plan-row pill (compact).
    The Navbar dropdown also now shows credits alongside the plan tag and the
    "Upgrade" item label adapts ("Buy credits" when out, "Upgrade · top up"
    otherwise).
  - Empty catch blocks in `frontend/src/lib/api.js` (streamChat JSON-parse +
    SSE-frame parse) and `frontend/src/context/AuthContext.jsx` (`refresh` +
    `logout`) now log via `console.warn` so silent failures show up in dev
    tools while still being non-fatal at runtime.
  - The Code Review #2 `is`-vs-literal antipattern is already absent from
    `trial_emails.py` / `referrals_ext.py` / `payments_ext.py` / `audit_ext.py`
    after the prior refactor passes — only `is None` remains, which is the
    canonical Python idiom and not an antipattern.

- ✅ **P1 refactor — pure decomposition** (Feb 2026): no behaviour change, all 15/15
  regression tests pass.
  - **Backend** `autowithdraw_ext.py` `run_auto_withdraw_once` split into
    `_sweep_stripe` / `_sweep_nowpayments` / `_nowpay_currency_balance`.
  - **Backend** `ops_ext.py` `ops_health` split into eight `_check_*` helpers
    (mongo / env keys / settings keys / master payments / frontend / disk /
    services / commit). Same JSON shape preserved (`payments.master_switch`,
    not `master_payments`).
  - **Backend** `payments_ext.py` `op_test_connection` now dispatches through a
    `_CONNECTION_TESTERS = {paypal, stripe, resend}` table; per-provider helpers
    extracted. `op_tx_export` split into `_parse_export_date_range` (input
    parsing) and `_build_tx_export_pdf` (PDF rendering).
  - **Frontend** large pages broken into focused sub-components under
    `pages/dashboard/` and `pages/operator/<feature>/`:
    Dashboard 486→295 LOC (`TrialBanner`, `ChatMessages` {EmptyState +
    MessageBubble}, `ChatComposer`, `DashboardSidebar`),
    Operator 587→311 LOC (`UsersBulkToolbar`, `UsersTable`, `CodesBrowser`,
    `ContactsList`),
    OpsTab 474→132 LOC (`OpsQuickActions`, `OpsHealthCheck`, `OpsCodeReview`,
    `OpsRestartAndDeploy`, `OpsTrialEmailCron`),
    ProjectsTab 486→180 LOC (`stages.js`, `ProjectStageNav`, `ProjectCard`,
    `ProjectFormDialog`),
    MoneyTab 566→143 LOC (`format.js`, `MoneyTiles`, `ProviderBalances`,
    `RevenueSparkline`, `RecentTransactions`, `WithdrawSettings`,
    `WithdrawHistory`). Regression suite at
    `/app/backend/tests/test_p1_refactor.py` (9 new helper-shape tests).

- ✅ **Code Review #2 P0 fixes** (Feb 2026): (1) `server.py` codes/file endpoint
  now initialises `content = ''` before the file-read try/except so any future
  refactor cannot end up returning an unbound name; (2) `auth_utils.decode_password_reset_token`
  initialises `payload: dict = {}` before the JWT decode try/except for the same
  reason; (3) **sessionStorage XSS removal** — `Login.jsx` no longer mirrors the
  pending-2FA JWT into `sessionStorage`, and `Verify2FA.jsx` was rewritten to
  call `api.post('/auth/2fa/verify', { code })` which relies entirely on the
  short-lived `tbc_session` httpOnly cookie set by the backend at login time;
  (4) **React hook deps** — `Dashboard.jsx` `loadSessions`/`loadMessages`
  converted to `useCallback` with explicit deps and the three `useEffect`s now
  list correct dependencies (no more `eslint-disable-next-line`); the URL→state
  sync effect uses functional setState to avoid the `currentId` loop; (5)
  `ProjectsTab.jsx` `load` is also `useCallback` now. Regression suite:
  `/app/backend/tests/test_p0_review.py` (6/6 passed).
- ✅ **Sign-out-everywhere + token rotation** (Feb 2026): every JWT now carries
  a `tv` (token_version) claim. `POST /api/auth/sign-out-everywhere` bumps the
  user's `token_version` so every existing JWT is rejected on next decode with
  "Session ended on another device. Please sign in again." Available in the
  Dashboard sidebar under regular "Sign out". Cookie is also cleared on the
  current device for a clean break.
- ✅ **Auth hardening: localStorage → httpOnly cookies** (Feb 2026): JWT now
  lives in an `tbc_session` cookie set by the backend on login/register/2fa-verify
  with `HttpOnly · Secure · SameSite=Lax · Max-Age=7d`. JavaScript never touches
  the token, eliminating XSS-token-theft surface. `axios` and the SSE `fetch`
  both use `withCredentials/credentials: 'include'`. `get_current_user` reads
  the cookie first, then falls back to `Authorization: Bearer` so curl/scripts
  and the existing `test_credentials.md` flow keep working. New endpoint:
  `POST /api/auth/logout` clears the cookie. CORS tightened: `allow_origins=['*']`
  replaced with `allow_origin_regex` matching tbctools.org + preview.emergentagent.com,
  which `allow_credentials=True` now requires.
- ✅ **Operator → Audit tab** (Feb 2026): centralized `audit_log` collection +
  `record_audit()` helper hooked into every destructive operator endpoint
  (user pause/resume/delete/credits/set_plan/reset_2fa, bulk actions,
  withdrawals manual/auto, withdraw settings update). Each row captures
  actor email, action, target, JSON details, IP (proxy-aware), timestamp.
  Frontend has action dropdown filter + actor-email contains filter +
  paginated table (50/page) + per-page CSV export. Endpoint:
  `GET /api/operator/audit?limit&skip&action&actor`.
- ✅ **About page copy + compact team cards** (Feb 2026): updated team blurb
  attributing the engine to Emergent; team cards reduced to ~⅓ size with
  smaller avatars/names/role text.
- ✅ **Bulk Users → Export CSV** (Feb 2026): one-click download of selected
  users as CSV (email, name, plan, credits, status, role, totp_enabled,
  joined). Pure client-side — no backend round-trip.
- ✅ **Bulk-action toolbar on Users** (Feb 2026): Per-row checkboxes + select-all
  in the header. When selection > 0, a sticky toolbar appears with Pause /
  Resume / ± Credits (prompts for amount) / Set plan (prompts for plan id) /
  Soft-delete. Self-protection: the operator's own account is auto-skipped
  for destructive actions and reported in the response. Endpoint:
  `POST /api/operator/users/bulk { user_ids, action, credits?, plan? }`.
- ✅ **Auto-withdraw + manual sweep + daily safety cap** (Feb 2026): Per-provider
  on/off toggles (Stripe → bank, NOWPayments → wallet), threshold gating,
  destination address, and an **operator-adjustable daily safety cap** that
  blocks runaway auto loops (Stripe in USD, NOWPayments in asset units).
  Live progress bar shows `used / cap · %` and turns rose when the cap is
  reached. APScheduler runs every 6 hours; cron clamps each payout to the
  remaining headroom inside the 24h window.
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
