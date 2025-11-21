/* Minimal multi-model chat MVP server
 * - In-memory conversations
 * - Per-model view builder (no self-duplication)
 * - OpenAI and Anthropic adapters (non-streaming)
 * - Serves a tiny static UI from /web
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
require('dotenv').config();

const { sendOpenAI } = require('./adapters/openai');
const { sendAnthropic } = require('./adapters/anthropic');
const { sendGoogle } = require('./adapters/google');
const { sendXAI } = require('./adapters/xai');
const { listAllModels } = require('./adapters/models');

const { db, getDefaultProjectId } = require('./db/index');
const { runMigrations } = require('./db/migrate');
const { migrateConversationsToSQLite, loadConversationsFromSQLite } = require('./db/migrate-memory-to-sqlite');
const { getConfig, setConfig, getAllConfig, initializeDefaultConfig } = require('./config/index');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(cors());

// In-memory store
// In-memory store
let conversations = new Map();

// Run migrations on startup
runMigrations();

// Initialize default config
initializeDefaultConfig();

// Migrate existing in-memory data (if any) to SQLite
if (conversations.size > 0) {
  migrateConversationsToSQLite(conversations);
}

// Load from SQLite (either just-migrated or existing data)
conversations = loadConversationsFromSQLite();

function newId(prefix = 'c') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

// Recommended defaults for "smart" alias (override via env)
const DEFAULT_MODELS = {
  openai: process.env.OPENAI_DEFAULT_MODEL || 'gpt-5',
  anthropic: process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-opus-4-1',
  google: process.env.GOOGLE_DEFAULT_MODEL || 'gemini-2.5-pro',
  xai: process.env.XAI_DEFAULT_MODEL || 'grok-4',
};

const DEFAULT_PROMPTS = {
  common:
    'You are {{modelId}} in a multi-agent conversation with one user and multiple AI agents.' +
    ' This is a simplified conversation, driven off of user messages. There is one round per user message.' +
    " You will see the full conversation from the beginning: each user message followed by other agents' replies tagged in brackets, e.g., [ModelA]: ..." +
    ' Your own previous replies appear as assistant messages. Respond once per user turn, primarilly addressing the user directly but also addressing the other models as appropriate.' +
    ' Coordination: Replies are collected in parallel and shown together; do not claim to "go first" or "start the discussion". Avoid meta-openers; contribute your content directly.',
  perProvider: {
    openai: process.env.OPENAI_DEFAULT_PROMPT || '',
    anthropic: process.env.ANTHROPIC_DEFAULT_PROMPT || '',
    google: process.env.GOOGLE_DEFAULT_PROMPT || '',
    xai: process.env.XAI_DEFAULT_PROMPT || '',
  },
};

// Load system prompts from config (with fallback to defaults)
function getSystemPrompts() {
  return getConfig('system_prompts', DEFAULT_PROMPTS);
}

function toPositiveInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

const DEFAULT_MAX_OUTPUT_TOKENS = {
  openai: toPositiveInt(process.env.OPENAI_MAX_OUTPUT_TOKENS),
  anthropic: toPositiveInt(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS),
  google: toPositiveInt(process.env.GOOGLE_MAX_OUTPUT_TOKENS),
  xai: toPositiveInt(process.env.XAI_MAX_OUTPUT_TOKENS),
};

function resolveMaxTokens(provider) {
  const key = (provider || '').toLowerCase();
  return DEFAULT_MAX_OUTPUT_TOKENS[key] || undefined;
}

function resolveModelId(provider, modelId) {
  const p = (provider || '').toLowerCase();
  if (!modelId || /^(smart|best|default)$/i.test(modelId)) {
    return DEFAULT_MODELS[p] || modelId;
  }
  return modelId;
}

function defaultOptions(provider) {
  const key = (provider || '').toLowerCase();
  const maxTokens = resolveMaxTokens(key);
  switch (key) {
    case 'openai': {
      const opts = {};
      if (maxTokens) opts.maxTokens = maxTokens;
      const effort = process.env.OPENAI_REASONING_EFFORT || 'high';
      if (effort) opts.reasoning = { effort };
      return opts;
    }
    case 'anthropic': {
      const opts = {};
      if (maxTokens) opts.maxTokens = maxTokens;
      const budget = process.env.ANTHROPIC_THINKING_BUDGET ? parseInt(process.env.ANTHROPIC_THINKING_BUDGET, 10) : undefined;
      if (budget) opts.thinking = { type: 'enabled', budget_tokens: budget };
      return opts;
    }
    case 'google':
    case 'xai': {
      return maxTokens ? { maxTokens } : {};
    }
    default:
      return maxTokens ? { maxTokens } : {};
  }
}

function buildOptions(provider, userOptions) {
  const defaults = defaultOptions(provider) || {};
  const provided = userOptions || {};
  const merged = { ...defaults, ...provided };
  if ((defaults.extraBody || provided.extraBody)) {
    merged.extraBody = { ...(defaults.extraBody || {}), ...(provided.extraBody || {}) };
  }
  if ((defaults.extraHeaders || provided.extraHeaders)) {
    merged.extraHeaders = { ...(defaults.extraHeaders || {}), ...(provided.extraHeaders || {}) };
  }
  if (merged.maxTokens === undefined && defaults.maxTokens !== undefined) {
    merged.maxTokens = defaults.maxTokens;
  }
  return merged;
}

function normalizeAgentId(provider, modelId, providedId, index) {
  if (providedId && typeof providedId === 'string' && providedId.trim()) {
    return providedId.trim();
  }
  const prov = (provider || 'provider').toLowerCase() || 'provider';
  const model = modelId || 'model';
  const suffix = Number.isFinite(index) ? index : Date.now();
  return `${prov}:${model}:${suffix}`;
}

function agentMatches(agentEntry, modelId, agentId) {
  if (!agentEntry) return false;
  if (agentId) {
    if (agentEntry.agentId) return agentEntry.agentId === agentId;
    return agentEntry.modelId === modelId;
  }
  return agentEntry.modelId === modelId;
}

// Build the per-model prompt view for this turn
function replaceModelId(template, modelId) {
  return (template || '').replace(/{{modelId}}/g, modelId);
}

function buildSystemPrimer(provider, modelId, prompts, context = {}) {
  const providerKey = (provider || '').toLowerCase();
  const provided = prompts || {};
  const common =
    typeof provided.common === 'string'
      ? provided.common
      : DEFAULT_PROMPTS.common;
  const perProviderDefaults = DEFAULT_PROMPTS.perProvider || {};
  const providerOverrides = (provided.perProvider && provided.perProvider[providerKey]) ?? undefined;
  const providerPrompt =
    typeof providerOverrides === 'string'
      ? providerOverrides
      : perProviderDefaults[providerKey] || '';

  const parts = [];
  const resolvedCommon = replaceModelId(common || '', modelId);
  if (resolvedCommon.trim()) parts.push(resolvedCommon.trim());
  const agentOverride = resolveAgentPrompt(provided, context);
  const resolvedProvider = replaceModelId(providerPrompt || '', modelId);
  if (agentOverride === undefined) {
    if (resolvedProvider.trim()) parts.push(resolvedProvider.trim());
  } else {
    const resolvedAgent = replaceModelId(agentOverride || '', modelId);
    if (resolvedAgent.trim()) parts.push(resolvedAgent.trim());
  }
  return parts.join('\n\n');
}

function resolveAgentPrompt(prompts, context = {}) {
  if (!prompts) return undefined;
  const { agentId, modelIndex } = context;
  const perAgent = prompts.perAgent;
  if (agentId && perAgent && typeof perAgent === 'object' && Object.prototype.hasOwnProperty.call(perAgent, agentId)) {
    const val = perAgent[agentId];
    if (typeof val === 'string') return val;
    return '';
  }
  if (Number.isInteger(modelIndex) && Array.isArray(prompts.perModel) && Object.prototype.hasOwnProperty.call(prompts.perModel, modelIndex)) {
    const val = prompts.perModel[modelIndex];
    if (typeof val === 'string') return val;
    return '';
  }
  return undefined;
}

// No per-model leader role; coordination handled via common prompt only.

function buildTaggedBlock(userMessage, agents, targetModelId, targetAgentId) {
  const lines = [];
  lines.push(`User: ${userMessage}`);
  if (agents && agents.length) {
    for (const a of agents) {
      if (agentMatches(a, targetModelId, targetAgentId)) continue; // avoid duplication of self
      const tag = a.name || a.modelId || 'agent';
      const text = (a.content || '').trim();
      if (text) lines.push(`[${tag}]: ${text}`);
    }
  }
  return lines.join('\n');
}

function buildAttachmentBlocks(textAttachments) {
  const blocks = [];
  const arr = Array.isArray(textAttachments) ? textAttachments : [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i] || {};
    const title = (a.title || '').trim();
    const content = (a.content || '').trim();
    if (!content) continue;
    const header = title ? `Attachment: ${title}` : 'Attachment';
    blocks.push(`${header}\n${content}`);
  }
  return blocks;
}

// Build full-history, per-model messages for providers
function buildMessagesForOpenAI(conv, currentUserMessage, targetModelId, targetAgentId, system, textAttachments) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });

  // For all prior rounds
  const lastIndex = conv.rounds.length - 1; // current round index
  for (let i = 0; i < lastIndex; i++) {
    const r = conv.rounds[i];
    const userBlock = buildTaggedBlock(r.user.content || '', r.agents || [], targetModelId, targetAgentId);
    messages.push({ role: 'user', content: userBlock });
    const mine = (r.agents || []).find((a) => agentMatches(a, targetModelId, targetAgentId));
    if (mine && mine.content) messages.push({ role: 'assistant', content: mine.content });
  }

  // Current round attachments (as user-sent context), then user message
  const attachBlocks = buildAttachmentBlocks(textAttachments);
  for (const block of attachBlocks) messages.push({ role: 'user', content: block });
  // Current round user message only
  messages.push({ role: 'user', content: `User: ${currentUserMessage}` });
  return messages;
}

function buildMessagesForAnthropic(conv, currentUserMessage, targetModelId, targetAgentId, system, textAttachments) {
  // We pass string content; adapter will map to text blocks and include system separately
  const messages = [];
  // prior rounds
  const lastIndex = conv.rounds.length - 1;
  for (let i = 0; i < lastIndex; i++) {
    const r = conv.rounds[i];
    const userBlock = buildTaggedBlock(r.user.content || '', r.agents || [], targetModelId, targetAgentId);
    messages.push({ role: 'user', content: userBlock });
    const mine = (r.agents || []).find((a) => agentMatches(a, targetModelId, targetAgentId));
    if (mine && mine.content) messages.push({ role: 'assistant', content: mine.content });
  }
  // current attachments then user message
  const attachBlocks = buildAttachmentBlocks(textAttachments);
  for (const block of attachBlocks) messages.push({ role: 'user', content: block });
  // current
  messages.push({ role: 'user', content: `User: ${currentUserMessage}` });
  return { system, messages };
}

function pickNumeric(obj, keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const raw = obj[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function summarizeUsage(provider, usage, maxTokens) {
  const limit = toPositiveInt(maxTokens);
  if (!usage || typeof usage !== 'object') {
    if (limit) return { limit };
    return undefined;
  }
  const input = pickNumeric(usage, ['input_tokens', 'prompt_tokens', 'promptTokenCount', 'promptTokens']);
  const output = pickNumeric(usage, ['output_tokens', 'completion_tokens', 'candidatesTokenCount', 'outputTokenCount']);
  const thinking = pickNumeric(usage, ['thinking_tokens', 'thinkingTokens']);
  let total = pickNumeric(usage, ['total_tokens', 'totalTokenCount']);
  if (total === undefined) {
    const sum = [input, output, thinking].reduce((acc, val) => (Number.isFinite(val) ? acc + val : acc), 0);
    total = sum > 0 ? sum : undefined;
  }

  const summary = {};
  if (limit) summary.limit = limit;
  if (input !== undefined) summary.input = input;
  if (output !== undefined) summary.output = output;
  if (thinking !== undefined) summary.thinking = thinking;
  if (total !== undefined) summary.total = total;

  if (limit && output !== undefined) {
    summary.used = output;
    summary.limitBasis = 'output';
  } else if (limit && total !== undefined) {
    summary.used = total;
    summary.limitBasis = 'total';
  } else if (!limit && total !== undefined) {
    summary.used = total;
  }

  if (summary.limit !== undefined && summary.used !== undefined) {
    summary.remaining = Math.max(summary.limit - summary.used, 0);
  }

  if (Object.keys(summary).length === 0) return undefined;
  return summary;
}

function getAdapter(provider) {
  switch (provider) {
    case 'openai':
      return sendOpenAI;
    case 'anthropic':
      return sendAnthropic;
    case 'google':
      return sendGoogle;
    case 'xai':
      return sendXAI;
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

// POST /api/turn
// Body: { conversationId?, userMessage: string, targetModels: [{ provider: 'openai'|'anthropic'|..., modelId: string, name?: string, agentId?: string, options?: object }], systemPrompts?: { common?: string, perProvider?: object, perAgent?: Record<agentId,string>, perModel?: string[] } }
app.post('/api/turn', async (req, res) => {
  try {
    const { conversationId, userMessage, targetModels, systemPrompts, textAttachments } = req.body || {};
    const dbg = debugEnabled(req);
    if (!userMessage || !Array.isArray(targetModels) || targetModels.length === 0) {
      return res.status(400).json({ error: 'userMessage and targetModels are required' });
    }

    // Load or create conversation
    let convId = conversationId;
    let conv;
    if (convId && conversations.has(convId)) {
      conv = conversations.get(convId);
    } else {
      convId = newId('conv');
      conv = { id: convId, rounds: [], perModelState: {} };
      conversations.set(convId, conv);

      // Insert into SQLite
      const defaultProjectId = getDefaultProjectId();
      db.prepare(`
        INSERT INTO conversations (id, project_id, title, created_at, updated_at, round_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        convId,
        defaultProjectId,
        `Conversation ${convId}`,
        Date.now(),
        Date.now(),
        0
      );
    }

    // Start new round with the user's message
    const round = { user: { speaker: 'user', content: userMessage, ts: Date.now() }, agents: [] };
    if (Array.isArray(textAttachments) && textAttachments.length) {
      round.attachments = textAttachments.map((a) => ({ title: (a && a.title) || '', chars: (a && a.content ? String(a.content).length : 0) }));
    }
    conv.rounds.push(round);

    // Persist to SQLite
    const roundNum = conv.rounds.length;

    // Insert user message
    const userMsgId = newId('msg');
    db.prepare(`
      INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userMsgId,
      convId,
      roundNum,
      'user',
      userMessage,
      JSON.stringify({
        ts: round.user.ts,
        attachments: round.attachments
      }),
      round.user.ts
    );

    // Update conversation metadata
    db.prepare(`
      UPDATE conversations
      SET updated_at = ?, round_count = ?
      WHERE id = ?
    `).run(Date.now(), roundNum, convId);

    if (dbg) {
      const attachCount = Array.isArray(textAttachments) ? textAttachments.length : 0;
      const attachChars = (Array.isArray(textAttachments) ? textAttachments.reduce((s, a) => s + ((a && a.content && String(a.content).length) || 0), 0) : 0);
      console.log('[turn] start', {
        conversationId: convId,
        models: targetModels.map(m => ({ provider: m.provider, requested: m.modelId })),
        userChars: String(userMessage || '').length,
        attachments: { count: attachCount, chars: attachChars },
      });
    }

    // Determine dynamic capabilities for this turn (e.g., Gemini web search grounding)
    function googleGroundingEnabled(options) {
      const eb = options && options.extraBody;
      const tools = eb && Array.isArray(eb.tools) ? eb.tools : [];
      return tools.some((t) => t && (Object.prototype.hasOwnProperty.call(t, 'googleSearch') || Object.prototype.hasOwnProperty.call(t, 'googleSearchRetrieval')));
    }
    const preparedTargets = targetModels.map((m, index) => {
      const provider = (m.provider || '').toLowerCase();
      const requestedModelId = m.modelId;
      const modelId = resolveModelId(provider, requestedModelId);
      const name = typeof m.name === 'string' ? m.name.trim() : '';
      const agentId = normalizeAgentId(provider, modelId, m.agentId, index);
      const options = buildOptions(provider, m.options);
      return {
        provider,
        requestedModelId,
        modelId,
        name,
        agentId,
        options,
        index,
      };
    });

    const searchCapableAgents = [];
    try {
      for (const target of preparedTargets) {
        if (target.provider !== 'google') continue;
        if (googleGroundingEnabled(target.options)) {
          const label = target.name ? `${target.name} (${target.modelId})` : target.modelId;
          searchCapableAgents.push(label);
        }
      }
    } catch { }
    const capNote = searchCapableAgents.length
      ? (
        'Capabilities: The following agents have live web search via Google grounding and can fetch current information with citations when asked: ' +
        searchCapableAgents.map((n) => `[${n}]`).join(', ') +
        '. If you lack web access and need a search, propose that these agents perform it.'
      )
      : '';

    // Fan-out to each target model in parallel
    const tasks = preparedTargets.map(async (target) => {
      const { provider, requestedModelId, modelId, name, agentId, options, index } = target;
      const adapter = getAdapter(provider);
      let system = buildSystemPrimer(provider, modelId, systemPrompts, { agentId, modelIndex: index, agentName: name });
      if (capNote) system = [system, capNote].filter(Boolean).join('\n\n');
      // Build full-history messages per provider
      const stateKey = agentId || `${provider}:${modelId}:${index}`;
      try {
        let result;
        const providerState = conv.perModelState ? conv.perModelState[stateKey] : undefined;
        if (provider === 'openai') {
          const messages = buildMessagesForOpenAI(conv, userMessage, modelId, agentId, system, textAttachments);
          result = await adapter({ model: modelId, messages, options, providerState });
        } else if (provider === 'anthropic') {
          const { system: sys, messages } = buildMessagesForAnthropic(conv, userMessage, modelId, agentId, system, textAttachments);
          result = await adapter({ model: modelId, system: sys, messages, options, providerState });
        } else if (provider === 'google') {
          const { system: sys, messages } = buildMessagesForAnthropic(conv, userMessage, modelId, agentId, system, textAttachments);
          result = await adapter({ model: modelId, system: sys, messages, options, providerState });
        } else if (provider === 'xai') {
          const messages = buildMessagesForOpenAI(conv, userMessage, modelId, agentId, system, textAttachments);
          result = await adapter({ model: modelId, messages, options, providerState });
        } else {
          throw new Error(`Unsupported provider: ${provider}`);
        }
        const { text, usage } = result;
        const maxTokens = options && options.maxTokens !== undefined ? options.maxTokens : resolveMaxTokens(provider);
        const tokenUsage = summarizeUsage(provider, usage, maxTokens);
        if (result && result.providerState) {
          conv.perModelState = conv.perModelState || {};
          conv.perModelState[stateKey] = result.providerState;
        }
        const msg = {
          speaker: `agent:${agentId || modelId}`,
          agentId,
          provider,
          modelId,
          requestedModelId,
          name,
          content: text || '',
          ts: Date.now(),
          usage,
          tokenUsage,
        };
        round.agents.push(msg);

        // Persist agent message to SQLite
        const agentMsgId = newId('msg');
        db.prepare(`
          INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          agentMsgId,
          convId,
          roundNum,
          msg.speaker,
          msg.content,
          JSON.stringify({
            modelId: msg.modelId,
            agentId: msg.agentId,
            usage: msg.usage,
            ts: msg.ts
          }),
          msg.ts
        );
        const finishReason = result && result.meta && (result.meta.finish_reason || result.meta.finishReason || result.meta.stop_reason || (result.meta.promptFeedback && result.meta.promptFeedback.blockReason));
        if (dbg) {
          console.log('[turn] result', {
            provider,
            agentId,
            name,
            modelId,
            requestedModelId,
            textChars: (text || '').length,
            tokenUsage,
            finishReason,
          });
        }
        return { agentId, provider, name, modelId, requestedModelId, text, usage, tokenUsage, finishReason, meta: result && result.meta };
      } catch (err) {
        const error = err && err.message ? err.message : 'Adapter error';
        const maxTokens = options && options.maxTokens !== undefined ? options.maxTokens : resolveMaxTokens(provider);
        if (dbg) {
          console.log('[turn] error', {
            provider,
            agentId,
            name,
            modelId,
            requestedModelId,
            error,
          });
        }
        return { agentId, provider, name, modelId, requestedModelId, error, tokenUsage: summarizeUsage(provider, undefined, maxTokens) };
      }
    });

    // Check if client wants streaming (SSE)
    const acceptsSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');

    if (acceptsSSE) {
      // Stream responses as they arrive
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Send conversation ID immediately
      res.write(`data: ${JSON.stringify({ type: 'init', conversationId: convId })}\n\n`);

      let completed = 0;
      const total = tasks.length;

      // Process promises as they resolve
      for (let i = 0; i < tasks.length; i++) {
        tasks[i].then(result => {
          completed++;
          res.write(`data: ${JSON.stringify({ type: 'result', result, completed, total })}\n\n`);

          // If all done, finalize and close
          if (completed === total) {
            // Auto-save if enabled
            if (conv.autoSave && conv.autoSave.enabled) {
              writeTranscript(conv, conv.autoSave.format || 'md')
                .then(p => { if (dbg) console.log('[autosave] wrote', p); })
                .catch(e => { if (dbg) console.log('[autosave] failed', e && e.message ? e.message : e); });
            }
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            res.end();
          }
        }).catch(err => {
          console.error('Task error:', err);
          completed++;
          const errorResult = {
            agentId: `error-${i}`,
            provider: 'unknown',
            error: err.message || 'Unknown error'
          };
          res.write(`data: ${JSON.stringify({ type: 'result', result: errorResult, completed, total })}\n\n`);

          if (completed === total) {
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            res.end();
          }
        });
      }
    } else {
      // Legacy non-streaming response
      const results = await Promise.all(tasks);
      // Auto-save if enabled for this conversation
      if (conv.autoSave && conv.autoSave.enabled) {
        try {
          const p = await writeTranscript(conv, conv.autoSave.format || 'md');
          if (dbg) console.log('[autosave] wrote', p);
        } catch (e) {
          if (dbg) console.log('[autosave] failed', e && e.message ? e.message : e);
        }
      }
      res.json({ conversationId: convId, results });
    }
  } catch (e) {
    console.error('turn error', e);
    res.status(500).json({ error: 'internal_error', detail: String(e && e.message ? e.message : e) });
  }
});

// Fetch a conversation (simple inspection)
app.get('/api/conversation/:id', (req, res) => {
  const id = req.params.id;
  const conv = conversations.get(id);
  if (!conv) return res.status(404).json({ error: 'not_found' });
  res.json(conv);
});

// Export a conversation as Markdown or JSON
app.get('/api/conversation/:id/export', async (req, res) => {
  try {
    const id = req.params.id;
    const format = (req.query && String(req.query.format || 'md').toLowerCase()) || 'md';
    const conv = conversations.get(id);
    if (!conv) return res.status(404).json({ error: 'not_found' });
    if (format === 'json') {
      const body = JSON.stringify({ id: conv.id, rounds: conv.rounds }, null, 2);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="conversation-${id}.json"`);
      return res.send(body);
    } else {
      const body = conversationToMarkdown(conv);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="conversation-${id}.md"`);
      return res.send(body);
    }
  } catch (e) {
    res.status(500).json({ error: 'export_failed', detail: String(e && e.message ? e.message : e) });
  }
});

// Toggle auto-save for a conversation
app.post('/api/conversation/:id/autosave', async (req, res) => {
  try {
    const id = req.params.id;
    const conv = conversations.get(id);
    if (!conv) return res.status(404).json({ error: 'not_found' });
    const { enabled, format } = req.body || {};
    conv.autoSave = { enabled: !!enabled, format: (format === 'json' ? 'json' : 'md') };
    let filePath = undefined;
    if (conv.autoSave.enabled) {
      filePath = await writeTranscript(conv, conv.autoSave.format || 'md');
    }
    res.json({ ok: true, enabled: conv.autoSave.enabled, format: conv.autoSave.format, path: filePath });
  } catch (e) {
    res.status(500).json({ error: 'autosave_failed', detail: String(e && e.message ? e.message : e) });
  }
});

// Preview the provider-specific view for the next turn (no API call)
// Body: { conversationId?, provider, modelId, agentId?, userMessage?, systemPrompts?, textAttachments? }
app.post('/api/preview-view', (req, res) => {
  try {
    const { conversationId, provider, modelId: requestedModelId, agentId, userMessage, systemPrompts, textAttachments } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'provider_required' });
    const modelId = resolveModelId(provider, requestedModelId);

    // Load conversation or create an empty one for preview
    let conv;
    if (conversationId && conversations.has(conversationId)) conv = conversations.get(conversationId);
    else conv = { id: conversationId || '(preview)', rounds: [], perModelState: {} };

    // Make a shallow copy and push a synthetic current round
    const convCopy = { id: conv.id, rounds: [...(conv.rounds || [])], perModelState: { ...(conv.perModelState || {}) } };
    convCopy.rounds.push({ user: { speaker: 'user', content: userMessage || '', ts: Date.now() }, agents: [] });

    const system = buildSystemPrimer(provider, modelId, systemPrompts, { agentId, modelIndex: 0 });
    let view;
    if (provider === 'openai' || provider === 'xai') {
      const messages = buildMessagesForOpenAI(convCopy, userMessage || '', modelId, agentId, system, textAttachments);
      view = { messages };
    } else if (provider === 'anthropic' || provider === 'google') {
      const { system: sys, messages } = buildMessagesForAnthropic(convCopy, userMessage || '', modelId, agentId, system, textAttachments);
      view = { system: sys, messages };
    } else {
      return res.status(400).json({ error: 'unsupported_provider' });
    }
    res.json({ provider, requestedModelId, modelId, system, view });
  } catch (e) {
    res.status(500).json({ error: 'preview_failed', detail: String(e && e.message ? e.message : e) });
  }
});

// GET /api/models – aggregate provider model lists and defaults
app.get('/api/models', async (req, res) => {
  try {
    const data = await listAllModels(DEFAULT_MODELS);
    const systemPrompts = getSystemPrompts();
    data.prompts = {
      common: systemPrompts.common,
      perProvider: {
        openai: systemPrompts.perProvider.openai || '',
        anthropic: systemPrompts.perProvider.anthropic || '',
        google: systemPrompts.perProvider.google || '',
        xai: systemPrompts.perProvider.xai || '',
      },
    };
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'models_list_failed', detail: String(e && e.message ? e.message : e) });
  }
});

// GET /api/config - Get all configuration
app.get('/api/config', (req, res) => {
  try {
    const config = getAllConfig();
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: 'config_fetch_failed', detail: String(e.message) });
  }
});

// POST /api/config - Update configuration
app.post('/api/config', (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key) {
      return res.status(400).json({ error: 'key_required' });
    }

    setConfig(key, value);
    res.json({ ok: true, key, value });
  } catch (e) {
    res.status(500).json({ error: 'config_update_failed', detail: String(e.message) });
  }
});

// POST /api/config/bulk - Update multiple config values
app.post('/api/config/bulk', (req, res) => {
  try {
    const updates = req.body;

    if (typeof updates !== 'object') {
      return res.status(400).json({ error: 'invalid_format' });
    }

    for (const [key, value] of Object.entries(updates)) {
      setConfig(key, value);
    }

    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (e) {
    res.status(500).json({ error: 'bulk_update_failed', detail: String(e.message) });
  }
});

// Serve minimal static UI
app.use('/', express.static(path.join(__dirname, '..', 'web')));

app.listen(PORT, () => {
  console.log(`Multi-model chat server listening on http://localhost:${PORT}`);
});
function debugEnabled(req) {
  const q = (req.query && (req.query.debug === '1' || req.query.debug === 'true'));
  const h = (req.headers && (req.headers['x-debug'] === '1' || req.headers['x-debug'] === 'true'));
  const env = process.env.DEBUG_REQUESTS === '1' || process.env.DEBUG_REQUESTS === 'true';
  return !!(q || h || env);
}
// Attachments save directory
const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR || path.join(__dirname, '..', 'transcripts');
try { fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true }); } catch { }

function asDate(ts) {
  try { return new Date(ts); } catch { return new Date(); }
}

function escMd(s) {
  return String(s == null ? '' : s);
}

function conversationToMarkdown(conv) {
  const lines = [];
  const rounds = Array.isArray(conv.rounds) ? conv.rounds : [];
  const startTs = rounds[0]?.user?.ts;
  const start = asDate(startTs).toISOString();
  lines.push(`# Conversation ${escMd(conv.id || '')}`);
  lines.push(`Started: ${start}`);
  lines.push('');
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const ts = asDate(r?.user?.ts).toISOString();
    lines.push(`## Round ${i + 1}`);
    lines.push(`_Time: ${ts}_`);
    if (Array.isArray(r.attachments) && r.attachments.length) {
      const names = r.attachments.map((a) => (a && a.title) || '').filter(Boolean);
      if (names.length) lines.push(`Attachments: ${names.join(', ')}`);
    }
    // user
    lines.push('');
    lines.push('### User');
    lines.push('');
    lines.push('```');
    lines.push(escMd(r?.user?.content || ''));
    lines.push('```');
    // agents
    const agents = Array.isArray(r.agents) ? r.agents : [];
    for (const a of agents) {
      const custom = (a && typeof a.name === 'string' && a.name.trim()) ? a.name.trim() : '';
      const base = a?.modelId || (a?.speaker || '').replace(/^agent:/, '') || 'agent';
      const heading = custom ? `${custom}${a?.modelId ? ` (${a.modelId})` : ''}` : base;
      lines.push('');
      lines.push(`### ${escMd(heading)}`);
      lines.push('');
      lines.push('```');
      lines.push(escMd(a?.content || ''));
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function writeTranscript(conv, format = 'md') {
  const id = conv && conv.id ? String(conv.id) : newId('conv');
  const base = `conversation-${id}.${format === 'json' ? 'json' : 'md'}`;
  const filePath = path.join(TRANSCRIPTS_DIR, base);
  if (format === 'json') {
    const body = JSON.stringify({ id: conv.id, rounds: conv.rounds }, null, 2);
    await fsp.writeFile(filePath, body, 'utf8');
  } else {
    const body = conversationToMarkdown(conv);
    await fsp.writeFile(filePath, body, 'utf8');
  }
  return filePath;
}
