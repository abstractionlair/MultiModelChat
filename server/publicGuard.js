const { db } = require('./db/index');

const PUBLIC_MODE_BANNER =
  'Public sandbox — a personal experiment in multi-model chat. Conversations are visible to everyone and wiped daily. Cheap models only. Please don\'t paste anything private.';

const ALLOWED_PROVIDERS = ['openai', 'anthropic', 'google', 'xai', 'mock'];

const DEFAULT_ALLOWLIST = [
  'openai:gpt-4o-mini',
  'anthropic:claude-3-haiku-20240307',
  'google:gemini-2.0-flash-lite',
  'xai:grok-2',
];

const env = (...args) => args.some(k => process.env[k] !== undefined);

function isPublicMode() {
  return process.env.PUBLIC_MODE === '1' || process.env.PUBLIC_MODE === 'true';
}

function parseAllowlist() {
  const raw = process.env.PUBLIC_MODEL_ALLOWLIST;
  if (!raw || !raw.trim()) {
    return new Set(DEFAULT_ALLOWLIST);
  }
  const items = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  items.push('mock:mock-echo');
  items.push('mock:mock-lorem');
  items.push('mock:mock-slow');
  items.push('mock:mock-error');
  return new Set(items);
}

function checkAllowlist(targetModels) {
  if (!isPublicMode()) return null;

  const allowlist = parseAllowlist();

  for (const target of targetModels) {
    const provider = (target.provider || '').toLowerCase();
    const modelId = (target.resolvedModelId || target.modelId || '').toLowerCase();
    const key = provider === 'mock' ? `mock:${modelId}` : `${provider}:${modelId}`;
    const wildcard = provider === 'mock' ? 'mock:*' : null;

    const allowed = allowlist.has(key) || (wildcard && allowlist.has(wildcard)) || provider === 'mock';

    if (!allowed) {
      const allowedList = Array.from(allowlist)
        .filter(k => !k.startsWith('mock:'))
        .sort();
      return {
        status: 400,
        error: 'model_not_allowed',
        message: `Model "${provider}:${modelId}" is not on the public allowlist. Allowed models: ${allowedList.join(', ')}. Mock models are always allowed.`,
        allowedModels: allowedList,
      };
    }
  }

  return null;
}

function clampMaxTokens(options) {
  if (!isPublicMode()) return options;

  const maxTokens = parseInt(process.env.PUBLIC_MAX_TOKENS_PER_TURN, 10);
  const clamp = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 700;

  if (!options) {
    return { maxTokens: clamp };
  }

  const merged = { ...options };
  if (merged.maxTokens === undefined || merged.maxTokens > clamp) {
    merged.maxTokens = clamp;
  }
  return merged;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.connection?.remoteAddress || '127.0.0.1';
}

let minuteCounters = new Map();

