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
const crypto = require('crypto');
require('dotenv').config();

const { sendOpenAI } = require('./adapters/openai');
const { sendAnthropic } = require('./adapters/anthropic');
const { sendGoogle } = require('./adapters/google');
const { sendXAI } = require('./adapters/xai');
const { sendMock } = require('./adapters/mock');
const { listAllModels } = require('./adapters/models');

const { db, getDefaultProjectId, newId: newDbId, STORAGE_DIR, STORAGE_THRESHOLD } = require('./db/index');
const { validatePath, computeHash, detectMimeType } = require('./utils/files');
const { runMigrations } = require('./db/migrate');
const { migrateConversationsToSQLite, loadConversationsFromSQLite } = require('./db/migrate-memory-to-sqlite');
const { getConfig, setConfig, getAllConfig, initializeDefaultConfig } = require('./config/index');

const { indexFile, indexMessage } = require('./indexing/indexer');
const { search } = require('./indexing/search');
const { buildSystemPrompt } = require('./prompts/builder');

const app = express();
const PORT = process.env.PORT || 3000;

// FIX 2: Trust exactly one proxy hop (nginx). req.ip will then be trust-proxy aware.
// Deploy note: nginx MUST set `proxy_set_header X-Forwarded-For $remote_addr`
// (overwrite, NOT append) so clients cannot spoof their own XFF.
app.set('trust proxy', 1);

// FIX 6: Lower body limit in PUBLIC_MODE to prevent DoS via oversized payloads
const publicGuard = require('./publicGuard');
const bodyLimit = publicGuard.isPublicMode() ? '64kb' : '50mb';
app.use(express.json({ limit: bodyLimit }));

// Body-parser errors (e.g. entity.too.large, malformed JSON) otherwise fall
// through to Express's default HTML handler, which leaks a node_modules
// filesystem path in the stack. Return generic JSON instead.
app.use((err, req, res, next) => {
  if (err && (err.type || err.status === 413 || err instanceof SyntaxError)) {
    const status = err.status || err.statusCode || 400;
    if (publicGuard.isPublicMode()) {
      return res.status(status).json({ error: status === 413 ? 'payload_too_large' : 'bad_request', message: status === 413 ? 'Request body too large.' : 'Malformed request.' });
    }
    return res.status(status).json({ error: 'bad_request', message: err.message });
  }
  next(err);
});
app.use(cors());

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

// PUBLIC_MODE: initial wipe and scheduled cleanup
publicGuard.wipeOldConversations();
publicGuard.wipeInterval();

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
  mock: 'mock-echo',
};

const DEFAULT_PROMPTS = {
  common:
    'You are {{modelId}}, one participant in a multi-model chat. A person sends a message and one or more AI models each reply once.' +
    " You may be shown other models' replies as context, tagged like [ModelName]: — those were written by other models and given to you as input; you did NOT write them." +
    ' Hard rules: reply exactly once, as yourself, in plain prose addressed to the person.' +
    ' NEVER output a bracketed [Name]: label. NEVER write, quote, continue, or invent other models\' replies — do not roleplay other participants. Give only your own answer.' +
    ' Replies are collected in parallel and shown together, so do not claim to "go first" or "start the discussion"; just contribute your content directly.',
  perProvider: {
    openai: process.env.OPENAI_DEFAULT_PROMPT || '',
    anthropic: process.env.ANTHROPIC_DEFAULT_PROMPT || '',
    google: process.env.GOOGLE_DEFAULT_PROMPT || '',
    xai: process.env.XAI_DEFAULT_PROMPT || '',
    mock: '',
  },
};

// Load system prompts from config (with fallback to defaults)
function getSystemPrompts() {
  return getConfig('system_prompts', DEFAULT_PROMPTS);
}

