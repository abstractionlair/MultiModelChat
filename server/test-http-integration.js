// HTTP-level integration test for the PUBLIC_MODE guard.
//
// Spawns the real server as a subprocess (once per mode) and drives it over
// HTTP, so it exercises the full request pipeline — the layer the unit suite
// (test-public-guard.js) cannot see. This exists because a fix round once
// passed 100/100 unit tests while every /api/turn crashed with a foreign-key
// error; only an HTTP turn catches that class of regression.
//
// Run: node server/test-http-integration.js   (manages its own servers/env)

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0, failed = 0;
function ok(c, label) { if (c) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}`); failed++; } }

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const opts = { host: '127.0.0.1', port, method, path: p,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } };
    const r = http.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { let j; try { j = JSON.parse(d); } catch { j = d; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function startServer(port, publicMode, overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-int-'));
  const env = { ...process.env, PORT: String(port),
    OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake', GOOGLE_API_KEY: 'fake', XAI_API_KEY: 'fake',
    DB_PATH: path.join(tmp, 'db.sqlite'), STORAGE_DIR: path.join(tmp, 'storage'), TRANSCRIPTS_DIR: path.join(tmp, 'tx'),
    PUBLIC_TURNS_PER_MIN: '100', PUBLIC_MAX_TARGETS_PER_TURN: '4', PUBLIC_MAX_MESSAGE_CHARS: '8192',
    // Explicit test allowlist (independent of the production default).
    PUBLIC_MODEL_ALLOWLIST: 'openai:gpt-4o-mini,openai:gpt-5-nano,google:gemini-2.5-flash-lite', ...overrides };
  if (publicMode) env.PUBLIC_MODE = '1'; else delete env.PUBLIC_MODE;
  const proc = spawn('node', [path.join(__dirname, 'server.js')], { env, stdio: 'ignore' });
  return { proc, tmp };
}

async function waitUp(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await req(port, 'GET', '/api/health'); if (r.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server on ${port} did not come up`);
}

