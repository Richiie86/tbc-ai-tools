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
- ✅ **Inline Vercel domain editor click bug fix** (Feb 2026):
  - Iter_12 testing revealed pencil click on `[data-testid='domain-edit-{id}']` did NOT
    open the inline domain input — an adjacent sibling DOM element was absorbing the
    click. Iter_13 re-verified the fix at 16/16 (100%).
  - Fix in `frontend/src/pages/operator/ops/deploy/ProjectRow.jsx`:
    `relative z-10` on the inline-domain wrapper, pencil hit-area bumped to
    `p-1.5 + h-3 w-3` (was `p-0.5 + h-2.5 w-2.5`), and `type='button'` on the
    pencil to eliminate any form-submit semantics.
  - Full re-test passes: open editor → type → save → toast → close → restore.
    Deploy / Preview / Redeploy / Copy URL / Clone / Code Review / Autopilot /
    Health / Promote AlertDialog all wired correctly. Test report at
    `/app/test_reports/iteration_13.json`.

- ✅ **Unkillable 10% founder royalty + secrets hardening + workspace switcher** (Feb 2026):
  - **Founder royalty baked into code** (`backend/founder_royalty.py`):
    `FOUNDER_EMAIL`, `FOUNDER_LICENSE_KEY`, and
    `FOUNDER_ROYALTY_PCT=10.0` are CODE-LEVEL CONSTANTS — a clone of the
    source must literally edit this file to change them.
    `ensure_founder_license()` auto-runs at every startup, creates the
    pinned license if missing, and SELF-REPAIRS drift (revoked status,
    rewritten holder_email, lowered royalty_pct) back to canonical.
    `record_local_royalty()` hooks into both Stripe-confirm and manual
    payment-confirm paths to (a) stamp a 10% royalty row owed to the
    founder, (b) best-effort phone-home to `FOUNDER_REPORT_URL`. The
    licenses CRUD endpoints refuse DELETE and REVOKE on the founder row
    and force `royalty_pct + holder_email` back on PUT. 7 pytests in
    `test_p6_14_founder_royalty.py`.
  - **Operator-only secrets reveal** (`backend/secrets_ext.py`):
    `POST /api/operator/secrets/reveal` requires `{"confirm": "REVEAL"}`
    (case-sensitive), per-operator 30s rate-limit, audit-logged on every
    success. `GET /api/operator/secrets/inventory` returns presence
    flags + masked previews only — safe to poll. 7 pytests.
  - **Self-Edit Sandbox secret-file denylist**: even when the operator
    has whitelisted `backend/`, `.env*`, `*.pem`, `*.key`, `*.p12`,
    `id_rsa*`, `secrets*`, `credentials*`, `.aws/`, `.netrc`, `.npmrc`
    are HARD-BLOCKED for read AND write — returns 403 "Refusing to
    access secrets path".
  - **Source-download zip skeleton-only README**: rewrote
    `tbctools-self/DOWNLOAD_README.txt` to explicitly enumerate what's
    excluded (Vercel/GitHub/Stripe/PayPal/NOWPayments tokens, customer
    data, operator account, payment history, audit trail) and what
    the recipient must build from scratch.
  - **Workspace switcher in Projects tab**: `WorkspaceSwitcher` component
    with pills for `all` / `default` (untagged) / each registered
    workspace + `+ New` button. Selection persists in localStorage.
    Cloned cards get a gold-tinted pill on workspace tags.
    `GET/POST /api/operator/projects/workspaces` endpoints + 4 pytests.

