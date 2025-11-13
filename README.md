Multi-Model Chat MVP

What this is
- Minimal Node/Express server that fans out each user turn to multiple models (OpenAI and Anthropic adapters included) while ensuring each model sees the user message plus all prior context reconstructed from the beginning, without duplicating its own replies.
- Supports a `smart`/`best`/`default` model alias that resolves to recommended top models per provider (override via env).
- Tiny static HTML page to exercise the API quickly without CORS issues (served from the same origin).

Quick start
1) Provide API keys via environment:
   - `OPENAI_API_KEY=...`
   - `ANTHROPIC_API_KEY=...`
   - `GOOGLE_API_KEY=...`
   - `XAI_API_KEY=...`
   - Optional: `PORT=3000`

2) Install deps and start:
   - `npm install`
   - `npm start`

3) Open the UI:
  - http://localhost:3000
  - Add one or more models. Using model id `smart` selects the recommended top model for that provider.
  - Providers: `openai`, `anthropic`, `google`, `xai`.
  - Use the “Models count” control to quickly set how many model rows appear; each row has its own provider and model id (default `smart`).
  - Type a user message and Send.
  - Each model row has an “Agent name” field so you can differentiate multiple instances of the same model; the custom label is used everywhere (UI log, transcripts, provider prompts, etc.).
  - Use the “Show System Prompts” toggle to edit the common instructions plus the per-model add-ons (`{{modelId}}` still resolves to the resolved model id). The panel now shows one textarea per configured model, prefilled with that provider’s default instructions so you can tweak each agent independently.
  - Use “Show Text Attachments (per message)” to paste snippets or load text files that will be added as context before your message for all providers. These are per‑message only and aren’t stored in the conversation; the UI keeps them until you remove them.
  - Each model reply shows tokens used; if an explicit output cap is set, the cap is shown. By default, no cap is imposed (except Anthropic requires a `max_tokens` which is set to a generous default).
  - Enable the "debug" checkbox to print server-side request/response summaries to the console for that turn (or set `DEBUG_REQUESTS=1`).
  - Export: use “Download Markdown” to save the conversation, or enable “Auto‑save to server (Markdown)” to continuously write to `TRANSCRIPTS_DIR`.

API
- POST `/api/turn`
  - Body: `{ conversationId?, userMessage: string, targetModels: [{ provider: 'openai'|'anthropic'|'google'|'xai', modelId: string, name?: string, agentId?: string, options?: { reasoning?: { effort: 'low'|'medium'|'high' }, thinking?: { type: 'enabled', budget_tokens?: number }, extraBody?: object, extraHeaders?: object, maxTokens?: number } }], systemPrompts?: { common?: string, perProvider?: { openai?: string, anthropic?: string, google?: string, xai?: string }, perAgent?: Record<string, string> } }`
  - `agentId` is optional but recommended when you send multiple copies of the same provider/model; it keeps per-agent state isolated across turns. The UI auto-generates one per row and also lets you rename agents via `name`.
  - Response: `{ conversationId, results: [{ agentId, name?, provider, modelId, requestedModelId, text?, usage?, tokenUsage?, error? }] }`

- GET `/api/conversation/:id/export?format=md|json`
  - Downloads a Markdown (default) or JSON export of a conversation.

- POST `/api/conversation/:id/autosave`
  - Body: `{ enabled: boolean, format?: 'md'|'json' }`
  - Toggles continuous server-side writing to `TRANSCRIPTS_DIR`. Response includes `{ path }` when enabled.

Conversation model
- In-memory only. Each round stores the user message and all agent replies.
- Every turn, each model receives a reconstruction of the full conversation from the start:
  - For each prior round: a user message with the user’s text plus other agents’ replies tagged as `[ModelId]: ...` (excluding the target model’s own), followed by the target model’s prior reply as an `assistant` message when available.
  - For the current turn: a user message with the new user text.
  - Tags now prefer the agent’s custom name (falling back to the model id) so multiple instances of the same model stay distinguishable in both the provider view and UI transcript.

Files
- `server/server.js` — Express app and per-model view builder
- `server/adapters/openai.js` — OpenAI Chat Completions adapter
- `server/adapters/anthropic.js` — Anthropic Messages API adapter
- `server/adapters/google.js` — Google Gemini (Generative Language) adapter
- `server/adapters/xai.js` — xAI Grok Chat Completions adapter
- `web/index.html` — Minimal UI

Notes
- This MVP is non‑streaming. SSE streaming can be added later.
- The Anthropic Messages API requires `anthropic-version` header; usage in response may vary.
- No persistence or auth; suitable for local testing only.
- OpenAI adapter uses the Responses API for reasoning features; forwards `options.reasoning.effort`. When the provider returns encrypted reasoning state, it is stored and sent on the next turn automatically.
- Some reasoning models reject sampling params like `temperature`; the server omits them by default. If a model supports it and you want to set it, pass via `options.extraBody.temperature`.
- Anthropic adapter supports extended thinking via `options.thinking` or env `ANTHROPIC_THINKING_BUDGET`.
- System prompts: defaults match the server’s shared instructions; override via the UI or env (`OPENAI_DEFAULT_PROMPT`, etc.). The UI now shows one prompt textarea per model row (prefilled with the provider default) so you can customize or clear instructions per agent.
- Token caps: optional per-provider defaults via `OPENAI_MAX_OUTPUT_TOKENS`, `ANTHROPIC_MAX_OUTPUT_TOKENS`, `GOOGLE_MAX_OUTPUT_TOKENS`, `XAI_MAX_OUTPUT_TOKENS`. If unset, no cap is sent (OpenAI/Google/xAI). Anthropic requires `max_tokens`; if none is provided, the server uses 8192 by default.
- Transcript exports: set `TRANSCRIPTS_DIR` (default `transcripts`). Markdown export includes round headings, user then per-model replies, and attachment titles when present.

Model alias resolution
- Server resolves `modelId` of `smart|best|default` to defaults per provider:
  - openai → `process.env.OPENAI_DEFAULT_MODEL` or `gpt-5`
  - anthropic → `process.env.ANTHROPIC_DEFAULT_MODEL` or `claude-opus-4-1`
  - google → `process.env.GOOGLE_DEFAULT_MODEL` or `gemini-2.5-pro`
  - xai → `process.env.XAI_DEFAULT_MODEL` or `grok-4`

Reasoning and opaque carry-forward
- OpenAI (Responses): set per model `options.reasoning = { effort: 'high' }`. The server extracts `encrypted_content` from reasoning blocks and forwards it next turn automatically.
- Anthropic (Messages): enable via `options.thinking = { type: 'enabled', budget_tokens: <n> }` or env `ANTHROPIC_THINKING_BUDGET`. No opaque carry-forward is required; Anthropic handles thinking history internally when you pass prior messages.
- Advanced: env JSON-path overrides are available if provider fields differ: `OPENAI_STATE_RESPONSE_PATH`, `OPENAI_STATE_REQUEST_PATH`, `ANTHROPIC_STATE_RESPONSE_PATH`, `ANTHROPIC_STATE_REQUEST_PATH`.