// Merge per-request systemPrompts over the config-stored ones. The request
// wins field-by-field; perAgent/perModel only exist per-request.
function mergeSystemPrompts(requestPrompts) {
  const cfg = getSystemPrompts();
  const req = requestPrompts || {};
  return {
    common: typeof req.common === 'string' ? req.common : cfg.common,
    perProvider: { ...(cfg.perProvider || {}), ...(req.perProvider || {}) },
    perAgent: req.perAgent,
    perModel: req.perModel,
  };
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
    // In public mode, "smart"/default must resolve to the allowlisted model
    // for this provider (DEFAULT_MODELS points at pricier non-allowed models).
    if (publicGuard.isPublicMode()) {
      const allowed = publicGuard.getAllowedModels().find(a => a.provider === p);
      if (allowed) return allowed.modelId;
    }
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
      // Only set reasoning options if explicitly configured (for o1/o3 models)
      const effort = process.env.OPENAI_REASONING_EFFORT;
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
    case 'xai':
    case 'mock': {
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
    case 'mock':
      return sendMock;
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

// ============================================================================
// File APIs
// ============================================================================

/**
 * POST /api/projects/:projectId/files
 * Upload or update a file
 */
app.post('/api/projects/:projectId/files', publicGuard.blockUploadsMiddleware, async (req, res) => {
  const { projectId } = req.params;
  const { path: filePath, content, metadata } = req.body;

  try {
    // Validate inputs
    if (!filePath || !content) {
      return res.status(400).json({ error: 'path and content are required' });
    }

    const validPath = validatePath(filePath);

    // Check project exists
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'project_not_found' });
    }

    // Size check
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    if (sizeBytes > MAX_FILE_SIZE) {
      return res.status(413).json({ error: 'file_too_large', max_bytes: MAX_FILE_SIZE });
    }

    // Compute hash
    const contentHash = computeHash(content);

    // Detect MIME type
    const mimeType = detectMimeType(validPath);

    // Prepare metadata
    const metadataStr = metadata ? JSON.stringify(metadata) : JSON.stringify({
      retrieval_eligible: true,
      tool_accessible: true
    });

    const now = Date.now();

    // Decide storage location
    let fileContent = null;
    let contentLocation = null;

    if (sizeBytes < STORAGE_THRESHOLD) {
      // Store in DB
      fileContent = content;
    } else {
      // Store on disk
      const storageId = crypto.randomBytes(16).toString('hex');
      contentLocation = path.join(STORAGE_DIR, storageId);
      await fs.promises.writeFile(contentLocation, content, 'utf8');
    }

    // Upsert file
    const fileId = newDbId('file');
    const result = db.prepare(`
      INSERT INTO project_files (
        id, project_id, path, content, content_location, content_hash,
        mime_type, size_bytes, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET
        content = excluded.content,
        content_location = excluded.content_location,
        content_hash = excluded.content_hash,
        size_bytes = excluded.size_bytes,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      fileId,
      projectId,
      validPath,
      fileContent,
      contentLocation,
      contentHash,
      mimeType,
      sizeBytes,
      metadataStr,
      now,
      now
    );

    // Get the file (in case of conflict, use existing ID)
    const file = db.prepare(`
      SELECT id, path, size_bytes, content_hash, created_at
      FROM project_files
      WHERE project_id = ? AND path = ?
    `).get(projectId, validPath);

    res.status(201).json(file);

    // Trigger background indexing
    indexFile(file.id).catch(err => {
      console.error('Background indexing failed:', err);
    });

  } catch (err) {
    console.error('File upload error:', err);
    const safeErr = publicGuard.sanitizeError(err);
    res.status(500).json({ error: 'upload_failed', message: publicGuard.isPublicMode() ? 'upload failed' : safeErr.message });
  }
});

/**
 * GET /api/projects/:projectId/files
 * List files in project
 */
app.get('/api/projects/:projectId/files', (req, res) => {
  const { projectId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const filter = req.query.filter; // e.g., "*.md" or "docs/*"

  try {
    // Check project exists
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'project_not_found' });
    }

    // Build query
    let query = `
      SELECT id, path, mime_type, size_bytes, created_at, updated_at
      FROM project_files
      WHERE project_id = ?
    `;
    const params = [projectId];

    // Simple filter support (LIKE pattern)
    if (filter) {
      const pattern = filter.replace(/\*/g, '%');
      query += ` AND path LIKE ?`;
      params.push(pattern);
    }

    query += ` ORDER BY path ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const files = db.prepare(query).all(...params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM project_files WHERE project_id = ?';
    const countParams = [projectId];
    if (filter) {
      const pattern = filter.replace(/\*/g, '%');
      countQuery += ' AND path LIKE ?';
      countParams.push(pattern);
    }
    const { count } = db.prepare(countQuery).get(...countParams);

    res.json({
      files,
      total: count,
      limit,
      offset
    });

  } catch (err) {
    console.error('File list error:', err);
    const safeErr = publicGuard.sanitizeError(err);
    res.status(500).json({ error: 'list_failed', message: publicGuard.isPublicMode() ? 'list failed' : safeErr.message });
  }
});

/**
 * GET /api/projects/:projectId/files/:fileId
 * Get file content and metadata
 */
app.get('/api/projects/:projectId/files/:fileId', async (req, res) => {
  const { projectId, fileId } = req.params;

  try {
    const file = db.prepare(`
      SELECT *
      FROM project_files
      WHERE id = ? AND project_id = ?
    `).get(fileId, projectId);

    if (!file) {
      return res.status(404).json({ error: 'file_not_found' });
    }

    // Load content
    let content = file.content;
    if (!content && file.content_location) {
      content = await fs.promises.readFile(file.content_location, 'utf8');
    }

    // Parse metadata
    const metadata = file.metadata ? JSON.parse(file.metadata) : {};

    res.json({
      id: file.id,
      path: file.path,
      content,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      content_hash: file.content_hash,
      metadata,
      created_at: file.created_at,
      updated_at: file.updated_at
    });

  } catch (err) {
    console.error('File read error:', err);
    const safeErr = publicGuard.sanitizeError(err);
    res.status(500).json({ error: 'read_failed', message: publicGuard.isPublicMode() ? 'read failed' : safeErr.message });
  }
});

/**
 * DELETE /api/projects/:projectId/files/:fileId
 * Delete a file
 */
app.delete('/api/projects/:projectId/files/:fileId', publicGuard.blockFileMutationsMiddleware, async (req, res) => {
  const { projectId, fileId } = req.params;

  try {
    // Get file info (to delete disk file if needed)
    const file = db.prepare(`
      SELECT content_location
      FROM project_files
      WHERE id = ? AND project_id = ?
    `).get(fileId, projectId);

    if (!file) {
      return res.status(404).json({ error: 'file_not_found' });
    }

    // Delete from DB (triggers will clean up chunks and FTS index)
    const result = db.prepare(`
      DELETE FROM project_files
      WHERE id = ? AND project_id = ?
    `).run(fileId, projectId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'file_not_found' });
    }

    // Delete disk file if it exists
    if (file.content_location) {
      try {
        await fs.promises.unlink(file.content_location);
      } catch (err) {
        console.error('Failed to delete disk file:', err);
        // Continue anyway - DB record is deleted
      }
    }

    res.json({ ok: true, deleted: fileId });

  } catch (err) {
    console.error('File delete error:', err);
    const safeErr = publicGuard.sanitizeError(err);
    res.status(500).json({ error: 'delete_failed', message: publicGuard.isPublicMode() ? 'delete failed' : safeErr.message });
  }
});