- ✅ **Clone-all workspace + test-data hygiene + vanish/restore + safety popups** (Feb 2026):
  - **"Clone all to tbc1" workspace** (Projects tab): one-click duplicates
    every operator-owned project into a target workspace (default `tbc1`)
    with a `-{workspace}` suffix and the workspace tag. Idempotent — checks
    both the source's tags AND the destination title so a re-run can't
    create duplicate clones. Bootstraps `crypto-forex-tax-{workspace}` if
    missing so the operator can continue work on it from the new namespace.
    4 pytests in `test_p6_11_clone_all_workspace.py`.
  - **Auto-purge test chat on operator login**: every operator login
    (and every 2FA verify) fires `_purge_test_chat_data()` which deletes
    all chat_sessions + chat_messages belonging to `preview-user@tbctools.dev`.
    Operator-only `POST /api/operator/purge-test-data` for manual trigger;
    new "Purge test data" button in the StatsToolbar (rose-red, with a
    confirm prompt). Real customer data is never touched. Stats now reflect
    real usage instead of accumulated QA chatter. 3 pytests.
  - **Live stats refresh** (Operator.jsx): polls `/operator/stats` every
    25s while the tab is foregrounded, pauses on `visibilitychange`,
    rehydrates immediately on focus return.
  - **Vanish (permanent delete) + protection**: hard-delete endpoint
    `POST /api/operator/users/{id}/vanish` requires `confirm_email` to
    match the target's exact email; UI replays this via an AlertDialog
    typed-confirmation field. Operator/admin roles cannot be vanished or
    soft-deleted from this endpoint (`Demote the user first` guard).
    Bulk endpoint skips protected roles automatically. Per-row "🔒 Protected"
    badge replaces destructive buttons for protected roles. 10 pytests
    across `test_p6_8_vanish.py` and `test_p6_9_operator_protection.py`.
  - **Seeded preview-user warning popup**: clicking Delete or Vanish on
    `preview-user@tbctools.dev` opens a special amber-bordered AlertDialog
    explaining the consequences before proceeding to the regular flow.
    Operator can Cancel and the action is aborted.
  - **Restore (undo soft-delete)**: per-row + bulk action, idempotent,
    audited. `resume` no longer accidentally undeletes (separate action).
    5 pytests in `test_p6_7_restore.py`.
  - **Vercel-style typed-confirmation on Promote-to-Prod**: AlertDialog
    requires operator to type the project name before Confirm enables.

- ✅ **Growth-alert thresholds + 4 polish tasks** (Feb 2026):
  - **Alert thresholds** (new `alerts_ext.py`): operator sets a signup-drop
    % and revenue-stall-days, plus delivery channels (email via Resend,
    Slack webhook, Discord webhook). Background `_alerts_job` runs every
    6 h, evaluates once per UTC day (idempotent via `last_fired_day`), and
    fans out via every configured channel. Webhook URLs are masked on read,
    submitting the masked value preserves the saved secret (round-trip
    safe). `POST /alerts/test` fires a hello-world through all channels;
    `POST /alerts/run-now` force-evaluates (bypasses idempotency).
    Frontend `AlertsCard.jsx` (in Analytics tab below Growth snapshot)
    surfaces the full config + Save / Test channels / Evaluate now CTAs.
    5 new pytests in `test_p6_6_alerts.py`. **93/93 backend tests pass.**
  - **AlertDialog for Promote** (P2): replaced `window.confirm` in
    `ProjectRow.promote()` with a shadcn AlertDialog so the visual
    language matches `ShipGateDialog`. New testids
    `promote-confirm-{id}` / `promote-cancel-{id}` /
    `promote-confirm-btn-{id}`.
  - **TestUserBanner out of loading guard** (P2): now mounted directly
    under the page title, independent of `/operator/stats` resolving.
  - **`useProjectActions` hook** (P2): extracted every callback +
    dialog state out of ProjectRow.jsx into
    `/operator/ops/deploy/useProjectActions.js`. ProjectRow.jsx
    574 → 408 lines, hook 234 lines, callbacks unit-testable in isolation.
  - **Skip 2FA setup link** (P3): button on `/setup-2fa` navigates straight
    to `/operator` (or `/dashboard` for non-operators) — purely client-side,
    NO API call, does NOT reset the operator's password/2FA. The existing
    session token stays valid.

- ✅ **Revenue analytics dashboard** (Feb 2026):
  - New backend endpoint `GET /api/operator/analytics/30d` aggregates
    paid `payment_transactions`, new `users`, `referral_earnings`, and
    birthday `user_notifications` into 4 daily series + 30-day totals.
    Zero new collections — built off existing data.
  - New `Analytics` tab in the Operator Console (between Users and
    Projects) with four sparkline metric cards (Revenue / Signups /
    Referrals / Birthday credits), each with a 7d-vs-7d delta pct, and a
    "Growth snapshot" band of derived KPIs (avg signups/day, avg revenue/day,
    referral attribution %, birthday rewards/day). Inline SVG sparklines —
    no chart library added so the bundle stays lean.
  - 3 new backend tests in `test_p6_5_analytics.py` (auth-required, shape,
    seeded-data delta). Backend suite now **88/88**.

