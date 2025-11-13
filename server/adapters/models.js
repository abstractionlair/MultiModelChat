const { getPath } = require('../utils/nested');

let fetchFn = globalThis.fetch;
try {
  if (!fetchFn) fetchFn = require('undici').fetch;
} catch {}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const XAI_API_KEY = process.env.XAI_API_KEY;

async function listOpenAIModels() {
  if (!OPENAI_API_KEY) return { available: false, models: [], error: 'OPENAI_API_KEY not set' };
  try {
    const resp = await (fetchFn || fetch)('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { available: false, models: [], error: `OpenAI list error ${resp.status}: ${text}` };
    }
    const json = await resp.json();
    const items = Array.isArray(json.data) ? json.data : [];
    const models = items
      .map((m) => ({ id: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { available: true, models };
  } catch (e) {
    return { available: false, models: [], error: String(e && e.message ? e.message : e) };
  }
}

async function listAnthropicModels() {
  if (!ANTHROPIC_API_KEY) return { available: false, models: [], error: 'ANTHROPIC_API_KEY not set' };
  try {
    const resp = await (fetchFn || fetch)('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { available: false, models: [], error: `Anthropic list error ${resp.status}: ${text}` };
    }
    const json = await resp.json();
    const items = Array.isArray(json.data) ? json.data : [];
    const models = items.map((m, idx) => ({
      id: m.id,
      displayName: m.display_name || undefined,
      createdAt: m.created_at || undefined,
      latest: idx === 0, // newer releases are first per docs
    }));
    return { available: true, models };
  } catch (e) {
    return { available: false, models: [], error: String(e && e.message ? e.message : e) };
  }
}

async function listGoogleModels() {
  if (!GOOGLE_API_KEY) return { available: false, models: [], error: 'GOOGLE_API_KEY not set' };
  try {
    const resp = await (fetchFn || fetch)(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GOOGLE_API_KEY)}`);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { available: false, models: [], error: `Google list error ${resp.status}: ${text}` };
    }
    const json = await resp.json();
    const items = Array.isArray(json.models) ? json.models : [];
    const models = items.map((m) => {
      const full = m.name || '';
      const id = full.startsWith('models/') ? full.slice('models/'.length) : full;
      const thinking = (
        // Prefer documented boolean when present
        (typeof m.thinking === 'boolean' ? m.thinking : undefined) ||
        // Some responses nest capabilities; attempt best-effort
        (getPath(m, 'capabilities.thinking') === true ? true : false)
      );
      const version = m.version || undefined;
      return { id, displayName: m.display_name || undefined, thinking, version };
    });
    return { available: true, models };
  } catch (e) {
    return { available: false, models: [], error: String(e && e.message ? e.message : e) };
  }
}

async function listXAIModels() {
  if (!XAI_API_KEY) return { available: false, models: [], error: 'XAI_API_KEY not set' };
  try {
    const resp = await (fetchFn || fetch)('https://api.x.ai/v1/models', {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { available: false, models: [], error: `xAI list error ${resp.status}: ${text}` };
    }
    const json = await resp.json();
    const items = Array.isArray(json.data) ? json.data : [];
    const models = items.map((m) => ({ id: m.id }));
    return { available: true, models };
  } catch (e) {
    return { available: false, models: [], error: String(e && e.message ? e.message : e) };
  }
}

async function listAllModels(defaults) {
  const [openai, anthropic, google, xai] = await Promise.all([
    listOpenAIModels(),
    listAnthropicModels(),
    listGoogleModels(),
    listXAIModels(),
  ]);
  return {
    defaults: defaults || {},
    providers: {
      openai,
      anthropic,
      google,
      xai,
    },
  };
}

module.exports = {
  listOpenAIModels,
  listAnthropicModels,
  listGoogleModels,
  listXAIModels,
  listAllModels,
};