// ============================================================================
// Search API
// ============================================================================

/**
 * POST /api/projects/:projectId/search
 * Search for content in project files and conversations
 */
app.post('/api/projects/:projectId/search', (req, res) => {
  const { projectId } = req.params;
  const { query, filters, limit, offset } = req.body;

  try {
    // Validate query
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'query is required' });
    }

    // Execute search
    const results = search(projectId, query, { filters, limit, offset });

    res.json(results);

  } catch (err) {
    if (err.message === 'Project not found') {
      return res.status(404).json({ error: 'project_not_found' });
    }

    console.error('Search error:', err);
    const safeErr = publicGuard.sanitizeError(err);
    res.status(500).json({ error: 'search_failed', message: publicGuard.isPublicMode() ? 'search failed' : safeErr.message });
  }
});

// POST /api/turn
// Body: { conversationId?, userMessage: string, targetModels: [{ provider: 'openai'|'anthropic'|..., modelId: string, name?: string, agentId?: string, options?: object }], systemPrompts?: { common?: string, perProvider?: object, perAgent?: Record<agentId,string>, perModel?: string[] } }
app.post('/api/turn', async (req, res) => {
  try {
    const { conversationId, userMessage, targetModels, systemPrompts, textAttachments } = req.body || {};
    const dbg = debugEnabled(req);

    // PUBLIC_MODE: rate limit check
    const rateErr = publicGuard.rateLimitCheck(req);
    if (rateErr) {
      return res.status(rateErr.status).json({ error: rateErr.error, message: rateErr.message, retryAfter: rateErr.retryAfter });
    }

    if (!userMessage || !Array.isArray(targetModels) || targetModels.length === 0) {
      return res.status(400).json({ error: 'userMessage and targetModels are required' });
    }

    // FIX 4: Validate message length and target count (PUBLIC_MODE)
    const turnErr = publicGuard.validateTurnRequest(req.body);
    if (turnErr) {
      return res.status(turnErr.status).json({ error: turnErr.error, message: turnErr.message });
    }

    // FIX 1 + FIX 6: Prepare targets with sanitized options — BEFORE any state mutation
    const clampMaxTokens = parseInt(process.env.PUBLIC_MAX_TOKENS_PER_TURN, 10);
    const clampValue = publicGuard.isPublicMode()
      ? (Number.isFinite(clampMaxTokens) && clampMaxTokens > 0 ? clampMaxTokens : 700)
      : undefined;

    // Determine dynamic capabilities for this turn (e.g., Gemini web search grounding)
    function googleGroundingEnabled(options) {
      const eb = options && options.extraBody;
      const tools = eb && Array.isArray(eb.tools) ? eb.tools : [];
      return tools.some((t) => t && (Object.prototype.hasOwnProperty.call(t, 'googleSearch') || Object.prototype.hasOwnProperty.call(t, 'googleSearchRetrieval')));
    }
    const preparedTargets = targetModels.map((m, index) => {
      const provider = (m.provider || '').toLowerCase();
      const requestedModelId = m.modelId;
      const modelId = (resolveModelId(provider, requestedModelId) || '').toLowerCase();
      const name = typeof m.name === 'string' ? m.name.trim() : '';
      const agentId = normalizeAgentId(provider, modelId, m.agentId, index);
      let options = buildOptions(provider, m.options);
      options = publicGuard.clampMaxTokens(options);
      // FIX 1: Sanitize options in PUBLIC_MODE — drop extraBody, extraHeaders, tools, reasoning, thinking
      options = publicGuard.sanitizeOptions(options, modelId, clampValue);
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

    // PUBLIC_MODE: allowlist check (after model ID resolution)
    // IMPORTANT: This runs BEFORE any state mutation so nothing is persisted on rejection
    const allowlistErr = publicGuard.checkAllowlist(preparedTargets);
    if (allowlistErr) {
      return res.status(allowlistErr.status).json({ error: allowlistErr.error, message: allowlistErr.message, allowedModels: allowlistErr.allowedModels });
    }

    // PUBLIC_MODE rate + budget guards — run BEFORE any persistence or
    // reservation, so a rejected turn neither reserves budget nor writes a
    // conversation. Peek BOTH, then commit BOTH (no await between) so a
    // rate-limit rejection can't leave budget reserved, or vice-versa.
    const realTargetCount = preparedTargets.filter(t => t.provider !== 'mock').length;
    const effectiveClamp = clampValue || 700;
    const budgetStatus = publicGuard.checkDailyBudget();   // already-spent before this turn?
    const budgetBlocked = budgetStatus && budgetStatus.blocked;
    if (publicGuard.isPublicMode() && realTargetCount > 0 && !budgetBlocked) {
      const ip = publicGuard.getClientIp(req);
      const ratePeek = publicGuard.peekRatePerCall(ip, realTargetCount);
      if (ratePeek) {
        return res.status(ratePeek.status).json({ error: ratePeek.error, message: ratePeek.message, retryAfter: ratePeek.retryAfter });
      }
      const budgetPeek = publicGuard.peekBudget(realTargetCount, effectiveClamp);
      if (budgetPeek && budgetPeek.blocked) {
        return res.status(429).json({ error: 'budget_exceeded', message: budgetPeek.message });
      }
      publicGuard.consumeRatePerCall(ip, realTargetCount);
      publicGuard.reserveBudget(realTargetCount, effectiveClamp);
    }

    // Now safe to mutate state — load or create conversation
    let convId = conversationId;
    let conv;
    let isNewConversation = false;
    if (convId && conversations.has(convId)) {
      conv = conversations.get(convId);
    } else {
      convId = newId('conv');
      const defaultProjectId = getDefaultProjectId();
      conv = { id: convId, rounds: [], perModelState: {}, projectId: defaultProjectId, projectName: 'Default Project' };
      conversations.set(convId, conv);
      isNewConversation = true;
    }

    // Start new round with the user's message
    const round = { user: { speaker: 'user', content: userMessage, ts: Date.now() }, agents: [] };
    if (Array.isArray(textAttachments) && textAttachments.length) {
      round.attachments = textAttachments.map((a) => ({ title: (a && a.title) || '', chars: (a && a.content ? String(a.content).length : 0) }));
    }
    conv.rounds.push(round);

    // FIX 4: Persist to SQLite — conversation row FIRST (for new convs), then messages
    // This preserves FK ordering: conversation_messages.conversation_id FK → conversations.id
    const roundNum = conv.rounds.length;

    if (isNewConversation) {
      // Insert conversation row FIRST so FK constraint is satisfied
      db.prepare(`
        INSERT INTO conversations (id, project_id, title, created_at, updated_at, round_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        convId,
        conv.projectId,
        `Conversation ${convId}`,
        Date.now(),
        Date.now(),
        0
      );
    }

    // Now insert the user message (FK to conversations.id is satisfied)
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

    // Index for search; never let indexing break the turn
    try { indexMessage(userMsgId); } catch (e) { console.error('Message indexing failed:', e); }

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

    // FIX 6b: Don't double-count turns — rate is counted per real call by the
    // guard block above (which ran BEFORE persistence), not by trackTurn.

    const mergedSystemPrompts = mergeSystemPrompts(systemPrompts);

    const tasks = preparedTargets.map(async (target) => {
      const { provider, requestedModelId, modelId, name, agentId, options, index } = target;
      const adapter = getAdapter(provider);

      // PUBLIC_MODE: budget kill-switch — real providers blocked, mock still works
      if (budgetBlocked && provider !== 'mock') {
        return { agentId, provider, name, modelId, requestedModelId, error: budgetStatus.message, tokenUsage: undefined };
      }
      // Build system prompt with file context
      let system = buildSystemPrompt({
        modelId,
        provider,
        projectId: conv.projectId || getDefaultProjectId(),
        projectName: conv.projectName || 'Default Project',
        conversationInfo: {
          round_count: conv.rounds.length,
          summary: conv.summary
        },
        systemPrompts: mergedSystemPrompts,
        agentId,
        modelIndex: index
      });
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
        } else if (provider === 'mock') {
          const messages = buildMessagesForOpenAI(conv, userMessage, modelId, agentId, system, textAttachments);
          result = await adapter({ model: modelId, messages, options, providerState });
        } else {
          throw new Error(`Unsupported provider: ${provider}`);
        }
        const { text, usage } = result;
        const maxTokens = options && options.maxTokens !== undefined ? options.maxTokens : resolveMaxTokens(provider);
        const tokenUsage = summarizeUsage(provider, usage, maxTokens);

        // PUBLIC_MODE: record token usage for budget tracking
        if (usage) {
          const totalTokens = tokenUsage && (tokenUsage.total || tokenUsage.used);
          publicGuard.recordUsage(provider, totalTokens);
        }
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

        // Index for search; never let indexing break the turn
        try { indexMessage(agentMsgId); } catch (e) { console.error('Message indexing failed:', e); }
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
        // FIX 5: Sanitize error in PUBLIC_MODE
        const safeErr = publicGuard.sanitizeError(err);
        const errorMsg = publicGuard.isPublicMode()
          ? publicGuard.genericProviderError(provider) || safeErr.message
          : safeErr.message;
        const maxTokens = options && options.maxTokens !== undefined ? options.maxTokens : resolveMaxTokens(provider);
        if (dbg) {
          console.log('[turn] error', {
            provider,
            agentId,
            name,
            modelId,
            requestedModelId,
            error: safeErr.message,
          });
        }
        return { agentId, provider, name, modelId, requestedModelId, error: errorMsg, tokenUsage: summarizeUsage(provider, undefined, maxTokens) };
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
            // FIX 4: Autosave disabled in PUBLIC_MODE
            if (conv.autoSave && conv.autoSave.enabled && !publicGuard.isPublicMode()) {
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
            error: publicGuard.isPublicMode() ? 'model service unavailable' : (err.message || 'Unknown error')
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
      // FIX 4: Autosave disabled in PUBLIC_MODE
      if (conv.autoSave && conv.autoSave.enabled && !publicGuard.isPublicMode()) {
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
    // FIX 5: Sanitize error in PUBLIC_MODE
    const safeErr = publicGuard.sanitizeError(e);
    const detail = publicGuard.isPublicMode()
      ? 'internal_error'
      : String(safeErr.message);
    res.status(500).json({ error: 'internal_error', detail });
  }
});

// Fetch a conversation (simple inspection)
app.get('/api/conversation/:id', (req, res) => {
  const id = req.params.id;

  // Try in-memory first
  let conv = conversations.get(id);

  // If not in memory, load from SQLite
  if (!conv) {
    const dbConv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!dbConv) {
      return res.status(404).json({ error: 'not_found' });
    }

    // Load messages and reconstruct
    const loaded = loadConversationsFromSQLite();
    conv = loaded.get(id);

    if (!conv) {
      return res.status(404).json({ error: 'not_found' });
    }

    // Add to in-memory cache
    conversations.set(id, conv);
  }

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
    res.status(500).json({ error: 'export_failed', detail: publicGuard.isPublicMode() ? 'internal_error' : String(e && e.message ? e.message : e) });
  }
});

// Toggle auto-save for a conversation
// FIX 4: Autosave disabled in PUBLIC_MODE
app.post('/api/conversation/:id/autosave', (req, res) => {
  try {
    if (publicGuard.isPublicMode()) {
      return res.status(403).json({
        error: 'autosave_disabled',
        message: 'Autosave is disabled in public sandbox mode.',
      });
    }
    const id = req.params.id;
    const conv = conversations.get(id);
    if (!conv) return res.status(404).json({ error: 'not_found' });
    const { enabled, format } = req.body || {};
    conv.autoSave = { enabled: !!enabled, format: (format === 'json' ? 'json' : 'md') };
    let filePath = undefined;
    if (conv.autoSave.enabled) {
      filePath = writeTranscript(conv, conv.autoSave.format || 'md');
    }
    res.json({ ok: true, enabled: conv.autoSave.enabled, format: conv.autoSave.format, path: filePath });
  } catch (e) {
    const safeErr = publicGuard.sanitizeError(e);
    res.status(500).json({ error: 'autosave_failed', detail: publicGuard.isPublicMode() ? 'internal_error' : String(safeErr.message) });
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
    else conv = { id: conversationId || '(preview)', rounds: [], perModelState: {}, projectId: getDefaultProjectId(), projectName: 'Default Project' };

    // Make a shallow copy and push a synthetic current round
    const convCopy = { id: conv.id, rounds: [...(conv.rounds || [])], perModelState: { ...(conv.perModelState || {}) } };
    convCopy.rounds.push({ user: { speaker: 'user', content: userMessage || '', ts: Date.now() }, agents: [] });

    const system = buildSystemPrompt({
      modelId,
      provider,
      projectId: conv.projectId || getDefaultProjectId(),
      projectName: conv.projectName || 'Default Project',
      conversationInfo: {
        round_count: convCopy.rounds.length,
        summary: conv.summary
      },
      systemPrompts: mergeSystemPrompts(systemPrompts),
      agentId
    });
    let view;
    if (provider === 'openai' || provider === 'xai') {
      const messages = buildMessagesForOpenAI(convCopy, userMessage || '', modelId, agentId, system, textAttachments);
      view = { messages };
    } else if (provider === 'anthropic' || provider === 'google') {
      const { system: sys, messages } = buildMessagesForAnthropic(convCopy, userMessage || '', modelId, agentId, system, textAttachments);
      view = { system: sys, messages };
    } else if (provider === 'mock') {
      const messages = buildMessagesForOpenAI(convCopy, userMessage || '', modelId, agentId, system, textAttachments);
      view = { messages };
    } else {
      return res.status(400).json({ error: 'unsupported_provider' });
    }
    res.json({ provider, requestedModelId, modelId, system, view });
  } catch (e) {
    res.status(500).json({ error: 'preview_failed', detail: publicGuard.isPublicMode() ? 'internal_error' : String(e && e.message ? e.message : e) });
  }
});

// GET /api/models – aggregate provider model lists and defaults
app.get('/api/models', async (req, res) => {
  try {
    const data = await listAllModels(DEFAULT_MODELS);
    const systemPrompts = getSystemPrompts();
    const activeModels = getConfig('active_models', []);

    data.prompts = {
      common: systemPrompts.common,
      perProvider: {
        openai: systemPrompts.perProvider.openai || '',
        anthropic: systemPrompts.perProvider.anthropic || '',
        google: systemPrompts.perProvider.google || '',
        xai: systemPrompts.perProvider.xai || '',
        mock: systemPrompts.perProvider.mock || '',
      },
    };
    data.activeModels = activeModels;

    // PUBLIC_MODE: restrict the advertised providers/models/defaults to the
    // allowlist so the UI picker only offers what will actually be accepted
    // (otherwise "smart" defaults resolve to disallowed models and the full
    // catalog is shown but mostly rejected).
    if (publicGuard.isPublicMode()) {
      const allowed = publicGuard.getAllowedModels();
      const byProvider = {};
      for (const { provider, modelId } of allowed) {
        (byProvider[provider] = byProvider[provider] || []).push(modelId);
      }
      const providers = {};
      const defaults = {};
      for (const [prov, ids] of Object.entries(byProvider)) {
        const orig = (data.providers[prov] && data.providers[prov].models) || [];
        providers[prov] = { available: true, models: ids.map(id => orig.find(m => m.id === id) || { id }) };
        defaults[prov] = ids[0];
      }
      providers.mock = data.providers.mock || { available: true, models: [{ id: 'mock-echo' }, { id: 'mock-lorem' }] };
      defaults.mock = 'mock-echo';
      data.providers = providers;
      data.defaults = defaults;
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'models_list_failed', detail: publicGuard.isPublicMode() ? 'internal_error' : String(e && e.message ? e.message : e) });
  }
});

// GET /api/conversations - List all conversations
app.get('/api/conversations', (req, res) => {
  try {
    const projectId = req.query.project_id || getDefaultProjectId();
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const convs = db.prepare(`
      SELECT
        id,
        project_id,
        title,
        summary,
        created_at,
        updated_at,
        round_count
      FROM conversations
      WHERE project_id = ?
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(projectId, limit, offset);

    const total = db.prepare(`
      SELECT COUNT(*) as count
      FROM conversations
      WHERE project_id = ?
    `).get(projectId);

    res.json({
      conversations: convs,
      total: total.count,
      limit,
      offset
    });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', detail: publicGuard.isPublicMode() ? 'internal_error' : String(e.message) });
  }
});

// GET /api/config - Get configuration
// FIX 3: In PUBLIC_MODE, return only public flags (banner, publicMode)
app.get('/api/config', (req, res) => {
  try {
    if (publicGuard.isPublicMode()) {
      return res.json(publicGuard.publicModeConfig());
    }
    const config = getAllConfig();
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: 'config_fetch_failed', detail: publicGuard.isPublicMode() ? 'internal_error' : String(e.message) });
  }
});

// POST /api/config - Update configuration
// FIX 3: Block config mutation in PUBLIC_MODE
app.post('/api/config', publicGuard.blockConfigMutationMiddleware, (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key) {
      return res.status(400).json({ error: 'key_required' });
    }

    setConfig(key, value);
    res.json({ ok: true, key, value });
  } catch (e) {
    res.status(500).json({ error: 'config_update_failed', detail: publicGuard.isPublicMode() ? 'internal_error' : String(e.message) });
  }
});

