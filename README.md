# TBC AI Tools

An AI-assisted build & deploy operator platform. A **React** frontend talks to
a **FastAPI** backend that runs AI code review, auto-fix loops, health checks,
and one-click deploys for connected GitHub repositories.

Production: [www.tbctools.org](https://www.tbctools.org)

## Architecture

| Layer     | Stack                                                        |
| --------- | ------------------------------------------------------------ |
| Frontend  | React (Create React App / CRACO), Tailwind CSS               |
| Backend   | FastAPI (Python), Motor (async MongoDB)                      |
| Database  | MongoDB                                                      |
| Auth      | JWT sessions, bcrypt password hashing, operator role         |
| AI        | Multi-provider LLM (Anthropic / OpenAI / Gemini / others), code review + fix |
| Infra     | Upstash Redis (rate limiting), Vercel/GitHub deploy hooks    |

```
frontend/   React app (REACT_APP_BACKEND_URL -> backend /api)
backend/    FastAPI app (server.py) + feature routers (*_ext.py)
tests/      pytest integration suites
```

## Prerequisites

- Node.js 18+ and npm/yarn
- Python 3.11+
- A running MongoDB instance
- At least one LLM provider key (Anthropic, OpenAI, Gemini, or others)

## Setup

### 1. Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env        # then fill in real values (see below)
uvicorn server:app --reload --port 8000
```

The backend seeds a bootstrap operator account from `OPERATOR_EMAIL` /
`OPERATOR_PASSWORD` on first startup. **Change the password after first login.**

### 2. Frontend

```bash
cd frontend
npm install                 # or: yarn
cp .env.example .env        # set REACT_APP_BACKEND_URL=http://localhost:8000
npm start                   # or: yarn start
```

## Environment variables

All variables are documented in [`backend/.env.example`](backend/.env.example)
and [`frontend/.env.example`](frontend/.env.example). Key ones:

| Variable             | Required | Purpose                                        |
| -------------------- | :------: | ---------------------------------------------- |
| `MONGO_URL`          |    Yes   | MongoDB connection string                      |
| `DB_NAME`            |    Yes   | Database name                                  |
| `REDIS_URL`          |    Yes   | Redis connection string (for rate limiting)    |
| `JWT_SECRET`         |    Yes   | Signs session tokens (`openssl rand -base64 48`)|
| `OPERATOR_EMAIL`     |    Yes   | Bootstrap operator login                       |
| `OPERATOR_PASSWORD`  |    Yes   | Bootstrap operator password (rotate after use) |
| `ANTHROPIC_API_KEY`  | One LLM  | LLM provider key (or `OPENAI_API_KEY`/`GEMINI_API_KEY`/`OPENROUTER_API_KEY`/`GROQ_API_KEY`) |
| `CORS_ORIGINS`       |    No    | Comma-separated allow-list. Unset → locked fallback (see below) |
| `PRIMARY_DOMAIN`     |    No    | Your launch domain. Trusted by the CORS fallback + previews so a deploy works on the domain you chose |
| `GITHUB_TOKEN`       |    No    | Repo review + deploy                           |
| `SECOND_OPINION_MODEL`|   No    | Override cross-AI reviewer model               |

**CORS / custom domains:** if `CORS_ORIGINS` is set it is used verbatim.
Otherwise the server trusts `tbctools.org` **and** `https://<PRIMARY_DOMAIN>`
(plus its subdomains) with credentials — so deploying on your own domain is
just one env var, no code changes.

Real `.env` files are git-ignored — never commit secrets. Only the
`.env.example` templates are tracked.

## Tests

```bash
cd backend
pip install -r requirements.txt
# Integration tests that need a live login read credentials from env vars
# and SKIP when unset — no secrets are stored in the test sources:
export TEST_OPERATOR_EMAIL=...    TEST_OPERATOR_PASSWORD=...
# If the operator account has 2FA enabled, ALSO export the TOTP secret,
# otherwise the 2FA login tests silently skip and CI gives false green:
export TEST_OPERATOR_TOTP_SECRET=...   # base32 secret from the authenticator setup
pytest
```

## Deployment

Deploys are gated by an automated **code review** (`Run Code Review` in the
Operator Console). A `do_not_ship` verdict blocks production deploys until the
flagged issues are resolved; `ship` / `ship_with_fixes` allow it. The reviewer
runs a primary pass plus an optional cross-AI second opinion
(`SECOND_OPINION_MODEL`).

## Security notes

- Passwords are hashed with bcrypt; sessions use signed JWTs.
- CORS defaults to a strict production regex; `*` is only allowed without credentials.
- No credentials live in source — tests and config pull secrets from env vars.