- ✅ **Component refactor + UI gaps closed + GitHub webhook live-validated** (Feb 2026):
  - **Refactor**: Operator.jsx 444→158 lines; Dashboard.jsx 380→343 lines.
    New modules: `operator/StatCard.jsx`, `operator/StatsToolbar.jsx`,
    `operator/UsersTab.jsx`, `dashboard/DashboardHeader.jsx`,
    `operator/BirthdayRewardsCard.jsx`.
  - **UI gaps fixed** (caught by iteration_9 frontend agent):
    - `TestUserBanner` is now actually mounted inside `Operator.jsx`
      under the StatsToolbar — surfaces seeded preview-user creds with
      copy + "Open as test user" CTA.
    - `BirthdayRewardsCard` shipped to Settings/Security tab — operator
      can toggle the programme on/off, tune credits + % discount,
      edit the message template (with `{credits}`/`{discount_pct}`/`{name}`
      placeholders), Save, and "Run pass now" for QA. Persistence
      verified by retest (credits 200→275, discount 10→15 survive reload).
    - `ProjectRow.jsx` gained two NEW per-row controls:
      `promote-{projectId}` (Promote-to-Prod button, disabled with helpful
      title until a Preview exists) and `auto-promote-{projectId}`
      (shadcn Switch wired to PATCH /api/operator/deploy/{id} → success
      toast + auto-promote badge appears next to the project name).
  - **GitHub webhook validated**: new pytest
    `backend/tests/test_p6_4_github_webhook.py` (5 tests, all passing) —
    covers ping/pong, push with valid HMAC signature → project matched
    + deploy triggered, push with bad signature → invalid_signature,
    push for unknown repo → matched:0, non-push event ignored.
    Backend suite now at **90/90** (was 80/80; +5 webhook +5 already
    in place).

- ✅ **Clickable stat cards + delete messages + Dashboard tour** (Feb 2026):
  - **Clickable stat cards**: Operator Console header stats (Total Users /
    Paid Customers / Total Messages / Revenue) are now full-width buttons
    that jump to the relevant tab. Each card shows a tiny hint underneath
    (e.g. "Read messages") so the affordance is obvious. testid:
    `stat-card-{label-kebab}`.
  - **Delete contact messages**: new backend endpoints
    `DELETE /api/operator/contacts/{id}` (single) +
    `POST /api/operator/contacts/bulk-delete` (`{ids:[...]}` or `{all:true}`).
    Frontend ContactsList now renders a per-row trash icon
    (`contact-delete-{id}`) and a "Delete all" button at the top of the
    inbox (`contacts-delete-all`). Parent re-fetches stats + contacts on
    every change so the badge updates immediately.
  - **Dashboard quick guide**: 4-step `/dashboard` tour (The chat → Model
    picker → Sessions → Credits & billing) with the same auto-open-once +
    "Guide" button pattern as the Operator one (separate localStorage key
    `tbc_dashboard_tour_seen_v1`, separate testids
    `dashboard-guide-tour`, `dashboard-guide-skip/prev/next`,
    `open-dashboard-guide`).

- ✅ **Password-overwrite bug fix + Operator quick guide** (Feb 2026):
  - **Bug fix (HIGH)**: pasting any API key (Emergent LLM Universal Key,
    Stripe, NOWPayments, Resend, PayPal, Vercel PAT, GitHub PAT) into the
    operator's Security/Ops tabs was silently overwriting the operator's
    SAVED LOGIN PASSWORD in the browser. Chrome / 1Password / LastPass /
    Bitwarden were misidentifying the secret-token inputs as a password
    change form. Fix: every secret `<Input type="password">` now ships with
    `name="secret-<fieldKey>"`, `autoComplete="off"`,
    `data-1p-ignore="true"`, `data-lpignore="true"`, `data-bwignore="true"`,
    `data-form-type="other"`, `spellCheck={false}`. Applied to the shared
    `KeyRow` in `SettingsTab.jsx` (covers Stripe, NOWPayments, PayPal,
    Resend, Emergent LLM, Vercel, AI API key, deploy_webhook_secret) and the
    two standalone inputs in `OpsDeploySection.jsx` (Vercel + GitHub token).
  - **Operator quick guide**: new `OperatorGuideTour.jsx` walks first-time
    users through every tab (Users → Projects → Plans → Payments → Treasury
    → Money → Licenses → Royalties → Security → Ops → Audit → Contacts →
    Codes — 13 steps). Each step has a title, body, optional tip card, and
    a progress bar. Tour auto-opens on first visit (localStorage flag
    `tbc_operator_tour_seen_v1`) and can be re-launched any time via the
    new **Guide** button (`open-operator-guide`) in the Console header.
    Tabs are now controlled (`activeTab` state) so the tour jumps the
    active tab as it advances.