function getUtcDate() {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function getUtcDateMs() {
  return Date.now();
}

function checkMinuteLimit(ip) {
  const maxPerMin = parseInt(process.env.PUBLIC_TURNS_PER_MIN, 10);
  const limit = Number.isFinite(maxPerMin) && maxPerMin > 0 ? maxPerMin : 6;

  const windowMs = 60 * 1000;
  const now = getUtcDateMs();
  const key = ip;

  let entries = minuteCounters.get(key);
  if (!entries) {
    entries = [];
    minuteCounters.set(key, entries);
  }

  const cutoff = now - windowMs;
  while (entries.length > 0 && entries[0] < cutoff) {
    entries.shift();
  }

  if (entries.length >= limit) {
    const oldest = entries[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    return {
      status: 429,
      error: 'rate_limit_minute',
      message: `Too many requests. You can send up to ${limit} turns per minute. Please wait ${retryAfter}s and try again.`,
      retryAfter,
    };
  }

  entries.push(now);
  return null;
}

function getDailyCounter(ip) {
  const date = getUtcDate();
  const row = db.prepare(
    'SELECT turns, tokens FROM guard_usage WHERE utc_date = ? AND ip = ? AND key_type = ?'
  ).get(date, ip, 'ip');
  return row || { turns: 0, tokens: 0 };
}

function incrementDailyCounter(ip) {
  const date = getUtcDate();
  const now = getUtcDateMs();

  db.prepare(`
    INSERT INTO guard_usage (utc_date, ip, key_type, turns, tokens, updated_at)
    VALUES (?, ?, 'ip', 1, 0, ?)
    ON CONFLICT(utc_date, ip, key_type) DO UPDATE SET
      turns = turns + 1,
      updated_at = ?
  `).run(date, ip, now, now);
}

function getUtcDateFromMs(ms) {
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

function checkDayLimit(ip) {
  const maxPerDay = parseInt(process.env.PUBLIC_TURNS_PER_DAY, 10);
  const limit = Number.isFinite(maxPerDay) && maxPerDay > 0 ? maxPerDay : 60;

  const counter = getDailyCounter(ip);
  if (counter.turns >= limit) {
    return {
      status: 429,
      error: 'rate_limit_day',
      message: `Daily turn limit reached (${limit} turns per day). Please try again tomorrow.`,
    };
  }

  return null;
}

function recordUsage(provider, tokens) {
  if (!isPublicMode()) return;
  if (provider === 'mock') return;

  const date = getUtcDate();
  const now = getUtcDateMs();
  const ip = 'GLOBAL';

  const tokensVal = Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : 0;
  if (tokensVal <= 0) return;

  db.prepare(`
    INSERT INTO guard_usage (utc_date, ip, key_type, turns, tokens, updated_at)
    VALUES (?, 'GLOBAL', 'daily_budget', 0, ?, ?)
    ON CONFLICT(utc_date, ip, key_type) DO UPDATE SET
      tokens = tokens + ?,
      updated_at = ?
  `).run(date, tokensVal, now, tokensVal, now);
}

function checkDailyBudget() {
  if (!isPublicMode()) return null;

  const maxTokens = parseInt(process.env.PUBLIC_DAILY_TOKEN_BUDGET, 10);
  const budget = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 2000000;

  const date = getUtcDate();
  const row = db.prepare(
    'SELECT tokens FROM guard_usage WHERE utc_date = ? AND ip = ? AND key_type = ?'
  ).get(date, 'GLOBAL', 'daily_budget');

  const used = row ? row.tokens : 0;
  if (used >= budget) {
    return {
      blocked: true,
      message: 'Daily budget spent — mock model still available',
    };
  }

  return null;
}

async function wipeOldConversations() {
  if (!isPublicMode()) return;

  const maxAgeHours = parseInt(process.env.PUBLIC_WIPE_HOURS, 10);
  const maxAge = (Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 24) * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAge;

  const oldConvs = db.prepare(
    'SELECT id FROM conversations WHERE updated_at < ?'
  ).all(cutoff);

  for (const conv of oldConvs) {
    const messages = db.prepare(
      'SELECT id, metadata FROM conversation_messages WHERE conversation_id = ?'
    ).all(conv.id);

    for (const msg of messages) {
      db.prepare('DELETE FROM conversation_messages WHERE id = ?').run(msg.id);
    }

    db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
  }

  const storageDir = process.env.STORAGE_DIR || require('path').join(__dirname, '..', 'storage');
  try {
    const fs = require('fs');
    const fsp = fs.promises;
    const files = await fsp.readdir(storageDir);
    const dbFiles = new Set(
      db.prepare('SELECT content_location FROM project_files WHERE content_location IS NOT NULL')
        .all()
        .map(r => r.content_location)
    );
    for (const f of files) {
      const fullPath = require('path').join(storageDir, f);
      if (!dbFiles.has(fullPath)) {
        try { await fsp.unlink(fullPath); } catch {}
      }
    }
  } catch {}
}

function wipeInterval() {
  const hours = parseInt(process.env.PUBLIC_WIPE_HOURS, 10);
  const interval = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
  setInterval(wipeOldConversations, interval);
}

function publicModeConfig() {
  return {
    publicMode: isPublicMode(),
    banner: isPublicMode() ? PUBLIC_MODE_BANNER : '',
  };
}

function blockUploadsMiddleware(req, res, next) {
  if (!isPublicMode()) return next();

  return res.status(403).json({
    error: 'uploads_disabled',
    message: 'File uploads are disabled in public sandbox mode.',
  });
}

function guardsInert() {
  return !isPublicMode();
}

function rateLimitCheck(req) {
  if (!isPublicMode()) return null;

  const ip = getClientIp(req);
  const minuteCheck = checkMinuteLimit(ip);
  if (minuteCheck) return minuteCheck;

  const dayCheck = checkDayLimit(ip);
  if (dayCheck) return dayCheck;

  return null;
}

function trackTurn(req) {
  if (!isPublicMode()) return;
  const ip = getClientIp(req);
  incrementDailyCounter(ip);
}

module.exports = {
  isPublicMode,
  checkAllowlist,
  clampMaxTokens,
  getClientIp,
  checkMinuteLimit,
  checkDayLimit,
  getDailyCounter,
  incrementDailyCounter,
  recordUsage,
  checkDailyBudget,
  wipeOldConversations,
  wipeInterval,
  publicModeConfig,
  blockUploadsMiddleware,
  guardsInert,
  rateLimitCheck,
  trackTurn,
  PUBLIC_MODE_BANNER,
};
