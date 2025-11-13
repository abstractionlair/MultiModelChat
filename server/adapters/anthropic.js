const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const { getPath, setPath } = require('../utils/nested');
let fetchFn = globalThis.fetch;
try {
  if (!fetchFn) {
    fetchFn = require('undici').fetch;
  }
} catch (e) {}

async function sendAnthropic({ model, system, messages, options, providerState }) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  // Anthropic Messages API expects content blocks.
  const mapped = (messages || []).map((m) => ({
    role: m.role,
    content: [{ type: 'text', text: String(m.content || '') }],
  }));
  const payload = {
    model,
    ...(system ? { system } : {}),
    messages: mapped,
    ...(options && options.extraBody ? options.extraBody : {}),
  };

  if (options && options.maxTokens !== undefined && payload.max_tokens === undefined) {
    const maxOut = Number(options.maxTokens);
    if (Number.isFinite(maxOut) && maxOut > 0) payload.max_tokens = Math.floor(maxOut);
  }
  // Anthropic requires max_tokens; if not provided by caller or env, set a generous default.
  if (payload.max_tokens === undefined) {
    const envMax = process.env.ANTHROPIC_MAX_OUTPUT_TOKENS ? parseInt(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS, 10) : undefined;
    payload.max_tokens = Number.isFinite(envMax) && envMax > 0 ? envMax : 8192;
  }

  // Enable extended thinking if provided (Claude thinking param)
  const thinkingFromOptions = options && options.thinking;
  const thinkingBudgetEnv = process.env.ANTHROPIC_THINKING_BUDGET ? parseInt(process.env.ANTHROPIC_THINKING_BUDGET, 10) : undefined;
  if (thinkingFromOptions && thinkingFromOptions.type === 'enabled') {
    payload.thinking = { type: 'enabled', budget_tokens: thinkingFromOptions.budget_tokens || thinkingBudgetEnv || 1024 };
  } else if (thinkingBudgetEnv && !payload.thinking) {
    payload.thinking = { type: 'enabled', budget_tokens: thinkingBudgetEnv };
  }

  // Optionally attach providerState via env mapping
  const STATE_REQ_PATH = process.env.ANTHROPIC_STATE_REQUEST_PATH; // e.g., "thinking.context"
  if (providerState && STATE_REQ_PATH) {
    setPath(payload, STATE_REQ_PATH, providerState);
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    ...(options && options.extraHeaders ? options.extraHeaders : {}),
  };

  const resp = await (fetchFn || fetch)('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Anthropic error ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  let text = '';
  if (Array.isArray(json.content)) {
    for (const block of json.content) {
      if (block && block.type === 'text' && block.text) text += block.text;
    }
  }
  const meta = {
    stop_reason: json && json.stop_reason,
  };
  const STATE_RESP_PATH = process.env.ANTHROPIC_STATE_RESPONSE_PATH; // e.g., "response_metadata.reasoning"
  let providerStateOut = undefined;
  if (STATE_RESP_PATH) {
    providerStateOut = getPath(json, STATE_RESP_PATH);
  } else {
    providerStateOut = (json && (json.reasoning || (json.usage && json.usage.thinking_tokens))) || undefined;
  }
  return { text, usage: json.usage, providerState: providerStateOut, meta }; // usage may vary by API version
}

module.exports = { sendAnthropic };