- ✅ **Auto-fix until ship** (Feb 2026):
  - New `deploy/auto_fix.py` module: `request_patches()` asks the LLM for a
    strict JSON patch set (`[{path, content, rationale}]` + commit message),
    fetching current file contents via the GitHub Contents API as context.
    `commit_patches()` PUTs each patched file back to the project's tracked
    branch (one commit per file with shared message + rationale suffix).
    Caps: 80 KB per patched file, 60 KB total LLM context, ≤5 iterations.
  - Autopilot loop now accepts `auto_fix_max_iterations: int = 0`. When
    > 0 and a verdict is `do_not_ship`, the loop emits new events
    `auto_fix_start → auto_fix_patches → auto_fix_committed`, re-runs the
    review on the new HEAD, and repeats until verdict crosses to ship or
    iterations run out (then `gate_blocked` fires with the seeded fix
    chat). Hard-capped at 5 server-side so a runaway caller value (e.g.
    999) is silently clamped.
  - AutopilotDialog: new "Auto-fix iterations" select
    (`autopilot-autofix-{id}`) with 0/1/2/3/5 options. Disabled while
    "Bypass review gate" is checked. Auto-fix events rendered with
    severity-coded entries listing the patched paths + clickable commit
    hashes.
  - **Audit trail**: every successful auto-fix run is appended to
    `deploy_projects.auto_fix_history` (capped at 20 entries) so the
    operator can review past fix attempts even after the dialog closes.
  - **Tests**: new `tests/test_p5_auto_fix.py` (4 tests):
    `test_disabled_autofix_still_blocks`, `test_autofix_converges_to_ship`,
    `test_autofix_exhausted_emits_gate_blocked`,
    `test_autofix_max_iterations_hard_capped`. Bumped p4 + p5 to
    `loop_scope='session'` so motor mongo client shares one loop. Backend
    now at **60 passed + 1 skipped**.

- ✅ **Deploy submodule split + github_token UI** (Feb 2026):
  - **Refactor**: `deploy_projects_ext.py` shrunk from **1634 → 1183 lines**
    by extracting two submodules into `/app/backend/deploy/`:
    - `code_review.py` — `fetch_repo_snapshot()` + `run_code_review()` +
      `op_code_review` / `ai_code_review` route handlers
    - `autopilot.py` — `AutopilotRequest` + `_sse()` + `_autopilot_stream()`
      + `op_autopilot` / `ai_autopilot` route handlers
    Parent module imports the submodules from inside `setup_routers()` for
    decorator side-effects (one-way import, no cycle).
  - **GitHub token in Operator → Security**: new `github_token` field on
    `KeyUpdate` model + `has_github_token` flag on the status endpoint.
    Frontend KeysCard now renders a **3-column grid** with the new card
    (testids `deploy-key-github-token` + `deploy-key-github-save`). Tooltip
    explains it lifts the GitHub API limit from 60/hr → 5 000/hr and unlocks
    private-repo downloads + code reviews. Helper link to GitHub's
    fine-grained PAT page.
  - **Tests**: `tests/test_p4_autopilot.py` fixture updated to monkeypatch
    `deploy.autopilot.run_code_review` (new location). Backend still at
    **56 passed + 1 skipped**.

