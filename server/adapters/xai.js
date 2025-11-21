const XAI_API_KEY = process.env.XAI_API_KEY;
let fetchFn = globalThis.fetch;
try {
  if (!fetchFn) fetchFn = require('undici').fetch;
} catch {}

// Accepts { model, messages, options }
// Uses OpenAI-compatible Chat Completions API
async function sendXAI({ model, messages, options }) {
  if (!XAI_API_KEY) throw new Error('XAI_API_KEY not set');

  const body = {
    model,
    messages,
    ...(options && options.extraBody ? options.extraBody : {}),
  };

  // Add tools if provided (server-side agentic tools)
  if (options && options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools;
  }

  if (options && options.maxTokens !== undefined && body.max_tokens === undefined) {
    const maxOut = Number(options.maxTokens);
    if (Number.isFinite(maxOut) && maxOut > 0) body.max_tokens = Math.floor(maxOut);
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${XAI_API_KEY}`,
    ...(options && options.extraHeaders ? options.extraHeaders : {}),
  };

  const resp = await (fetchFn || fetch)('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`xAI error ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  const choice = (json.choices && json.choices[0]) || {};
  const text = choice.message && choice.message.content ? choice.message.content : '';
  const meta = { finish_reason: choice && choice.finish_reason };
  return { text, usage: json.usage, meta };
}

module.exports = { sendXAI };
