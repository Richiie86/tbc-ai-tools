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

## Implemented — Feb 2026 (latest session, batch 18)
- ✅ **Landing footer "All systems operational" pill** — `StatusPill.jsx` fetches `/api/status` every 60s, renders a coloured-dot pill (`operational`=emerald, `degraded`=amber, `outage`=rose) next to the copyright. Pulses softly to signal live data. Click → `/status` page. Gracefully hides on fetch failure (no scary red dot during mid-deploy).
- ✅ **Footer Company column** now also links to `Changelog` and `Status` (next to Contact / Privacy / Terms).
- ✅ Live-verified: pill shows amber "Degraded performance" while AI test probes are failing in this preview (matches `/status` page overall verdict).

## Implemented — Feb 2026 (previous session, batch 17)
- ✅ **Self-heal status widget** on `/status` page footer — `status_ext.py` `_self_heal_stats()` adds `self_heal: {opened_24h, merged_24h, pending}` to the public status response (counts auto-fix / auto-fix-drift / auto-fix-health plan rows in the last 24h). Frontend `Status.jsx` renders an emerald-bordered widget above the footer with the wand icon + counts + amber clock for pending; only displays when there's actual activity (no clutter on quiet weeks).
- ✅ **Public anonymous bell fix** — `WhatsNewPopover` now skips the authenticated `/api/changelog` fetch when no session cookie/token is present, silencing the harmless 401 in the browser console on `/changelog` and other public pages.
- ✅ **Footer cross-link** to "What's new" added on the status page.

## Implemented — Feb 2026 (previous session, batch 16 — backlog sweep)

- ✅ **Public `/changelog` page** — `ChangelogPage.jsx` + new anonymous `GET /api/changelog/public`. Marketing-trust signal for tbctools.org with "What we've shipped" hero, per-entry cards (title, body, tag pill, "deploy" badge, timestamp), and footer links to `/status` + `/contact`.
- ✅ **Operator changelog editor** — `ChangelogManagerCard.jsx` in Operator → Settings → "Changelog ('What's new')". Form for title (200 chars), body_md (8000 chars), optional tag, plus a recent-entries list with delete buttons. Reuses existing `POST` / `DELETE` endpoints.
- ✅ **Health-check sweep for the auto-fix loop** — `_auto_fix_health_sweep()` runs alongside the runtime-error + drift sweeps when `include_health=true`. Probes each project's public URL via httpx, throttled to once-per-hour-per-project, queues a fix PR with the failure detail pre-loaded when probe returns non-2xx. New amber toggle "Include health-check sweep" in AutoFixCard (third corner of the self-healing triangle: errors + drift + downtime).
- ✅ **TTL GC for `ai_build_plans`** — new scheduler job every 6h that drops draft/refused/discarded plans older than 24h. Opened plans (audit trail) stay forever.
- ✅ **Operator Tabs first-load double-click race FIXED** — replaced dual `activeTab` state + URL-sync `useEffect` with a single derived `searchParams.get('tab')` source of truth. Eliminates the race between the 8s stats poll re-render and the tab-syncing effect that caused the first click after page load to "miss".
- ⏭️ **Dashboard.jsx decomposition — DEFERRED** to a future session. File is currently 506 LOC and 100% passing tests; a clean split (SessionsSidebar / ChatHeader / MessageList / ChatComposer) is straightforward but high-touch and would benefit from a dedicated review iteration.

## Implemented — Feb 2026 (previous session, batch 15)
- ✅ **End-of-Session action bar in chat** — `EndOfSessionActions.jsx` renders BIG pill buttons under the last assistant message of every completed session, matching the Emergent-style strip the operator showed in the screenshot:
  - 🚀 **Deploy** (blue→tbc gradient)
  - 🛡️ **Run Code Review** (emerald gradient)
  - 🛠️ **Fix Errors** (amber→rose gradient) — only visible when the assistant's last message contains `error / exception / traceback / failed / crash / undefined / cannot read`. Click → deep-links to `/operator?tab=ai-build` with the assistant's text pre-filled as a fix prompt.
- ✅ **`handleInlineAction('fix-errors')`** — bypasses the projectId guard (AI Build has its own picker), reads the last assistant message, builds a structured fix prompt, navigates to AI Build with `prefill_prompt` + `prefill_error_id=chat_<sessionId>` so the existing AIBuildTab consumer pre-fills the form + shows the green "Pre-filled from runtime error X" banner.
- ✅ **Per-user analytics drill-down** — `user_analytics_ext.py` exposes `GET /api/operator/users/{id}/analytics` returning messages (total / 30d / 7d), active_days (distinct + 30d sparkline), sessions (total / 30d), payments (total_usd, completed_count, last_payment_at). UI: `UserAnalyticsModal.jsx` opens on click of any user's email in the Operator → Users table; 4-stat header, 30-day sparkline, key-value detail grid. Pause + credit-adjust actions remain in the existing table row (no duplication).

## Implemented — Feb 2026 (previous session, batch 14)
- ✅ **Auto-fix loop extended to AI Test Bench drift** — `auto_fix_loop_ext.py`:
  - New helper `_plan_one_from_drift()` shapes a drift-specific prompt (failed probes + likely fix areas: probe defs, fallback chain, system-prompt injection).
  - New helper `_auto_fix_drift_sweep()` runs after the runtime-error sweep, shares the remaining daily-cap budget, plans + reviews + opens PRs identically.
  - Each failing `ai_model_tests` row gets `auto_fix_attempted_at` + `auto_fix_outcome` + `auto_fix_plan_id` + `auto_fix_pr_url` stamps so it's never retried.
  - Daily cap counter now includes both `source='auto_fix'` and `source='auto_fix_drift'`. Auto-merge sweep picks up both sources too.
  - `/status` endpoint merges runtime-error and drift outcomes newest-first with `kind` field (`'error'` | `'drift'`).
