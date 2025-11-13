const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
let fetchFn = globalThis.fetch;
try {
  if (!fetchFn) fetchFn = require('undici').fetch;
} catch {}

// Accepts { model, system, messages, options, providerState }
// messages: array of { role: 'user'|'assistant', content: string }
function extractCitations(json) {
  const citations = [];
  const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
  for (const cand of candidates) {
    const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    for (const part of parts) {
      const cm = part && part.citationMetadata;
      const citList = Array.isArray(cm?.citations) ? cm.citations : [];
      for (const c of citList) {
        const uri = c?.uri || c?.url;
        if (uri) citations.push({ uri, title: c?.title });
      }
    }
    const gm = cand && cand.groundingMetadata;
    // groundingAttributions[].web.uri/title is another common path
    const atts = Array.isArray(gm?.groundingAttributions) ? gm.groundingAttributions : [];
    for (const a of atts) {
      const web = a && a.web;
      const uri = web?.uri || web?.url;
      if (uri) citations.push({ uri, title: web?.title });
    }
  }
  // de-dup by uri
  const seen = new Set();
  const uniq = [];
  for (const c of citations) {
    const key = c.uri;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  return uniq;
}
async function sendGoogle({ model, system, messages, options, providerState }) {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY not set');

  const contents = [];
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || !m.role) continue;
      const role = m.role === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts: [{ text: String(m.content || '') }] });
    }
  }

  const body = {
    contents,
    ...(system ? { system_instruction: { parts: [{ text: String(system) }] } } : {}),
    ...(options && options.extraBody ? options.extraBody : {}),
  };

  if (options && options.maxTokens !== undefined) {
    const maxOut = Number(options.maxTokens);
    if (Number.isFinite(maxOut) && maxOut > 0) {
      if (!body.generationConfig || typeof body.generationConfig !== 'object') body.generationConfig = body.generationConfig && typeof body.generationConfig === 'object' ? body.generationConfig : {};
      if (body.generationConfig.maxOutputTokens === undefined) {
        body.generationConfig.maxOutputTokens = Math.floor(maxOut);
      }
    }
  }

  // Optional: forward opaque providerState if a mapping is provided via env
  const STATE_REQ_PATH = process.env.GOOGLE_STATE_REQUEST_PATH; // e.g., thinkingConfig.context
  if (providerState && STATE_REQ_PATH) {
    // naive dotted-path setter
    const parts = STATE_REQ_PATH.split('.');
    let cur = body;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = providerState;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options && options.extraHeaders ? options.extraHeaders : {}),
  };
  const resp = await (fetchFn || fetch)(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Google error ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  let text = '';
  const cands = Array.isArray(json.candidates) ? json.candidates : [];
  const first = cands[0] || {};
  const content = first && first.content;
  // Primary path: content.parts[].text
  if (content && Array.isArray(content.parts)) {
    for (const p of content.parts) {
      if (!p) continue;
      if (typeof p.text === 'string') text += p.text;
    }
  }
  // Fallback path: some SDKs emit candidates[0].content as array of Parts
  if (!text && Array.isArray(content)) {
    for (const p of content) {
      if (p && typeof p.text === 'string') text += p.text;
    }
  }
  // Another fallback: concatenate top-level candidates[].content if it's a string
  if (!text && typeof content === 'string') text = content;
  const meta = {
    finishReason: first && first.finishReason,
    promptFeedback: json && json.promptFeedback,
    citations: extractCitations(json),
  };
  // Optional extract of provider state
  const STATE_RESP_PATH = process.env.GOOGLE_STATE_RESPONSE_PATH; // e.g., responseMetadata.thinking
  let providerStateOut;
  if (STATE_RESP_PATH) {
    const parts = STATE_RESP_PATH.split('.');
    let cur = json;
    for (const p of parts) cur = cur && cur[p];
    providerStateOut = cur;
  }
  return { text, usage: json.usageMetadata, providerState: providerStateOut, meta };
}

module.exports = { sendGoogle };
