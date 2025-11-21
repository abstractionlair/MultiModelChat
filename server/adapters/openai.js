const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const { getPath, setPath } = require('../utils/nested');
// Prefer undici fetch to be explicit in Node
let fetchFn = globalThis.fetch;
try {
  if (!fetchFn) {
    fetchFn = require('undici').fetch;
  }
} catch (e) {
  // ignore; rely on global fetch if present
}

function toResponsesInput(messages, providerState) {
  const input = [];
  if (providerState) {
    input.push({
      role: 'assistant',
      content: [{ type: 'reasoning', encrypted_content: providerState }],
    });
  }
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === 'system') continue; // system handled via instructions
    input.push({ role: m.role, content: String(m.content || '') });
  }
  return input;
}

function extractInstructions(messages) {
  const systems = (messages || []).filter(m => m.role === 'system').map(m => String(m.content || ''));
  return systems.length ? systems.join('\n\n') : undefined;
}

function extractOpenAIText(json) {
  if (!json) return '';
  if (typeof json.output_text === 'string' && json.output_text.length) return json.output_text;
  const parts = [];
  const out = Array.isArray(json.output) ? json.output : [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === 'output_text' && typeof block.text === 'string') parts.push(block.text);
      else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block?.type === 'tool_use') {
        // Include tool usage information in the output
        parts.push(`\n\n[Tool: ${block.name || 'unknown'}]\n`);
        if (block.input) {
          parts.push(JSON.stringify(block.input, null, 2) + '\n');
        }
      }
    }
  }
  return parts.join('');
}

function extractOpenAIProviderState(json) {
  const out = Array.isArray(json?.output) ? json.output : [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === 'reasoning' && block?.reasoning?.encrypted_content) {
        return block.reasoning.encrypted_content;
      }
    }
  }
  return undefined;
}

async function sendOpenAI({ model, messages, options, providerState }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  const instructions = extractInstructions(messages);
  const input = toResponsesInput(messages, providerState);

  const body = {
    model,
    ...(instructions ? { instructions } : {}),
    input,
    stream: false,
    ...(options && options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options && options.extraBody ? options.extraBody : {}),
  };

  // Add tools if provided (Responses API)
  if (options && options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools;
  }

  if (options && options.maxTokens !== undefined && body.max_output_tokens === undefined) {
    const maxOut = Number(options.maxTokens);
    if (Number.isFinite(maxOut) && maxOut > 0) body.max_output_tokens = Math.floor(maxOut);
  }

  // Optional env-based state mapping remains supported
  const STATE_REQ_PATH = process.env.OPENAI_STATE_REQUEST_PATH;
  if (providerState && STATE_REQ_PATH) {
    setPath(body, STATE_REQ_PATH, providerState);
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    ...(options && options.extraHeaders ? options.extraHeaders : {}),
  };

  const resp = await (fetchFn || fetch)('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OpenAI error ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  const text = extractOpenAIText(json);
  const meta = {
    status: json && json.status,
    outputTypes: Array.isArray(json && json.output)
      ? Array.from(new Set((json.output || []).flatMap(item => (Array.isArray(item.content) ? item.content.map(c => c && c.type).filter(Boolean) : []))))
      : undefined,
  };
  const STATE_RESP_PATH = process.env.OPENAI_STATE_RESPONSE_PATH;
  let providerStateOut = STATE_RESP_PATH ? getPath(json, STATE_RESP_PATH) : undefined;
  if (!providerStateOut) providerStateOut = extractOpenAIProviderState(json);
  return { text, usage: json.usage, providerState: providerStateOut, meta };
}

module.exports = { sendOpenAI };