- ✅ **Autopilot loop + useInlineDomain hook + chat-scroll constant** (Feb 2026):
  - **Autopilot SSE loop** (`POST /api/operator/deploy/{id}/autopilot` and
    `POST /api/projects/{id}/autopilot`) — runs `review → ship → watch → react`
    end-to-end and streams progress as Server-Sent Events. Frame types:
    `loop_start`, `review_start`, `review_done`, `gate_blocked`,
    `deploy_start`, `deploy_started`, `deploy_state` (one per Vercel poll),
    `deploy_ready`, `health_check`, `loop_complete`, `loop_error`. Honours
    the ship-gate by default; operator can override with `bypass_review:true`.
    Watch step polls Vercel every 4s up to `watch_timeout_s` (default 90s).
  - **AutopilotDialog.jsx** — new modal with target selector, bypass
    checkbox, live typed-event timeline. Consumes SSE via
    `fetch + ReadableStream`. When the loop ends in `gate_blocked`, an
    `autopilot-open-fix-{id}` button jumps to the seeded fix chat.
  - **useInlineDomain.js** — extracted the inline domain editor from
    `ProjectRow.jsx`. Owns `editing`/`draft`/`saving`, PATCH on commit, and
    `Enter` / `Escape` keyboard shortcuts.
  - **STICK_TO_BOTTOM_THRESHOLD_PX = 80** — chat-scroll threshold lifted to
    a module-level constant in `Dashboard.jsx`.
  - **Tests**: `tests/test_p4_autopilot.py` (6 SSE tests via httpx
    ASGITransport with monkeypatched `_run_code_review`). Backend now at
    **56 passed + 1 skipped**.

- ✅ **Deploy card layout v2 + Code Review + Code Download** (Feb 2026):
  - **Standardized button row** on every deploy project card:
    `Deploy · Preview · Redeploy · Copy URL · Clone · Download · Code Review · Health`.
  - **Copy URL / Clone (POST /clone) / Inline domain editor (PATCH /domain)**.
  - **Run code review** — `POST /api/operator/deploy/{id}/code-review` snapshots
    repo via GitHub API → `gpt-4o` via emergentintegrations → structured
    JSON verdict, summary, findings, missing-files; persisted on the project
    as `last_code_review` and rendered in `CodeReviewDialog`.
  - **Per-project code download** — proxies GitHub's zipball as a streaming
    response.
  - **Self-source download** — `GET /api/operator/deploy/self/download-app`
    zips `/app` (skipping node_modules/.git/build/.env-contents), adds a
    DOWNLOAD_README.txt, ~580 KB at the moment of writing.