- ✅ **AutoFixCard drift badge** — recent activity rows now show an amber **"drift"** pill next to drift entries so the operator can tell at a glance which kind of fix is in flight.
- ✅ Live-tested via injected synthetic data + `run-now`: 3 runtime errors + 3 drift alerts processed in one tick, all correctly stamped, no schema regression.

## Implemented — Feb 2026 (previous session, batch 13)
- ✅ **Autonomous Auto-Fix Loop** — `auto_fix_loop_ext.py` + `AutoFixCard.jsx`:
  - APScheduler job ticks every 5 min. Looks for critical, non-dismissed runtime errors from last 24h that have no `auto_fix_attempted_at` stamp.
  - For each error: builds a structured prompt from the RCA / stack trace → calls AI Build `/plan` (cross-AI reviewed) → if `review.verdict == 'ship'` opens the PR; otherwise stamps the outcome (`review_ship_with_concerns`, `review_do_not_ship`, etc.) and skips.
  - Optional 2nd-tier toggle **"Auto-merge to production"** (rose danger-zone styling) — when ON, sweeps clean PRs and squash-merges via GitHub API.
  - Hard guards: per_day_cap (default 5), per_tick_cap (default 3), enable requires `project_id`, 400 on enable-without-project, master kill-switch in Settings.
  - Endpoints: `GET/PUT /api/operator/auto-fix/config`, `POST /run-now`, `GET /status` (shows today's count + last 5 outcomes with PR links).
  - All operator-only; auth gated; default OFF so existing flows untouched.
- ✅ **GitHub-token toast deep-link** — when AI Build `/plan` 503s with "github_token not set", the toast now deep-links to `/operator?tab=settings` after a 1.1s grace, replacing the dead red message.

## Implemented — Feb 2026 (previous session, batch 12)
- ✅ **In-app "What's new" changelog popover** — `WhatsNewPopover.jsx` rendered between the credits chip and user avatar in the Navbar:
  - Bell icon with unread badge (1, 2, … 9+); badge clears on first open via `POST /api/changelog/mark-read`.
  - Backend `changelog_ext.py`: `GET /api/changelog` (logged-in user, computes per-user `unread_count` against `users.last_changelog_read_at`), `POST /api/changelog/mark-read`, `POST /api/changelog` (operator-only, manual entry), `DELETE /api/changelog/{id}` (operator-only).
  - Auto-inserts an entry on every successful production promote when `auto_changelog=true` (alongside the existing GitHub `CHANGELOG.md` append).
  - 60-second background refresh, click-outside + ESC to close, multi-line `body_md` preserves newlines, optional `tag` pill (e.g. `v1.0`), `deploy` badge on promote-sourced entries.
  - End-to-end live-tested: bell visible, popover opens, both seeded entries rendered with correct tag pill + multi-line body + locale timestamps. Test data cleaned post-verification.

## Implemented — Feb 2026 (previous session, batch 11)
- ✅ **Cross-AI second opinion on every code review**:
  - `deploy/code_review.py` — `_second_opinion()` calls Claude over the same snapshot + GPT-4o's first verdict. If Claude says `do_not_ship`, the final verdict is escalated and `verdict_promoted_by: 'second_opinion'` is set so the existing 412 ship-gate triggers on either reviewer's objection.
  - `ai_build_ext.py` — `_cross_ai_review()` (GPT-4o-mini reviews Claude's AI Build plans) attaches `review: {verdict, summary, concerns, missing_imports, security_flags, reviewer_model}` to every `/plan` response.
- ✅ **Vercel `Preview` button on AI Build PR rows** — `GET /api/operator/ai-build/preview-url/{plan_id}` polls Vercel deployments filtered by `meta.githubCommitRef`. `PreviewButton` shows a pill that becomes a clickable `<a>` once the preview URL is live; gracefully degrades when `vercel_token` is unset.
- ✅ **In-chat auto-review-then-deploy** — `Dashboard.jsx handleInlineAction`:
  - Clicking the inline **Deploy** button now auto-runs the cross-AI code review FIRST (toast: "Running cross-AI code review…"), surfaces the verdict + cross-AI concerns + escalation warning in a window.prompt if blocked, then proceeds to `/deploy` only when green.
  - Clicking **Review** now shows the full verdict + cross-AI second-opinion + concerns in a `window.alert` instead of a tiny toast.
- ✅ **QuickActionsBar always pairs Review with Deploy** — `ChatMessages.jsx` now renders the Review button alongside any message that hints at Deploy (was previously conditional on the message text mentioning 'review' explicitly).
- ✅ **iter24 testing**: 10/10 backend pytest pass, 100% frontend on rendering + preview-probe + 409 graceful path. New regression file at `/app/backend/tests/test_iter24_cross_ai_review.py`.

## Implemented — Feb 2026 (previous session, batch 10)
- ✅ **Errors → AI Build self-closing loop** — every runtime error row in the Operator → Errors tab now has a **"Generate fix PR"** button (`data-testid="error-fix-pr-btn-<id>"`). Clicking it:
  - Extracts the file hint from `rca.suggested_file` if present, otherwise parses the first `frontend/src/...` or `backend/...` frame out of the stack trace.
  - Builds a structured prompt: error message + source + URL + likely file + RCA root_cause + suggested_change.
  - Deep-links to `/operator?tab=ai-build&prefill_prompt=<encoded>&prefill_error_id=<id>`.
  - `AIBuildTab` consumes the params on mount (one-shot), pre-fills the textarea, shows a green "Pre-filled from runtime error X" banner, scrolls the form into view, and strips the prefill params from the URL so a page-refresh doesn't replay.
  - Smoke-tested live in preview — 203-char prompt populated, banner visible, URL cleaned.

## Implemented — Feb 2026 (previous session, batch 9)
- ✅ **AI Build — natural-language → PR pipeline (operator-only)**
  - Backend: `ai_build_ext.py` exposes `POST /api/operator/ai-build/plan` (LLM generates a JSON patch plan), `POST /open-pr` (creates branch + commits + opens PR — no direct push to main, ever), `GET /history`, `DELETE /plan/{id}`.
  - **Hard server-side blocklist** (`BLOCKED_PATH_PATTERNS`): `.env`, `backend/auth*`, `backend/*payment*.py`, `backend/*stripe*.py`, `backend/*nowpayments*.py`, `backend/*paypal*.py`, `backend/models.py`, `secrets_ext.py`, `.git/`, `package-lock.json`, `yarn.lock`. Two-tier defence (context-build skip + post-LLM strip) against prompt-injection bypasses.
  - Per-request caps: 12 files, 80 KB / file, 4 KB prompt — sane guards against hallucinated mega-refactors.
  - Frontend: `AIBuildTab.jsx` — project dropdown, prompt box (4000-char limit), Plan button → diff preview with per-file collapse, Open PR / Discard buttons, recent-requests history with PR links.
  - Model: Claude Sonnet 4.5 (via Emergent LLM key + `emergentintegrations`).
  - Tested iter23: 12/12 effective BE (2 skips are by-design 503s when github_token/EMERGENT_LLM_KEY absent on this preview) + AI Build UI 100% on rendering, disabled-state, dropdown, 503-handling.
- ✅ **Inline-deploy UX fix** — `Dashboard.jsx handleInlineAction`:
  - When the AI code-review ship-gate returns 412 `review_blocked`, the chat's inline Deploy button now offers `fix` (navigate to `fix_chat_session_id`) / `force` (re-POST with `bypass_review=true`) / blank-cancel instead of a useless red toast.

**To unblock AI Build end-to-end:** set `github_token` (PAT with Contents:Write + Pull Requests:Write) and `emergent_llm_key` in Operator → Security. Until then `/plan` returns a clean 503 with the instruction.

## Implemented — Feb 2026 (previous session, batch 8)
- ✅ **Production hotfixes (3)** — preview-only fixes; user must redeploy:
  - `Dashboard.jsx` — `handleInlineAction` restored as a `useCallback` after an interrupted commit removed it (fixes `handleInlineAction is not defined` ×24 on /dashboard).
  - `AuditTab.jsx` — `r.target` rendered raw crashed React #31 when audit logger wrote an object (e.g. `operator.purge_test_data` writes `{sessions, messages}` as `target`). Now stringified.
  - `errorCapture.jsx` — `isExtensionNoise()` heuristic filters `chrome-extension://`, `moz-extension://`, `safari-web-extension://`, `webkit-masked-url://` and known wallet-grammar tells from BOTH `window.error` and `unhandledrejection`. Stops crypto-wallet extension errors (e.g. "wallet must has at least one account" ×57) from flooding `/api/runtime-errors`.

- ✅ **Public status page (P1)** — `/status` (no auth):
  - Backend: `status_ext.py` → `GET /api/status` returns `{overall, components:{database,ai_models}, models[], critical_errors_24h, incidents[]}`. ~3 Mongo reads + 1 ping; `Cache-Control: public, max-age=30` (Cloudflare edge currently strips — infra ticket only).
  - Overall logic: `outage` if DB down or ≥5 critical errors in 24h; `degraded` if any model FAIL or any critical errors; else `operational`.
  - Frontend: `Status.jsx` — banner + components grid + per-model PASS/FAIL pills with latency + recent-incidents list (last 7 days, 10-max). Auto-refresh every 30s. Linked from contact/footer.
  - Tested iter22: 9/10 BE + 100% FE in scope.

## Implemented — Feb 2026 (latest session, batch 7 + final)
- ✅ **Slack/Discord webhook bridge** (`webhook_ext.py` + `WebhookSettingsCard.jsx`):
  - One operator-configured `https://` URL works for both Slack incoming-webhooks and Discord `/api/webhooks/...` (payload sends both `text` and `content` keys).
  - Settings live on the existing `payment_settings` doc: `webhook_url` + `webhook_enabled` kill-switch.
  - Endpoints: `GET/PUT /api/operator/webhook` (write-only URL — server returns only the hostname for masked display), `POST /api/operator/webhook/test` (sends a real ping).
  - Wired into 4 notification sites — critical errors (`runtime_errors_ext._maybe_page_operator`), AI Test Bench drift (`ai_test_bench_ext._nightly_drift_alert`), production promotes (`deploy_projects_ext._trigger_promote`), and lockdown blocked login/register attempts (`server.py`).
  - All call sites are fire-and-forget (try/except + WARNING log) — webhook failures never break the primary flow.
  - Frontend operator card in Settings ("Security" tab): URL input, save, enable toggle, "Send test ping", "remove" clear.
  - Tested end-to-end (iter21): 14/14 backend pytest + 8/8 frontend selectors, real httpbin.org/post round-trip confirmed.

## Implemented — Feb 2026 (previous session, batch 7 + final)
- ✅ **Emergency lockdown pill** (`EmergencyLockdownPill.jsx`):
  - Always-visible top-bar pill in the Operator console next to OperatorGuideButton.
  - One-click PATCH flips BOTH `banner_enabled` AND `login_lockdown_enabled` to true (with `window.confirm` on engage; one-click release without confirm).
  - Pulsing red "App is private" style when active; muted "Lock app" when open.
  - 30s background poll (pauses when document hidden) keeps state in sync across tabs.
- ✅ **iter19 crash fix**: added missing `import EmergencyLockdownPill from '../components/EmergencyLockdownPill';` in `Operator.jsx`. Crash root-caused to ReferenceError at first render; ErrorBoundary was masking it as "Something broke on this page".

## Test runs across this session — full audit trail
| Iter | Scope                                              | Result                |
|------|----------------------------------------------------|-----------------------|
| 14   | AI Learnings + Sandbox AI                          | 12/12 BE · 100% FE   |
| 15   | AI Brain + chat fallback + self-healing toggle     | 10/10 BE · 100% FE   |
| 16   | AI Test Bench                                      | 6/6 BE · 100% FE     |
| 17   | Runtime errors + RCA + previews + digest + cron    | 15/15 BE · 100% FE   |
| 18   | GC + severity classifier + auto-page               | 9/10 (throttle bug)  |
| 19   | App settings + lockdown                            | 12/12 BE · 50% FE    |
| 20   | iter19 frontend retest after import fix            | 19/19 FE · 100%      |

Total: **83/84 assertions PASS** across 7 iterations. One bug found (throttle-row-after-email), one found-and-fixed (missing import).

## Explicitly deferred — known unimplemented items
- `Dashboard.jsx` component decomposition — mechanical refactor, no user-facing impact.
- Skill-tree as a true react-flow graph (currently grouped lists).
- Multi-pod Redis-backed rate-limit for `/api/runtime-errors` ingest (in-memory bucket fine for single-pod preview).
- ESLint v9 config + `react/jsx-no-undef` enforcement — would have caught the iter19 missing-import crash at CI time. Currently the project has no eslint config; the lint-tool's internal config is advisory only.
- Auto-patch path for high-confidence RCAs — deliberately deferred; the runtime-error → AI-Learnings auto-loop is the safer indirect path.


## Implemented — Feb 2026 (latest session, batch 6)
- ✅ **Personal-use banner overlay** (`PersonalUseBanner.jsx` + `app_settings_ext.py`):
  - Full-viewport translucent red overlay (`position:fixed; inset:0; z-index:9998; pointer-events:none`). Underlying UI stays fully clickable.
  - Centred red card with the operator's text, 2px red border, glass-morphism backdrop-filter, drop shadow. Re-enables pointer events only on the text card so "I understand · hide for this session" dismiss works.
  - Polls `/api/app/announcement` every 60s while tab is foregrounded so operator toggles propagate to open tabs without a hard reload.
  - sessionStorage-based per-session dismiss (`tbc_personal_use_banner_dismissed`).
- ✅ **Login lockdown** (`is_login_locked_down()` + auth gates in server.py):
  - `/api/auth/login` returns 503 for non-operator accounts when lockdown is ON. Password verify runs first so we don't leak the lockdown state to attackers.
  - `/api/auth/register` returns 503 unconditionally when lockdown is ON — no new sign-ups.
  - Existing user sessions remain valid (cookies + JWTs untouched) so this is a graceful kill-switch, not a forced sign-out.
- ✅ **Operator control surface** (`AppSettingsCard.jsx`):
  - New "Public banner & lockdown" section at the top of Operator → Settings.
  - Banner card: red-themed, switch + textarea + live preview button + Save Text button.
  - Lockdown card: amber-themed, switch with `window.confirm` warning, ACTIVE banner when ON.
  - Toggles auto-save immediately; text edits require explicit Save.
- ✅ **Bugfix from iter18**: `runtime_errors_ext.py:_maybe_page_operator` now **inserts the throttle row before** attempting send_email so a failing email server doesn't silently disable the rate-limiter (root cause from iter18 report).


## Implemented — Feb 2026 (latest session, batch 5)
- ✅ **Promote with auto-tag + CHANGELOG** (`deploy_release_tag_ext.py`):
  - When `auto_tag=true` in PromoteRequest, autopilot creates an annotated GitHub tag `prod-YYYY-MM-DD-N` (N is a per-day sequence, looked up via `git/matching-refs`) pointing at the promoted commit. Tag carries a message + UTC tagger info.
  - When `auto_changelog=true`, prepends a CHANGELOG.md entry on the default branch (creates the file if missing). Two-step Contents API (GET sha → PUT new content).
  - Both fully best-effort: failures are reported in the promote response (`release_tag.error`, `changelog.error`) but never roll back the Vercel promote.
  - PR Preview widget exposes both as localStorage-persisted checkboxes (default ON). Toast on success shows the new tag name + GitHub URL.
- ✅ **Dismiss UX preview** — new endpoint `GET /api/operator/runtime-errors/{id}/dismiss-preview` returns `{would_propose, preview_text}`. UI renders an inline emerald banner inside the expanded error row when `rca.confidence==='high' && rca.suggested_change` saying "Dismissing this error will auto-propose a Learning…".
- ✅ **Reject without proposing** — `POST /dismiss` now accepts `{skip_propose: true}`. New "Dismiss only" button appears next to the regular "Dismiss" button when the propose banner is shown. Response includes `skipped_propose: bool` so the UI can toast "Dismissed · learning skipped".
- ✅ **AI Learnings garbage collection** (`archive_stale_proposals`):
  - APScheduler job runs every 24h (15 min after boot). Marks `archived=true, archived_at=now` on any `auto_proposed=true, enabled=false` learning older than 14 days.
  - Soft-archive (not delete) so audit history is preserved. `GET /api/operator/ai-learnings` omits archived by default; pass `?include_archived=true` to inspect.
  - Manual trigger via `POST /api/operator/ai-learnings/gc?days=N` for ad-hoc testing.


## Implemented — Feb 2026 (latest session, batch 4)
- ✅ **Runtime errors → AI Learnings auto-loop** (the killer feature):
  - When the operator dismisses an error whose RCA has `confidence: 'high'` + a non-empty `suggested_change`, `_maybe_propose_learning_from_error()` distils it into a pending AI Learning.
  - Idempotent per `source_error_signature` so the same bug doesn't propose twice. Learning is created with `enabled=false, auto_proposed=true, source='runtime_error'` — operator-approval gated.
  - UI surfaces a red **"from error"** badge on these proposals + an approve button. Toast on dismiss: "AI Learning proposed from the RCA · click AI Learnings to review".
- ✅ **Configurable RCA model** (`settings.rca_model`):
  - Whitelist of 8 chat models (matches `TEST_MODELS` in `ai_test_bench_ext.py`). Fallback to `claude-sonnet-4-6` when no setting or invalid value.
  - Model name now persisted on the RCA doc + rendered in UI under the confidence header (e.g. "RCA · confidence: high · via claude-sonnet-4-6").
- ✅ **Promote button retry** (PR Preview widget):
  - Up to 3 attempts with exponential backoff (800/1600/2400ms) on 5xx only. 4xx breaks immediately (permanent failure). Vercel's promote endpoint occasionally flakes 502 mid-finalisation; safe to retry because deployment_id → prod-alias mapping is idempotent.
- ✅ **`_autopilot_stream()` refactor**:
  - Extracted `_resolve_max_iters(project_id, requested)` — pure helper, unit-testable.
  - Extracted `_react_to_deployment(project_id, project, settings, terminal_state, deployment_url, iter)` async-gen — the final ~25 lines of the loop now live in their own well-named function.
  - Main `_autopilot_stream` shrunk by ~40 lines; cyclomatic complexity reduced. No behaviour change — still emits the same SSE event taxonomy in the same order.


## Implemented — Feb 2026 (latest session, batch 3)
- ✅ **Runtime error capture + RCA pipeline** (`runtime_errors_ext.py` + `errorCapture.jsx`):
  - Global FastAPI exception handler captures every backend 500 into `runtime_errors` (skips HTTPException).
  - `window.onerror`, `unhandledrejection`, and a React `RuntimeErrorBoundary` POST frontend errors to `/api/runtime-errors`.
  - Public ingest endpoint rate-limited at 30 reports/min/IP. Same-signature errors within 24h merge with a count increment.
  - **Operator → Errors** tab lists, expands stacks, runs **Claude Sonnet RCA** (suggested file + one-line change + confidence), dismisses, or deletes. RCA persists on the doc; delete uses shadcn AlertDialog. Parse-fallback gets a yellow warning badge.
- ✅ **GitHub PR Preview widget** (`PreviewWidget.jsx` + `deploy_previews_ext.py`):
  - Lives above the tab bar on Operator dashboard. Polls `/api/operator/deploy/previews` every 30s (only while tab is foregrounded — saves Vercel quota).
  - Groups Vercel deployments by `meta.githubCommitRef`, keeps newest READY per branch.
  - One-click **Promote to prod** reuses `/api/operator/deploy/{id}/promote`. Widget hides entirely when no previews exist.
- ✅ **Weekly insight digest** (`/api/operator/ai-learnings/digest`):
  - Gemini Flash summary of every learning added in the last N weeks. Falls back to a deterministic bullet list when the LLM is unreachable so the endpoint never 500s in CI.
  - "Weekly digest" button on AI Learnings tab → renders inline panel with close button.
- ✅ **tv-preservation regression test** (`tests/test_p6_15_tv_preservation.py`):
  - 3 assertions, runs in <1s. Locks in: login JWT carries `tv`; first authed call doesn't 401; `/auth/2fa/verify` never 500s.
  - **Currently green: 3/3 PASS.**
- ✅ **Nightly AI Test Bench cron + drift alert** (in `ai_test_bench_ext.py` + `server.py` scheduler):
  - APScheduler runs `_nightly_drift_alert()` every 24h. Compares each model's pass/fail + avg-latency to yesterday.
  - Emails the operator (via `email_utils.send_email`) when any model flips PASS → FAIL or latency degrades >50%. Idempotent per UTC date.
  - Manual trigger via `POST /api/operator/ai-tests/cron/run-now` for testing.

## Backlog — what's left
- Skill-tree as a true graph (react-flow) — deferred again.
- `Dashboard.jsx` & `_autopilot_stream()` complexity refactor — still deferred.
- Multi-pod Redis-backed rate-limiting for `/api/runtime-errors` (current in-memory bucket fine for single-pod preview).
- Surface `parse_fallback:true` RCA differently (done — yellow badge added).
- Configurable RCA model (currently hard-coded to `claude-sonnet-4-6`).


## Implemented — Feb 2026 (latest session, continued)
- ✅ **AI Brain tab** (`AIBrainTab.jsx` + `ai_brain_ext.py`):
  - Maturity cards per model (Claude/GPT/Gemini/Other/All) — total enabled, pending proposals, 7-day delta, approval-rate bar.
  - 12-week timeline chart (recharts) showing learnings added per ISO week, per model.
  - Skill-bucket grouping (deploy/code/voice/security/ux/money/general) via cheap keyword taxonomy.
  - `_as_aware()` defensively normalises any naive `created_at` so timezone math never breaks the endpoint.
- ✅ **Chat-level LLM auto-retry** (`server.py:149-153` + `event_generator`):
  - Ordered fallback chain (Claude Sonnet → GPT-4.1 → Gemini Flash) tries the next provider when the primary stream errors BEFORE any tokens are produced. Partial responses are kept (no double-replies).
  - Emits a `fallback_used` SSE frame so the UI shows a sonner toast: "Retried with X after Y failed".
- ✅ **Per-project Self-healing toggle** (`auto_heal` on `deploy_projects`):
  - When ON, autopilot defaults `auto_fix_max_iterations=3` so the AI silently fixes do_not_ship verdicts and reships.
  - New switch `auto-heal-<id>` sits next to `auto-promote-<id>` in `ProjectRow.jsx`.
- ✅ **AI Test Bench tab** (`AITestBenchTab.jsx` + `ai_test_bench_ext.py`):
  - Three probes per model run in parallel: `health`, `arithmetic` (deterministic), `learnings` (regression — model must echo the longest content keyword from the most-recent approved learning).
  - Per-model "Run probes" + master "Run all" — fan-out via `asyncio.gather(return_exceptions=True)`.
  - Three-state visual: green pass, amber partial (only the regression probe failed), red hard-fail.
  - Persists every run in `ai_model_tests` for trend / history queries (`GET /history?model=…`).
- ✅ **Polish from iter15 review**:
  - `?tab=` URL sync (clicking tabs now properly updates the query param via `onTabChange`).
  - Sandbox tree defaults to repo root (was hardcoded to `frontend/src` and silently empty for non-monorepo `self_repo` configs).
  - `AILearningsTab` delete now uses shadcn `AlertDialog` instead of `window.confirm` (accessibility win).

## Backlog — explicit deferrals
- Runtime error capture (sentry-like collector → LLM patch → human approval). Big — needs its own session.
- Skill-tree visualisation as a true graph (react-flow). Currently rendered as grouped lists.
- `Dashboard.jsx` & `_autopilot_stream()` complexity refactor (still flagged by code reviewers; functional but high cyclomatic complexity).
- ESLint v9 migration — project has no `eslint.config.js` yet; `eslint-plugin-react-hooks@5.2.0` has a false-positive on `set-state-in-effect` for non-effect handlers in `AITestBenchTab.jsx`. Dev server compiles fine; rule should be configured to allow this pattern or upgraded once a v9 config lands.


## Implemented — Feb 2026 (latest session)
- ✅ **AI Self-Learning loop + Operator UI** (Feb 2026):
  - `ai_learnings_auto.py` extracts patterns from chat (sampled 20%) via a small Gemini Flash call,
    persists them with `enabled=false` + `auto_proposed=true` — operator approval required.
  - New **AI Learnings** tab in the Operator Console (`AILearningsTab.jsx`) lets the operator
    add / edit / toggle / approve / delete shared learnings. All enabled entries are
    auto-injected into the chat `SYSTEM_PROMPT` (server.py:870-885), so Claude, GPT, and Gemini
    share the same accumulated knowledge with zero redeploys.
  - Endpoints: `GET/POST/PATCH/DELETE /api/operator/ai-learnings`. Operator-only.

- ✅ **AI in Sandbox — "Ask AI to code this for me"** (Feb 2026):
  - `sandbox_ai_ext.py` wired (was orphaned before this session): `/api/operator/sandbox/ai/models`,
    `/api/operator/sandbox/ai/propose`, `/api/operator/sandbox/ai/sessions`, and
    `/api/operator/deploy/{id}/ai-edit-mode`.
  - `SandboxAIPanel.jsx` lives above the file tree (always discoverable, not gated on file-open).
    Operator picks model, types instruction, gets a JSON proposal with file diffs, can either
    "Load into editor" or "Apply & commit" (which reuses `PUT /operator/self/file` → webhook auto-deploy).
  - Hard-validated: single-file mode enforced, model whitelist, 503 on missing EMERGENT_LLM_KEY,
    502 on LLM/JSON failures, every proposal logged to `sandbox_ai_sessions` for replay.
  - Backend test suite: 12/12 PASS (`/app/backend/tests/test_sandbox_ai_learnings.py`).


## Implemented
- ✅ **Login-after-2FA bounce — REAL root cause fixed** (Feb 2026):
  - `/api/auth/2fa/verify` and the password-reset endpoint were minting
    new JWTs WITHOUT passing `token_version`. The default `tv=0` lost
    against the user's stored `token_version` (bumped by any prior
    "Sign out everywhere"), so `get_current_user`'s monotonicity check
    raised 401 immediately, bouncing the operator straight back to /login.
  - Both call sites now carry forward the operator's current
    `token_version` (re-fetched in the password-reset path, taken from
    the already-loaded `db_user` doc in 2FA verify).
  - Verified end-to-end with a fresh user seeded `tv=3 + totp_enabled`:
    login → 2FA verify → `/auth/me` HTTP 200. Was bouncing pre-fix.
  - The earlier CORS revert was *also* necessary (different bug — wrong
    response headers), but the **actual** loop trigger was this `tv=0`
    issue. Both fixes need to be live in production.

- ✅ **Code review pass 2 — actionable items applied** (Feb 2026):
  - Centralised operator/test credentials in `/app/backend/tests/_creds.py`
    reading from `TEST_OPERATOR_EMAIL` / `TEST_OPERATOR_PASSWORD` env
    vars with documented defaults. 12 `test_p6_*.py` files updated
    to import from there → secret scanner now flags only ONE file
    instead of 14. **73/73 backend tests still pass.**
  - Added `console.warn` to the empty catches that DID actually mask
    API errors: `BirthdayRewardsCard.jsx`, `TestUserBanner.jsx`,
    `AlertsCard.jsx`. Production telemetry can now spot regressions
    on those load endpoints.
  - Replaced the nested-ternary `previewUrl/domainUrl` builder in
    `useProjectActions.js` with a 3-line `ensureHttps()` helper.
  - **Skipped** (already documented as false positives in prior
    sessions): localStorage UI prefs, `is None` Python idiom, missing
    hook deps that flag imported modules / stable React setters.
  - **Deferred** (real but large, separate session): `Dashboard.jsx`
    split (50 complexity, 311 lines), `_autopilot_stream()` extract
    (197 lines), `SettingsTab.jsx` / `ProjectRow.jsx` /
    `UsersTable.jsx` / `SandboxTab.jsx` (300+ lines each).

- ✅ **Repo pill + Session status dot** (Feb 2026):
  - Dashboard header now shows a `📁 Richiie86/tbc-ai-tools` pill right
    after the project picker — clickable link to GitHub, hidden when
    no repo is configured yet.
  - Live `SessionStatusDot` component pings `/api/auth/me` every 30s +
    on visibility-change. Green pulse = signed in, amber = network
    issue, red = session expired. Rendered both inline (Dashboard
    header) and as a corner anchor (Navbar avatar).

- ✅ **Auto-fill operator repo + kill `.com` references** (Feb 2026):
  - New `OPERATOR_DEFAULT_REPO` env var (set to `Richiie86/tbc-ai-tools`
    in `/app/backend/.env`). `_ensure_self_project()` now uses a 3-tier
    fallback: `payment_settings.self_repo` → env var → empty.
  - Post-upsert auto-fill: if `tbctools-self.repo` is still empty after
    insert, fills it from (a) most-recent clone-history project, then
    (b) `OPERATOR_DEFAULT_REPO` env var. Verified — fresh DB with zero
    clone history still auto-fills to `Richiie86/tbc-ai-tools`.
  - Dashboard's empty-state dropdown now shows a "**Configure repo now →**"
    button that deep-links to `/operator?tab=settings#self-source`
    instead of the dead-end "Create a project first" message.
  - Killed every `tbctools.com` reference — `models.py`,
    `referrals_ext.py`, and the `.com` toggle in `MyReferral.jsx` all
    now resolve to `tbctools.org`. Backend `cors_dynamic_ext.py`
    always-allowed regex explicitly includes `www.tbctools.org`.

- ✅ **"Repo not found" toast — root-caused & fixed** (Feb 2026):
  - The previous fallback `'rac-investments/tbc-self-copy'` was a
    placeholder I made up; it doesn't exist on GitHub. When the operator
    on production clicked Review/Deploy on the freshly-seeded self
    project, the GitHub API 404'd with a confusing toast.
  - Fix in `_ensure_self_project()`: fallback `repo` is now `''` so the
    operator's first click surfaces a clean **412 `repo_not_configured`**
    with a "Configure now" toast action that deep-links to
    `/operator?tab=settings#self-source`.
  - One-shot repair: any existing row whose `repo` field is exactly
    the bad string `'rac-investments/tbc-self-copy'` is automatically
    cleared to `''` on the next list call. No manual Mongo edit needed.
  - Gated `run_code_review()` with the same precondition so the Review
    button surfaces the friendly 412 too.
  - Added `id="self-source"` anchor + `scroll-mt-20` to the Settings
    section so the deep link scrolls right to the right field.

- ✅ **"Can't Deploy" hard-fix** (Feb 2026):
  - `_ensure_self_project()` always upserts the row so the dropdown is
    never empty. `$setOnInsert` for curated fields (repo/domain/
    vercel_project_id) so the operator's hand-config is preserved.
  - Frontend reads `p.projectName || p.name || p.id` so the picker
    label renders for both old and new project shapes.
  - Auto-bootstrap of `tbctools-self` on every new chat session
    (operator only) so workspaces TBC1/TBC2/... always have a target.
  - Deploy endpoint wrapped in defensive try/except → never returns
    a malformed response that Cloudflare surfaces as 520. Timeouts
    map to a clean 504 with an actionable toast.
  - Dashboard toasts now handle 520-526 + 504 + 412 distinctly so
    operators always see what to do next.

- ✅ **Code review pass — easy wins + false-positive triage** (Feb 2026):
  - **Fixed**: Moved seeded test-user password to `TEST_USER_PASSWORD`
    env var (default `'TestUser-123'`, kept for backward compat). The
    value is intentionally non-secret (echoed by GET
    `/api/operator/test-user`) but the lint warning is now resolved.
  - **Fixed**: Replaced `key={i}` with stable composite keys
    (`${severity}-${file}-${i}` etc.) in ShipGateDialog,
    CodeReviewDialog, and AutopilotDialog — prevents state bugs when
    items reorder.
  - **False positives, intentionally NOT changed** (documented here so
    nobody re-chases them):
    1. localStorage usage flagged as "sensitive data" → actually
       all UI prefs (workspace, project picker, tour-seen, dismissed
       banner). Auth tokens are in httpOnly cookies (see
       `frontend/src/lib/api.js:8`, `AuthContext.jsx:18`).
    2. `is None` flagged as "string identity comparison" → correct
       Python idiom; ruff F632 passes clean.
    3. Empty catches in BirthdayRewardsCard / TestUserBanner /
       AlertsCard / SandboxTab localStorage paths → documented
       `/* non-fatal */` graceful-degradation sites for incognito-mode
       browsers that throw on localStorage access. Not bugs.
    4. Hook-deps in useInlineDomain / OpsDeploySection → imported
       modules (`api`), local try-vars (`data`), and React-stable
       setters were flagged. All actual deps are correctly listed.
  - **Deferred to future session** (real, but large refactors):
    - `Dashboard.jsx` (311 lines, 50 complexity) → split into
      `DashboardChatArea/MessageList/InputControls` + `useChatSend`.
    - `deploy/autopilot.py::_autopilot_stream` (38 complexity, 197
      lines) → extract stream/state/business-logic helpers.
    - `SettingsTab.jsx` / `SandboxTab.jsx` / `ProjectRow.jsx`
      (300+ lines each) → component splits.

- ✅ **Dynamic CORS — any domain you attach auto-connects** (Feb 2026):
  - New `DynamicCORSMiddleware` in `/app/backend/cors_dynamic_ext.py`
    reads the allow-list at request-time from FOUR sources, cached 60s:
      1. `CORS_ORIGINS` env (`'*'` = wildcard, else comma-list)
      2. Every `deploy_projects.domain` (auto-attached when operator
         sets a domain via Ops tab inline editor)
      3. Operator-managed `cors_settings.extra_origins` collection
      4. Always-allowed regex (preview / emergent.host / tbctools.org)
  - PATCH /domain and POST /cors-origins/add both call
    `invalidate_cors_cache()` so a newly-attached domain is honoured
    immediately — no redeploy, no env-var edit.
  - New audit + edit endpoints under `/api/operator/cors-origins`
    (GET full breakdown, PUT replace extras, POST `/add` append one).
  - **Note on preview:** the Kubernetes preview ingress force-sets
    `ACAO: *` on every response so the dynamic logic is effectively
    overridden in preview. It WILL engage in production where the
    ingress isn't overriding.

- ✅ **Live online/offline dot per user** (Feb 2026):
  - `auth_utils.get_current_user` fires a fire-and-forget `last_seen_at`
    write on every authenticated request. Bookkeeping; never blocks the
    auth check.
  - Users table renders a small green pulsing dot next to the email if
    the user has hit any endpoint in the last 90s, else a grey dot.
    `data-testid="online-pulse-{id}"` + `data-online="true|false"`
    attributes for testability.
  - Operator dashboard polls users on the same 8s tick as the stats so
    the dot stays live.

- ✅ **Real-customer stats + locked operator + deploy-access permissions** (Feb 2026):
  - `_compute_op_stats` excludes the seeded test user, the operator's own
    account, every `@example.com` synthetic, and any `test_*` email prefix
    so the dashboard counts only real customers. Was pinned at "247
    messages / $9 revenue" — now starts at $0 and ticks up live.
  - Operator dashboard polling cadence dropped from 25s → 8s, with a
    pulsing green "Live · refreshed every 8s" indicator above the cards.
  - Hard-blocked the operator email (`OPERATOR_EMAIL`) from being
    claimed via `/api/auth/register` so the account stays unique.
  - Users-table bulk-select checkbox is hidden for protected roles
    (operator/admin) — replaced with an invisible spacer to keep the
    column aligned. Select-All also skips protected rows.
  - **New per-user `can_deploy` permission system**:
    - Field on `users` doc (default = `payment_settings.default_can_deploy`,
      itself default `false`). Operators always have implicit access.
    - `/api/me/deploy-access` (GET/POST `/request`) for users.
    - `/api/operator/deploy-access/{requests,default}` + 
      `/api/operator/users/{id}/deploy-access` for operator.
    - Users tab has a new "Deploy" column with an inline toggle.
    - `InChatDeployControls` shows a "Request deploy access" button to
      users without permission, a "Request pending" pill once they
      submit, and the full controls when granted.
    - Mirror user-facing endpoints `/api/me/deploy/{projects,*/deploy,
      */healthcheck}` gated by `get_user_with_deploy_access`.

- ✅ **Backend refactor — vercel_api_ext + github_api_ext** (Feb 2026):
  - Extracted ~235 lines of Vercel REST client (`_vercel_*` helpers,
    `VERCEL_API`, `TERMINAL_STATES`, `VERCEL_TOKEN_MISSING_DETAIL`)
    into `/app/backend/vercel_api_ext.py` and the GitHub zip-stream
    helper into `/app/backend/github_api_ext.py`. `deploy_projects_ext.py`
    dropped from ~1745 → ~1534 lines.
  - 133/134 backend tests still passing.

- ✅ **Inline domain editor — click fix + optimistic UI + Vercel attach** (Feb 2026):
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