async function main() {
  // ---- PUBLIC_MODE = 1 ----
  const P = 3971;
  const pub = startServer(P, true);
  try {
    await waitUp(P);

    console.log('PUBLIC_MODE=1');
    let r = await req(P, 'POST', '/api/turn', { userMessage: 'hi', targetModels: [{ provider: 'mock', modelId: 'mock-echo' }] });
    ok(r.status === 200, 'valid mock turn -> 200 (FK/persist path intact)');
    ok(r.body && r.body.conversationId, 'turn persisted a conversation');

    r = await req(P, 'POST', '/api/turn', { userMessage: 'x', targetModels: [{ provider: 'openai', modelId: 'gpt-5-turbo' }] });
    ok(r.status === 400, 'disallowed model -> 400');

    // case-variant of disallowed model
    r = await req(P, 'POST', '/api/turn', { userMessage: 'x', targetModels: [{ provider: 'OpenAI', modelId: 'GPT-5-TURBO' }] });
    ok(r.status === 400, 'disallowed model case-variant -> 400');

    // extraBody disguise on an ALLOWED model: must dispatch the allowed model, never gpt-5
    r = await req(P, 'POST', '/api/turn', { userMessage: 'x', targetModels: [{ provider: 'openai', modelId: 'gpt-4o-mini', options: { extraBody: { model: 'gpt-5', max_output_tokens: 999999 } } }] });
    const disp = (r.body && r.body.results && r.body.results[0] && r.body.results[0].modelId) || '';
    ok(!/gpt-5/i.test(disp), `extraBody model override stripped (dispatched "${disp}", not gpt-5)`);

    r = await req(P, 'POST', '/api/turn', { userMessage: 'x', targetModels: Array(5).fill({ provider: 'mock', modelId: 'mock-echo' }) });
    ok(r.status === 400, '5 targets over cap(4) -> 400');

    r = await req(P, 'POST', '/api/turn', { userMessage: 'x'.repeat(9000), targetModels: [{ provider: 'mock', modelId: 'mock-echo' }] });
    ok(r.status === 400, '9000-char message over cap -> 400');

    r = await req(P, 'POST', '/api/config', { key: 'pwn', value: 'x' });
    ok(r.status === 403, 'config POST -> 403');

    r = await req(P, 'GET', '/api/config');
    const keys = r.body && typeof r.body === 'object' ? Object.keys(r.body) : [];
    ok(r.status === 200 && !keys.includes('system_prompts') && !keys.includes('active_models'), `config GET minimal (keys: ${keys.join(',')})`);

    r = await req(P, 'DELETE', '/api/projects/default/files/anyid');
    ok(r.status === 403, 'DELETE file -> 403');

    const cid = (await req(P, 'POST', '/api/turn', { userMessage: 'x', targetModels: [{ provider: 'mock', modelId: 'mock-echo' }] })).body.conversationId;
    r = await req(P, 'POST', `/api/conversation/${cid}/autosave`, {});
    ok(r.status === 403, 'autosave -> 403');

    // XFF is not trusted for a fresh bucket (trust proxy = 1 hop)
    let codes = [];
    for (let i = 0; i < 6; i++) codes.push((await req(P, 'POST', '/api/turn', { userMessage: 'x', targetModels: [{ provider: 'mock', modelId: 'mock-echo' }] }, { 'X-Forwarded-For': `5.5.5.${i}` })).status);
    ok(codes.every(c => c === 200 || c === 429), `spoofed XFF did not error the server (codes: ${codes.join(',')})`);

    // Oversized body returns generic JSON, NOT an HTML stack with a filesystem path
    const big = await req(P, 'POST', '/api/turn', { userMessage: 'x', pad: 'y'.repeat(80000), targetModels: [{ provider: 'mock', modelId: 'mock-echo' }] });
    ok(big.status === 413 || big.status === 400, `oversized body rejected (${big.status})`);
    ok(typeof big.body === 'object' && !/node_modules|\/home\//.test(JSON.stringify(big.body)), 'oversized-body error is generic JSON, no filesystem path');
  } finally { pub.proc.kill(); }

  // ---- Rate double-count + budget exact-fit (dedicated small-limit server) ----
  const P2 = 3973;
  const tight = startServer(P2, true, { PUBLIC_TURNS_PER_MIN: '3', PUBLIC_DAILY_TOKEN_BUDGET: '1400', PUBLIC_MAX_TOKENS_PER_TURN: '700' });
  try {
    await waitUp(P2);
    console.log('\nrate/budget accounting (min=3 calls, budget=1400=2x700)');
    // 2 mock targets consume 0 real slots; then a disallowed-real is 400 — use mock to prove mock is unmetered by per-call rate
    // Real-call counting: with only mock available (no real keys dispatch), assert exact-fit budget dispatches.
    // Exact-fit budget: allowlist has no real key funded here, so use the reservation path via a real allowed model that errors on fake key but still reserves.
    let a = await req(P2, 'POST', '/api/turn', { userMessage: 'x', targetModels: [{ provider: 'openai', modelId: 'gpt-4o-mini' }, { provider: 'openai', modelId: 'gpt-4o-mini' }] });
    ok(a.status === 200, `exact-fit budget turn (2x700=1400) dispatches, not self-blocked (${a.status})`);
    const spent = a.body && a.body.results && a.body.results.every(r => !/budget spent/i.test(r.text || r.error || ''));
    ok(spent, 'exact-fit turn did not falsely report "budget spent"');
  } finally { tight.proc.kill(); }

  // ---- Rate-limited turn must NOT reserve budget or persist (griefing vector) ----
  const P3 = 3974;
  const grief = startServer(P3, true, { PUBLIC_TURNS_PER_MIN: '2', PUBLIC_DAILY_TOKEN_BUDGET: '100000', PUBLIC_MAX_TOKENS_PER_TURN: '700' });
  try {
    await waitUp(P3);
    console.log('\nrate-limited turn leaves budget + storage clean');
    // First 2-real turn consumes the 2-call minute budget.
    let first = await req(P3, 'POST', '/api/turn', { userMessage: 'x', targetModels: [{ provider: 'openai', modelId: 'gpt-4o-mini' }, { provider: 'openai', modelId: 'gpt-4o-mini' }] });
    ok(first.status === 200, `first 2-call turn admitted (${first.status})`);
    const before = (await req(P3, 'GET', '/api/conversations')).body;
    // Second 2-real turn exceeds the 2/min cap -> 429 and must reserve nothing / persist nothing.
    let second = await req(P3, 'POST', '/api/turn', { userMessage: 'y', targetModels: [{ provider: 'openai', modelId: 'gpt-4o-mini' }, { provider: 'openai', modelId: 'gpt-4o-mini' }] });
    ok(second.status === 429, `second turn rate-limited 429 (${second.status})`);
    const after = (await req(P3, 'GET', '/api/conversations')).body;
    ok(after && before && after.total === before.total, `rate-limited turn persisted no conversation (before=${before && before.total}, after=${after && after.total})`);
  } finally { grief.proc.kill(); }

  // ---- PUBLIC_MODE unset (baseline must be fully inert) ----
  const B = 3972;
  const base = startServer(B, false);
  try {
    await waitUp(B);
    console.log('\nPUBLIC_MODE unset (baseline inert)');
    let r = await req(B, 'POST', '/api/turn', { userMessage: 'hi', targetModels: [{ provider: 'mock', modelId: 'mock-echo' }] });
    ok(r.status === 200 && r.body.conversationId, 'valid turn -> 200 + persisted');
    r = await req(B, 'POST', '/api/turn', { userMessage: 'x', targetModels: [{ provider: 'openai', modelId: 'gpt-5-turbo' }] });
    ok(r.status !== 400 || (r.body && r.body.error === 'internal_error'), 'allowlist inert (no public 400 rejection)');
    r = await req(B, 'POST', '/api/config', { key: 'k', value: 'v' });
    ok(r.status !== 403, 'config POST not blocked when inert');
  } finally { base.proc.kill(); }

  console.log(`\n----------------------------------------\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('\nIntegration tests FAILED'); process.exit(1); }
  console.log('\nAll integration tests passed');
}

main().catch(e => { console.error('harness error:', e); process.exit(1); });
