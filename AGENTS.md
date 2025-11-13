# Repository Guidelines

## Project Structure & Module Organization
- `server/` — Express app and conversation logic.
  - `server/server.js` — routes, in‑memory store, per‑model view builder.
  - `server/adapters/` — provider adapters (`openai.js`, `anthropic.js`). Add new providers here.
- `web/` — minimal static UI (`index.html`).
- `README.md` — quickstart and API.
- `.env.example` — environment variable template.

## Build, Test, and Development Commands
- Install deps: `npm install`
- Run locally: `npm start` (serves UI at `http://localhost:3000`).
- Smoke test API:
  - `curl -s http://localhost:3000/api/turn -H 'Content-Type: application/json' -d '{"userMessage":"hi","targetModels":[{"provider":"openai","modelId":"gpt-4o-mini"}]}' | jq`.
- Fetch a transcript: `curl -s http://localhost:3000/api/conversation/<id> | jq`

## Coding Style & Naming Conventions
- JavaScript (Node 18+), CommonJS modules (`require`, `module.exports`).
- Indentation: 2 spaces; include semicolons; prefer single quotes for strings.
- Adapters export `send<Provider>` with signature: `sendX({ model, messages[, system] })` returning `{ text, usage? }`.
- Place new adapters in `server/adapters/<provider>.js`; keep network code isolated from route logic.
- Name agents by model ID (e.g., `agent:gpt-4o-mini`).

## Testing Guidelines
- No formal test runner yet. Use manual smoke tests via the UI and `curl`.
- When adding logic, create minimal integration tests before refactors. Suggested layout: `server/__tests__/...`.
- Keep prompts deterministic when possible (`temperature: 0.2`) for reproducible checks.

## Commit & Pull Request Guidelines
- Commits: imperative mood, concise subject, meaningful scope (e.g., `server`, `adapters`, `web`).
  - Example: `adapters: add google provider with full-history view`.
- PRs must include:
  - What changed and why (one paragraph).
  - How to verify (commands, example requests, screenshots of UI output).
  - Config changes (env vars, ports). Do not include secrets.

## Security & Configuration Tips
- Keys via environment only (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`); never expose to the browser or commit `.env`.
- Same‑origin requests avoid CORS in development; keep the server as the sole network boundary.
- Avoid logging sensitive payloads; redact model outputs only if required by policy.
- Reasonable defaults: small request body limits and short timeouts when productionizing.