// POST /api/config/bulk - Update multiple config values
// FIX 3: Block config mutation in PUBLIC_MODE
app.post('/api/config/bulk', publicGuard.blockConfigMutationMiddleware, (req, res) => {
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
    res.status(500).json({ error: 'bulk_update_failed', detail: publicGuard.isPublicMode() ? 'internal_error' : String(e.message) });
  }
});

// GET /api/health - Server health check
app.get('/api/health', (req, res) => {
  try {
    // Check database connection
    db.prepare('SELECT 1').get();

    res.json({
      status: 'ok',
      database: 'connected',
      conversations: conversations.size,
      uptime: process.uptime(),
      ...publicGuard.publicModeConfig(),
    });
  } catch (e) {
    res.status(500).json({
      status: 'error',
      error: e.message
    });
  }
});

// Serve minimal static UI
app.use('/', express.static(path.join(__dirname, '..', 'web')));

// Bind to BIND_HOST if set. Defaults to 127.0.0.1 so only local processes
// (e.g. the nginx reverse proxy in production) can reach the app — reaching
// it directly from other hosts would bypass the XFF overwrite and the
// guard's per-IP limits. Set BIND_HOST=0.0.0.0 explicitly if you really
// need to listen on all interfaces (e.g. LAN access during development, or
// a deployment that is not behind a localhost reverse proxy).
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
app.listen(PORT, BIND_HOST, () => {
  console.log(`Multi-model chat server listening on http://${BIND_HOST}:${PORT}`);
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