- ✅ **Ship-gate + Chat-scroll preservation + Deploy refactor** (Feb 2026):
  - **Ship-gate (production deploys)**: `_trigger_deploy` now refuses
    production targets with `HTTP 412 {detail:{error:'review_blocked',
    review, fix_chat_session_id, message}}` whenever the project's most
    recent `last_code_review.verdict == 'do_not_ship'`. Preview deploys are
    unaffected so the operator can sanity-check fixes before re-running the
    review.
  - **Auto-seeded "fix chat"**: when the gate fires we synthesously create a
    fresh `ChatSession` owned by the operator + a single user message that
    embeds the failing review summary, every finding (severity-tagged), and
    asks the AI to propose concrete patches. Returned id is surfaced to the
    UI so one click jumps straight to the conversation.
  - **Operator override**: `DeployRequest.bypass_review: bool = False`. When
    the operator clicks "Ship anyway" the front-end re-issues the deploy with
    `bypass_review=true`. AI-surface callers can also override but default
    stays safe so autonomous agents have to make an explicit decision.
  - **ShipGateDialog.jsx** — new modal lists up to 6 findings + total counts
    + two action buttons ("Open fix chat" / "Ship anyway") with full testid
    surface (`ship-gate-{id}`, `ship-gate-bypass-{id}`,
    `ship-gate-open-chat-{id}`, `ship-gate-finding-{id}-N`). Auto-closes on
    ANY deploy outcome (success or non-gate error) so it never lingers.
  - **Chat scroll fix**: Dashboard.jsx no longer force-pins to the bottom
    on every streamed token. New `stickToBottom` state flips off as soon as
    the user scrolls > 80px above the bottom; the `onScrollContainer`
    handler re-arms it when they scroll back down. A floating
    `data-testid="jump-to-latest"` button appears when not pinned (and there
    are messages) — clicking it scrolls to the latest and resumes following.
  - **OpsDeploySection refactor**: 850 → 350 lines. Extracted
    `CodeReviewDialog.jsx`, `CloneProjectDialog.jsx`, `ProjectRow.jsx`,
    `ShipGateDialog.jsx` into `/app/frontend/src/pages/operator/ops/deploy/`.
    `window.prompt` replaced by a shadcn Dialog for cloning
    (`clone-dialog-{id}` + `clone-dialog-name-{id}` + `clone-dialog-confirm-{id}`).
  - **Regression**: backend now at **50 passed + 1 skipped** with the new
    `tests/test_p3_ship_gate.py` (6 tests: production 412 / shape / chat
    seeded / bypass / preview / AI surface).


  - **Standardized button row** on every deploy project card:
    `Deploy · Preview · Redeploy · Copy URL · Clone · Download · Code Review · Health`
    (testids: `deploy-{id}`, `copy-url-{id}`, `clone-{id}`, `download-{id}`,
    `code-review-{id}`, `health-{id}`, etc).
  - **Copy URL** — copies the project's preview URL (or domain URL) to the
    clipboard via `navigator.clipboard.writeText`; swaps icon to ✓ for 1.5s.
  - **Clone / Make a copy** — `POST /api/operator/deploy/{id}/clone` returns a
    fresh project that mirrors the source repo + branch with a BLANK domain
    (Vercel won't accept two projects on one host). UI prompts for a new name.
    Mirror endpoint on the AI surface: `POST /api/projects/{id}/clone`.
  - **Inline domain editor** — pencil icon next to every domain; new clone
    rows auto-open the editor so the operator can paste a fresh URL without
    leaving the tab. Backed by `PATCH /api/operator/deploy/{id}/domain`.
  - **Run code review** — `POST /api/operator/deploy/{id}/code-review` (AI mirror
    on `/api/projects/{id}/code-review`). Pulls a snapshot of the repo via the
    GitHub API (capped at ~10-30 high-signal files, 40k chars), hands it to
    `gpt-4o` via `emergentintegrations.LlmChat` with a strict JSON schema
    prompt, parses + persists `last_code_review` on the project doc. Modal
    UI renders verdict, summary, findings (severity-coded), suggested fixes,
    and any missing-files callouts. Optional `github_token` in operator
    settings unlocks private repos + higher rate limits.
  - **Per-project code download** — `GET /api/operator/deploy/{id}/download`
    proxies GitHub's zipball endpoint as a `StreamingResponse` so a multi-MB
    repo never buffers in memory. UI button uses a programmatic `<a download>`
    so the auth cookie travels with the request.
  - **Self-source download** — `GET /api/operator/deploy/self/download-app`
    walks `/app` and zips every code/config file (skips `node_modules`,
    `.git`, `.next`, `__pycache__`, build dirs, .venv, etc). `.env` contents
    are stripped and replaced with a "set your own keys" placeholder so the
    zip carries no live secrets. Adds a `DOWNLOAD_README.txt` with run
    instructions. Triggered from a top-right "Download this app" button in
    the Vercel deploys section. AI-surface mirror exists for autonomous
    grow-and-fork flows.
  - Backend regression: 28 prior tests still green; 16 new tests in
    `tests/test_p2_deploy_extras.py` cover clone / domain PATCH / download /
    self-download / code-review-reachable / .env-sanitization. **44 passed,
    1 skipped** (`pytest -q tests/`).

- ✅ **Webhooks + ship-and-watch + self-deploy + per-project health** (Feb 2026):
  - **Outbound webhooks** — operator-configurable URL + HMAC-SHA256 secret in
    Security tab. Fires `deployment.triggered` / `deployment.state_changed` /
    `deployment.succeeded` / `deployment.failed`. Signed via `X-TBC-Signature: sha256=…`.
  - **Ship-and-watch** — every deploy spawns a 10-minute background poller
    (`_watch_deployment`) that polls Vercel every 10s, updates the persisted
    project state, and fires a webhook on each transition + a terminal event.
    Best-effort + bounded so a stuck deploy can never leak the asyncio task.
  - **Self-deploy** — magic project id `tbctools-self` auto-upserts from the
    new `self_repo` / `self_git_ref` / `self_vercel_project_id` Settings
    fields. Endpoints: `POST /api/operator/deploy/self/deploy` (cookie) and
    `POST /api/projects/self/deploy` (Bearer-auth). Literal routes are
    registered before the parameterised `/{project_id}/deploy` so they don't
    get shadowed. Ops tab "Deploy this app" button just works after one paste
    in Security.
  - **Per-project health check** — `POST /api/operator/deploy/{id}/healthcheck`
    + AI-surface mirror at `POST /api/projects/{id}/healthcheck`. HTTP-pings
    the project's public domain, overlays the latest Vercel deployment
    state, and updates the persisted `last_deployment_state` as a side effect.
    Returns `{ok, http_status, latency_ms, vercel_state, error}`. New
    "Health" button per project row + a coloured pill that lights green for
    `ok` or rose for `down`.
  - **Security tab keys** — Vercel PAT, Team ID, AI API key, webhook URL,
    webhook secret, self_repo / self_git_ref / self_vercel_project_id all
    editable from the existing Security UI (same `/operator/settings` PUT
    used by other keys; presence + masked echo only — plaintext never leaves
    the server after first save).
  - **"View last preview"** link on each project row jumps to the most recent
    Vercel deployment URL the watcher recorded.
  - All 28 backend regression tests still passing.

- ✅ **AI-surface deploy endpoints** (Feb 2026): Closed the AI→ship loop.
  Refactored the deploy logic into `_trigger_deploy` / `_trigger_redeploy`
  shared helpers and exposed them on both the operator (cookie auth) and the
  AI-agent (Bearer auth) surfaces:
  - `POST /api/projects/{id}/deploy`  body: `{"target": "production"|"preview", "git_ref"?}`
  - `POST /api/projects/{id}/redeploy`
  Same JSON shape as the operator endpoints. Verified end-to-end:
  401 (no bearer), 401 (bad bearer), 400 (bad target), 404 (unknown project),
  400 (redeploy without prior deploy), 503 (Vercel token not configured).
  Five new regression tests in `TestAIDeployEndpoints`. **Suite 28/28 passing.**

- ✅ **Vercel Deploy integration + Projects API for AI agents** (Feb 2026):
  - **`/api/projects` (AI surface, Bearer-token auth):** full CRUD matching the
    documented contract — `POST` create-or-update, `GET` list / get-one, `DELETE`
    one. Token is the `ai_api_key` stored in `payment_settings`; constant-time
    compared against the `Authorization: Bearer …` header. Generated by the
    operator from the Security/Ops tab; the plain-text value is shown **once**
    and never echoed back on subsequent fetches.
  - **`/api/operator/deploy/*` (Operator surface, cookie auth):**
    `GET /key` (presence flags only — never leaks token values),
    `POST /key` (save Vercel token / team id, regenerate AI key),
    `GET /projects` (operator view of all projects),
    `POST /{id}/deploy` (calls Vercel `POST /v13/deployments`),
    `POST /{id}/redeploy` (calls `/v13/deployments/{id}/redeploy`).
  - **Vercel REST calls** via direct `httpx.AsyncClient` (no SDK), same
    pattern as our Stripe / NOWPayments integrations. We auto-persist
    `vercel_project_id` + `last_deployment_*` fields onto the project doc on
    success so the Ops tab can show "Last deployed: X · state".
  - **PaymentSettings** gained three new optional fields:
    `vercel_token`, `vercel_team_id`, `ai_api_key`.
  - **Ops tab UI** — new `OpsDeploySection` (between Health Check and Code
    Review) with two halves: a **Deploy Keys** card (Vercel PAT + Team ID +
    "Generate / Rotate AI API key" — revealed-once amber callout matches the
    Stripe Customer Portal UX) and a **per-project list** with Deploy /
    Redeploy / Preview buttons. Redeploy is disabled until the project has a
    first deployment. Public domain links in each row.
  - Regression tests: `TestDeployProjectsAPI` (4 cases — unauth, invalid
    bearer, full create/list/get/update/delete lifecycle, secret-leak check).
    **Full suite 23/23 passing.**

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

## Session 2026-02 — Operator productivity + revenue UX batch

### Implemented
- **Plans editor — % off + Discount Campaign.** Each plan row now has a
  `% off` field that auto-recomputes `price` from `regular_price`. Operator
  can also fire a global campaign (`POST /api/operator/plans/discount-campaign`)
  to apply or clear a discount across every plan in one click.
- **Scrolling Marketing Banner.** Public `GET /api/marketing/banner`,
  operator `PUT /api/operator/marketing/banner` (Marketing tab). Right-to-left
  ticker mounted globally on every public page; users can dismiss per campaign.
- **In-chat deploy controls + Preview-Ready Pill.** Operator-only header
  control with Deploy / Code Review / Health Check buttons bound to a
  selected deploy project. After a successful redeploy the suggestion
  morphs into a "Your Preview is ready" pill (sandboxed iframe thumbnail)
  above the message composer — clicking opens the live URL.
- **Per-project Settings page** at `/operator/projects/:projectId/settings`
  with admin email/password (bcrypt-hashed), key-rotation-style env-vars
  list with masked previews, and Deploy/Redeploy/Health/Code-Review buttons.
- **GitHub PAT field** in Operator → Security so auto-fix and private-repo
  code review can commit patches.
- **Notifications + Messaging.** `notifications_ext.py` adds operator DMs,
  filterable broadcasts (`only_no_2fa`, `only_paid`, explicit ids), and a
  one-click `/operator/notify/2fa-reminder` that nudges every user without
  TOTP. Users see them via the new Bell icon in the dashboard.
- **Credits Adjuster popover** replaces the hard-coded `+100` button. Add
  or Deduct with 100/250/500/1000 quick chips or a custom amount.
- **Auto-credit referrals.** When a referred user pays, the referrer
  *instantly* receives `referral_pct%` of the credits purchased (e.g. 250
  credits on a Pro purchase). The earning row is marked `status='credited'`
  and a bell notification is dropped. UI updated to "Earn 10% on every
  payment — in credits" with a `credits_awarded` stats card.

### Endpoints added
- `POST /api/operator/plans/discount-campaign`
- `GET  /api/marketing/banner`  (public)
- `PUT  /api/operator/marketing/banner`
- `GET/PUT /api/operator/deploy/{project_id}/settings`
- `GET  /api/notifications`, `POST /api/notifications/{id}/read`,
  `POST /api/notifications/read-all`, `DELETE /api/notifications/{id}`
- `POST /api/operator/users/{user_id}/notify`,
  `POST /api/operator/notify/broadcast`,
  `POST /api/operator/notify/2fa-reminder`,
  `GET  /api/operator/notify/audiences`

### Tests
- New: `/app/backend/tests/test_p6_session_features.py` (14 tests),
  `/app/backend/tests/test_p6_1_referral_credits.py` (2 tests),
  `/app/backend/tests/test_p6_2_operator_delete_audit.py` (2 tests),
  `/app/backend/tests/test_p6_3_promote_to_prod.py` (2 tests).
- Full suite: **80 passed, 1 skipped** (no regressions).

### "Ship preview to prod" gate
- Backend: `_vercel_promote_to_production()` + endpoints
  `POST /api/operator/deploy/{id}/promote` (operator JWT) and
  `POST /api/projects/{id}/promote` (AI bearer). Both reuse the existing
  preview's build artifact via Vercel's `/v10/projects/{id}/promote/{deploymentId}` —
  no rebuild, no git fetch, fastest possible "ship what I just eyeballed".
- Frontend: a green **Promote to prod** button appears inside the in-chat
  `PreviewReadyPill` (right after a successful redeploy) and in the
  per-project Settings action bar. Confirms first, fires the API, swaps
  the pill copy to "Promoted to production" with a live badge.
- Audit log: every promote captures actor email + deployment id + final
  production URL under `action='deploy_project.promote'`.

### Secrets card (Vercel + GitHub rotation UI)
- New `/app/frontend/src/pages/operator/SecretsCard.jsx` — dedicated
  rotation-friendly UI at the top of Operator → Security.
- Each row has Paste → **Test** (live ping to Vercel/GitHub identity
  endpoints) → **Rotate** (saves + auto-clears the input + stamps
  `*_rotated_at`). "Rotated N days ago" badge turns amber > 60 d, red > 90 d.
- Backend: `POST /api/operator/keys/test` validates a token before save;
  PUT `/api/operator/settings` stamps `vercel_token_rotated_at` /
  `github_token_rotated_at` automatically.

### Backlog
- Audit log filter for deploy_project deletions (P2).
- End-to-end Vercel/GitHub loop verification with real tokens (P1, blocked on user-provided creds).
- Email transport for notifications (currently in-app only) (P2).
