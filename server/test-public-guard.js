const { db } = require('./db/index');
const { runMigrations } = require('./db/migrate');

runMigrations();

let failures = 0;
let passed = 0;

async function main() {

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures++;
  }
}

// Save original env and restore later
const ORIGINAL_ENV = { ...process.env };

function setPublicMode(val) {
  if (val) {
    process.env.PUBLIC_MODE = '1';
  } else {
    delete process.env.PUBLIC_MODE;
  }
}

function clearPublicEnv() {
  delete process.env.PUBLIC_MODE;
  delete process.env.PUBLIC_MODEL_ALLOWLIST;
  delete process.env.PUBLIC_MAX_TOKENS_PER_TURN;
  delete process.env.PUBLIC_TURNS_PER_MIN;
  delete process.env.PUBLIC_TURNS_PER_DAY;
  delete process.env.PUBLIC_DAILY_TOKEN_BUDGET;
  delete process.env.PUBLIC_WIPE_HOURS;
}

// Track test DB state — clean guard_usage between tests
function cleanGuardUsage() {
  db.exec('DELETE FROM guard_usage');
}

console.log('=== PUBLIC_MODE Guard Tests ===\n');

// ===== Test 1: PUBLIC_MODE unset → all guards inert =====
console.log('1. PUBLIC_MODE unset → guards inert');
clearPublicEnv();
delete process.env.PUBLIC_MODE;

const guard = require('./publicGuard');
assertEqual(guard.isPublicMode(), false, 'isPublicMode() returns false');
assertEqual(guard.guardsInert(), true, 'guardsInert() returns true');
assertEqual(guard.checkAllowlist([{ provider: 'openai', modelId: 'gpt-5' }]), null, 'allowlist check passes (inert)');
assertEqual(guard.rateLimitCheck({ headers: {}, ip: '1.2.3.4', connection: { remoteAddress: '1.2.3.4' } }), null, 'rateLimitCheck passes (inert)');
assertEqual(guard.checkDailyBudget(), null, 'daily budget check passes (inert)');

let clamped = guard.clampMaxTokens({ maxTokens: 99999 });
assertEqual(clamped.maxTokens, 99999, 'clampMaxTokens leaves high values alone when inert');
assertEqual(guard.clampMaxTokens(undefined), undefined, 'clampMaxTokens(undefined) returns undefined when inert');

console.log();

// ===== Test 2: Allowlist rejection + mock always allowed =====
console.log('2. Allowlist rejection + mock always allowed');
setPublicMode(true);
process.env.PUBLIC_MODEL_ALLOWLIST = 'openai:gpt-4o-mini,anthropic:claude-3-haiku-20240307';
cleanGuardUsage();

// Reset module cache so it re-reads env
delete require.cache[require.resolve('./publicGuard')];
const guard2 = require('./publicGuard');

let result = guard2.checkAllowlist([{ provider: 'openai', modelId: 'gpt-4o-mini' }]);
assertEqual(result, null, 'openai:gpt-4o-mini is allowed');

result = guard2.checkAllowlist([{ provider: 'anthropic', modelId: 'claude-3-haiku-20240307' }]);
assertEqual(result, null, 'anthropic:claude-3-haiku-20240307 is allowed');

result = guard2.checkAllowlist([{ provider: 'openai', modelId: 'gpt-5' }]);
assert(result && result.status === 400, 'openai:gpt-5 is rejected with 400');
assert(result && result.error === 'model_not_allowed', 'rejection has model_not_allowed error');
assert(result && result.message.includes('gpt-4o-mini'), 'error message lists allowed models');

result = guard2.checkAllowlist([{ provider: 'mock', modelId: 'mock-echo' }]);
assertEqual(result, null, 'mock:mock-echo always allowed');

result = guard2.checkAllowlist([{ provider: 'mock', modelId: 'mock-lorem' }]);
assertEqual(result, null, 'mock:mock-lorem always allowed');

result = guard2.checkAllowlist([
  { provider: 'openai', modelId: 'gpt-4o-mini' },
  { provider: 'mock', modelId: 'mock-error' },
]);
assertEqual(result, null, 'mixed valid + mock passes');

console.log();

// ===== Test 2b: Allowlist case-insensitivity (regression) =====
console.log('2b. Allowlist case-insensitivity');
setPublicMode(true);
process.env.PUBLIC_MODEL_ALLOWLIST = 'openai:gpt-4o-mini,anthropic:claude-3-haiku-20240307';
cleanGuardUsage();

delete require.cache[require.resolve('./publicGuard')];
const guard2b = require('./publicGuard');

// Allowed model, non-matching case: provider and modelId should be normalized
result = guard2b.checkAllowlist([{ provider: 'OpenAI', modelId: 'GPT-4O-MINI' }]);
assertEqual(result, null, 'OpenAI:GPT-4O-MINI (uppercase) passes — normalized to lowercase');

result = guard2b.checkAllowlist([{ provider: 'OPENAI', modelId: 'gpt-4o-mini' }]);
assertEqual(result, null, 'OPENAI:gpt-4o-mini (uppercase provider) passes');

result = guard2b.checkAllowlist([{ provider: 'openai', modelId: 'GPT-4O-MINI' }]);
assertEqual(result, null, 'openai:GPT-4O-MINI (uppercase modelId) passes');

result = guard2b.checkAllowlist([{ provider: 'ANTHROPIC', modelId: 'CLAUDE-3-HAIKU-20240307' }]);
assertEqual(result, null, 'ANTHROPIC:CLAUDE-3-HAIKU-20240307 (all uppercase) passes');

// Non-allowed model, non-matching case: must be rejected
result = guard2b.checkAllowlist([{ provider: 'OpenAI', modelId: 'GPT-5' }]);
assert(result && result.status === 400, 'OpenAI:GPT-5 (uppercase, not in allowlist) rejected with 400');

result = guard2b.checkAllowlist([{ provider: 'ANTHROPIC', modelId: 'CLAUDE-OPUS-4' }]);
assert(result && result.status === 400, 'ANTHROPIC:CLAUDE-OPUS-4 (uppercase, not in allowlist) rejected');

// Edge: case-variant on a DEFAULT allowlist entry (no env var set)
delete process.env.PUBLIC_MODEL_ALLOWLIST;
delete require.cache[require.resolve('./publicGuard')];
const guard2c = require('./publicGuard');

result = guard2c.checkAllowlist([{ provider: 'MOCK', modelId: 'MOCK-ECHO' }]);
assertEqual(result, null, 'MOCK:MOCK-ECHO (uppercase) always allowed (mock bypass)');

result = guard2c.checkAllowlist([{ provider: 'OPENAI', modelId: 'GPT-5-NANO' }]);
assertEqual(result, null, 'OPENAI:GPT-5-NANO matches default allowlist entry (case-insensitive)');

console.log();

// ===== Test 3: Clamp applied =====
console.log('3. Max-tokens clamp');
process.env.PUBLIC_MAX_TOKENS_PER_TURN = '300';
delete require.cache[require.resolve('./publicGuard')];
const guard3 = require('./publicGuard');

clamped = guard3.clampMaxTokens({ maxTokens: 99999 });
assertEqual(clamped.maxTokens, 300, 'clamps high maxTokens to 300');

clamped = guard3.clampMaxTokens({ maxTokens: 100 });
assertEqual(clamped.maxTokens, 100, 'leaves low maxTokens alone at 100');

clamped = guard3.clampMaxTokens(undefined);
assertEqual(clamped.maxTokens, 300, 'assigns default clamp when options undefined');

clamped = guard3.clampMaxTokens({});
assertEqual(clamped.maxTokens, 300, 'assigns default clamp when no maxTokens in options');

// Test default clamp when env unset
delete process.env.PUBLIC_MAX_TOKENS_PER_TURN;
delete require.cache[require.resolve('./publicGuard')];
const guard3b = require('./publicGuard');

clamped = guard3b.clampMaxTokens({ maxTokens: 99999 });
assertEqual(clamped.maxTokens, 700, 'default clamp is 700 when env unset');

console.log();

// ===== Test 4: Per-minute and per-day limits =====
console.log('4. Rate limits (per-minute + per-day)');
setPublicMode(true);
process.env.PUBLIC_TURNS_PER_MIN = '3';
process.env.PUBLIC_TURNS_PER_DAY = '10';
cleanGuardUsage();

delete require.cache[require.resolve('./publicGuard')];
const guard4 = require('./publicGuard');

// Simulate requests from the same IP (minute limit is 3 model calls)
const req = { headers: {}, ip: '10.0.0.1', connection: { remoteAddress: '10.0.0.1' } };

// rateLimitCheck is a PEEK — it never consumes, so it stays null while under
// limit no matter how many times it's called (regression: it used to consume,
// double-counting every turn against consumeRatePerCall).
assertEqual(guard4.rateLimitCheck(req), null, 'peek 1 does not consume');
assertEqual(guard4.rateLimitCheck(req), null, 'peek 2 does not consume');
assertEqual(guard4.rateLimitCheck(req), null, 'peek 3 does not consume (still empty)');

// The real accounting is per-call: a 2-call turn then a 1-call turn = exactly
// 3 calls, which must FIT a limit of 3 (the reviewer's over-count repro).
assertEqual(guard4.consumeRatePerCall('10.0.0.1', 2), null, '2-call turn consumes and fits');
assertEqual(guard4.consumeRatePerCall('10.0.0.1', 1), null, '1-call turn fits (2+1 == limit 3)');

// Now the window is full: the peek rejects, and a further real call is 429.
let peek = guard4.rateLimitCheck(req);
assert(peek && peek.status === 429, 'peek now reports 429 (window full)');
assertEqual(peek && peek.error, 'rate_limit_minute', 'peek error is rate_limit_minute');
assert(peek && peek.retryAfter > 0, 'retryAfter is positive');
let over = guard4.consumeRatePerCall('10.0.0.1', 1);
assert(over && over.status === 429, '4th model call over limit -> 429');

// Different IP is independent.
assertEqual(guard4.rateLimitCheck({ headers: {}, ip: '10.0.0.2', connection: { remoteAddress: '10.0.0.2' } }), null, 'different IP passes');
assertEqual(guard4.consumeRatePerCall('10.0.0.2', 2), null, 'different IP consumes independently');

// Day limit (with cleaned counters, inject fake data)
cleanGuardUsage();
// Fill the daily counter to the limit
const date = new Date().toISOString().slice(0, 10);
const now = Date.now();
db.prepare(`INSERT INTO guard_usage (utc_date, ip, key_type, turns, tokens, updated_at) VALUES (?, ?, 'ip', 10, 0, ?)`).run(date, '10.0.0.3', now);

delete require.cache[require.resolve('./publicGuard')];
const guard4b = require('./publicGuard');

const req3 = { headers: {}, ip: '10.0.0.3', connection: { remoteAddress: '10.0.0.3' } };
let dayResult = guard4b.rateLimitCheck(req3);
assert(dayResult && dayResult.status === 429, 'day limit hit returns 429');
assertEqual(dayResult && dayResult.error, 'rate_limit_day', 'day limit error is rate_limit_day');

console.log();

// ===== Test 5: Budget kill-switch =====
console.log('5. Budget kill-switch');
setPublicMode(true);
process.env.PUBLIC_DAILY_TOKEN_BUDGET = '500';
cleanGuardUsage();

delete require.cache[require.resolve('./publicGuard')];
const guard5 = require('./publicGuard');

// No usage yet — should pass
assertEqual(guard5.checkDailyBudget(), null, 'budget check passes with no usage');

// Add usage that exceeds budget
const date2 = new Date().toISOString().slice(0, 10);
const now2 = Date.now();
db.prepare(`INSERT INTO guard_usage (utc_date, ip, key_type, turns, tokens, updated_at) VALUES (?, 'GLOBAL', 'daily_budget', 0, 600, ?)`).run(date2, now2);

delete require.cache[require.resolve('./publicGuard')];
const guard5b = require('./publicGuard');

let budgetResult = guard5b.checkDailyBudget();
assert(budgetResult && budgetResult.blocked === true, 'budget kill-switch triggers when exceeded');
assert(budgetResult && budgetResult.message.includes('mock'), 'message mentions mock availability');

// RecordUsage: mock should not be recorded
cleanGuardUsage();
guard5b.recordUsage('mock', 100);
const mockRow = db.prepare("SELECT tokens FROM guard_usage WHERE ip = 'GLOBAL'").get();
assertEqual(mockRow, undefined, 'mock usage is not recorded');

// RecordUsage: real provider should record
guard5b.recordUsage('openai', 250);
const realRow = db.prepare("SELECT tokens FROM guard_usage WHERE ip = 'GLOBAL'").get();
assert(realRow && realRow.tokens >= 250, 'real provider usage is recorded');

console.log();

// ===== Test 6: Wipe deletes old conversations + spares fresh =====
console.log('6. Wipe old conversations');
setPublicMode(true);
process.env.PUBLIC_WIPE_HOURS = '24';
cleanGuardUsage();

const { newId, getDefaultProjectId } = require('./db/index');
const projectId = getDefaultProjectId();

// Create a fresh conversation
const freshId = newId('conv');
const freshTs = Date.now();
db.prepare(`INSERT INTO conversations (id, project_id, title, created_at, updated_at, round_count) VALUES (?, ?, ?, ?, ?, ?)`).run(
  freshId, projectId, 'Fresh', freshTs, freshTs, 0
);

// Create an old conversation (49 hours ago)
const oldId = newId('conv');
const oldTs = Date.now() - 49 * 60 * 60 * 1000;
db.prepare(`INSERT INTO conversations (id, project_id, title, created_at, updated_at, round_count) VALUES (?, ?, ?, ?, ?, ?)`).run(
  oldId, projectId, 'Old', oldTs, oldTs, 0
);

// Add a message to the old conversation
const msgId = newId('msg');
db.prepare(`INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
  msgId, oldId, 1, 'user', 'test', '{}', oldTs
);

delete require.cache[require.resolve('./publicGuard')];
const guard6 = require('./publicGuard');

await guard6.wipeOldConversations();

const freshStillExists = db.prepare('SELECT id FROM conversations WHERE id = ?').get(freshId);
assert(freshStillExists, 'fresh conversation survives wipe');

const oldGone = db.prepare('SELECT id FROM conversations WHERE id = ?').get(oldId);
assert(!oldGone, 'old conversation is deleted by wipe');

const msgGone = db.prepare('SELECT id FROM conversation_messages WHERE id = ?').get(msgId);
assert(!msgGone, 'old conversation messages are deleted by wipe');

console.log();

// ===== Test 7: Uploads blocked in PUBLIC_MODE =====
console.log('7. Uploads blocked');
setPublicMode(true);
delete require.cache[require.resolve('./publicGuard')];
const guard7 = require('./publicGuard');

// Test middleware (no-op for next calls)
let middlewareCalled = false;
const mockRes = {
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(data) {
    this.data = data;
    middlewareCalled = true;
  }
};
const mockNext = () => { middlewareCalled = true; };

guard7.blockUploadsMiddleware({}, mockRes, mockNext);
assert(mockRes.statusCode === 403, 'upload returns 403 in PUBLIC_MODE');
assert(mockRes.data && mockRes.data.error === 'file_operations_disabled', 'error is file_operations_disabled (delegates to blockFileMutationsMiddleware)');

console.log();

// ===== Test 8: PUBLIC_MODE unset → all guards inert (comprehensive) =====
console.log('8. PUBLIC_MODE unset → all guards inert (comprehensive)');
clearPublicEnv();
delete require.cache[require.resolve('./publicGuard')];
const guard8 = require('./publicGuard');

assertEqual(guard8.isPublicMode(), false, 'isPublicMode false');
assertEqual(guard8.checkAllowlist([{ provider: 'openai', modelId: 'gpt-5' }]), null, 'allowlist inert');
assertEqual(guard8.rateLimitCheck({ headers: {}, ip: '1.2.3.4', connection: { remoteAddress: '1.2.3.4' } }), null, 'rate limit inert');
assertEqual(guard8.checkDailyBudget(), null, 'budget inert');

clamped = guard8.clampMaxTokens({ maxTokens: 99999 });
assertEqual(clamped.maxTokens, 99999, 'clamp inert');

// Record usage should not insert anything
cleanGuardUsage();
guard8.recordUsage('openai', 500);
const afterRow = db.prepare("SELECT COUNT(*) as count FROM guard_usage").get();
assertEqual(afterRow.count, 0, 'recordUsage does nothing when inert');

// wipe should not delete anything
const beforeCount = db.prepare('SELECT COUNT(*) as count FROM conversations').get().count;
await guard8.wipeOldConversations();
const afterCount = db.prepare('SELECT COUNT(*) as count FROM conversations').get().count;
assertEqual(afterCount, beforeCount, 'wipe does nothing when inert');

// But the middleware check (we need to test with isPublicMode false)
let mc = false;
const mockRes8 = {
  status(code) { this.statusCode = code; return this; },
  json(data) { mc = true; }
};
let nextCalled8 = false;
guard8.blockUploadsMiddleware({}, mockRes8, () => { nextCalled8 = true; });
assert(nextCalled8, 'blockUploadsMiddleware calls next when inert');
assert(!mc, 'blockUploadsMiddleware does not block when inert');

console.log();

// ===== Test R1: FIX 1 — options side-channel (extraBody bypass) =====
console.log('R1. Options side-channel sanitization');
setPublicMode(true);
process.env.PUBLIC_MAX_TOKENS_PER_TURN = '300';
delete require.cache[require.resolve('./publicGuard')];
const guardR1 = require('./publicGuard');

// extraBody, extraHeaders, tools, thinking, reasoning should be stripped
const dirtyOptions = {
  maxTokens: 99999,
  extraBody: { model: 'gpt-5', max_output_tokens: 999999 },
  extraHeaders: { 'X-Secret': 'leaked' },
  tools: [{ type: 'code_execution_20250825' }],
  thinking: { type: 'enabled', budget_tokens: 50000 },
  reasoning: { effort: 'high' },
  temperature: 0.7,
};
const sanitized = guardR1.sanitizeOptions(dirtyOptions, 'gpt-4o-mini', 300);
assert(!sanitized.extraBody, 'extraBody is stripped');
assert(!sanitized.extraHeaders, 'extraHeaders is stripped');
assert(!sanitized.tools, 'tools is stripped');
assert(!sanitized.thinking, 'thinking is stripped');
assert(!sanitized.reasoning, 'reasoning is stripped');
assertEqual(sanitized.maxTokens, 300, 'maxTokens is re-asserted to clamp value');
assertEqual(sanitized.temperature, 0.7, 'safe field temperature is preserved');

// When PUBLIC_MODE unset, sanitizeOptions should return options unchanged
clearPublicEnv();
delete require.cache[require.resolve('./publicGuard')];
const guardR1b = require('./publicGuard');
const inertResult = guardR1b.sanitizeOptions(dirtyOptions, 'gpt-5', 300);
assert(inertResult === dirtyOptions, 'sanitizeOptions returns options unchanged when inert');

console.log();

// ===== Test R2: FIX 2 — X-Forwarded-For spoofing =====
console.log('R2. X-Forwarded-For spoofing prevention');
setPublicMode(true);
delete require.cache[require.resolve('./publicGuard')];
const guardR2 = require('./publicGuard');

// getClientIp should use req.ip, NOT raw X-Forwarded-For header
const spoofedReq = {
  headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
  ip: '10.0.0.1',
  connection: { remoteAddress: '10.0.0.1' },
};
const clientIp = guardR2.getClientIp(spoofedReq);
assertEqual(clientIp, '10.0.0.1', 'getClientIp uses req.ip, not spoofed X-Forwarded-For');

// Without req.ip, fall back to connection.remoteAddress
const noIpReq = {
  headers: { 'x-forwarded-for': '1.1.1.1' },
  connection: { remoteAddress: '10.0.0.2' },
};
const fallbackIp = guardR2.getClientIp(noIpReq);
assertEqual(fallbackIp, '10.0.0.2', 'getClientIp falls back to connection.remoteAddress');

console.log();

// ===== Test R3: FIX 3 — Config mutation blocked in PUBLIC_MODE =====
console.log('R3. Config mutation blocked in PUBLIC_MODE');
setPublicMode(true);
delete require.cache[require.resolve('./publicGuard')];
const guardR3 = require('./publicGuard');

// blockConfigMutationMiddleware should return 403
let configRes = { status(c) { this.statusCode = c; return this; }, json(d) { this.data = d; } };
guardR3.blockConfigMutationMiddleware({}, configRes, () => { configRes.nextCalled = true; });
assertEqual(configRes.statusCode, 403, 'POST config returns 403 in PUBLIC_MODE');
assertEqual(configRes.data && configRes.data.error, 'config_disabled', 'error is config_disabled');
assert(!configRes.nextCalled, 'next is not called');

// When inert, should call next
clearPublicEnv();
delete require.cache[require.resolve('./publicGuard')];
const guardR3b = require('./publicGuard');
let configRes2 = { status(c) { this.statusCode = c; return this; }, json(d) { this.data = d; } };
let nextCalled = false;
guardR3b.blockConfigMutationMiddleware({}, configRes2, () => { nextCalled = true; });
assert(nextCalled, 'config middleware calls next when inert');

console.log();

// ===== Test R4: FIX 4 — Storage/DoS caps =====
console.log('R4. Storage/DoS caps');
setPublicMode(true);
process.env.PUBLIC_MAX_MESSAGE_CHARS = '100';
process.env.PUBLIC_MAX_TARGETS_PER_TURN = '2';
delete require.cache[require.resolve('./publicGuard')];
const guardR4 = require('./publicGuard');

// Message too long
const longMsgErr = guardR4.validateTurnRequest({
  userMessage: 'x'.repeat(200),
  targetModels: [{ provider: 'mock', modelId: 'mock-echo' }],
});
assert(longMsgErr && longMsgErr.status === 400, 'message too long returns 400');
assert(longMsgErr && longMsgErr.error === 'message_too_long', 'error is message_too_long');

// Too many targets
const tooManyErr = guardR4.validateTurnRequest({
  userMessage: 'hi',
  targetModels: [
    { provider: 'mock', modelId: 'mock-echo' },
    { provider: 'mock', modelId: 'mock-lorem' },
    { provider: 'mock', modelId: 'mock-slow' },
  ],
});
assert(tooManyErr && tooManyErr.status === 400, 'too many targets returns 400');
assert(tooManyErr && tooManyErr.error === 'too_many_targets', 'error is too_many_targets');

// Valid request passes
const validResult = guardR4.validateTurnRequest({
  userMessage: 'hello',
  targetModels: [{ provider: 'mock', modelId: 'mock-echo' }],
});
assertEqual(validResult, null, 'valid request passes validation');

// When inert, validation passes regardless
clearPublicEnv();
delete require.cache[require.resolve('./publicGuard')];
const guardR4b = require('./publicGuard');
const inertValidation = guardR4b.validateTurnRequest({
  userMessage: 'x'.repeat(10000),
  targetModels: Array(20).fill({ provider: 'openai', modelId: 'gpt-5' }),
});
assertEqual(inertValidation, null, 'validation inert when PUBLIC_MODE unset');

console.log();

// ===== Test R5: FIX 5 — Info leak prevention =====
console.log('R5. Info leak prevention');
setPublicMode(true);
delete require.cache[require.resolve('./publicGuard')];
const guardR5 = require('./publicGuard');

// Error with filesystem path should be sanitized
const pathErr = new Error('ENOENT: no such file, open /home/user/secrets/data.db');
const sanitizedPath = guardR5.sanitizeError(pathErr);
assert(!sanitizedPath.message.includes('/home/'), 'filesystem path is redacted');
assert(sanitizedPath.message.includes('[path redacted]'), 'path replaced with redaction marker');

// Error with API key should be sanitized
const keyErr = new Error('OpenAI error 401: Incorrect API key provided: sk-abc123def456ghi789jkl012mno345pqr678stu901');
const sanitizedKey = guardR5.sanitizeError(keyErr);
assert(!sanitizedKey.message.includes('sk-'), 'API key is redacted');
assert(sanitizedKey.message.includes('[key redacted]'), 'key replaced with redaction marker');

// Generic provider error message
const genericMsg = guardR5.genericProviderError('openai');
assert(genericMsg && genericMsg.includes('openai'), 'generic error mentions provider');
assert(genericMsg && !genericMsg.includes('key'), 'generic error does not mention key');
assert(genericMsg && !genericMsg.includes('/'), 'generic error does not contain paths');

// When inert, errors pass through unchanged
clearPublicEnv();
delete require.cache[require.resolve('./publicGuard')];
const guardR5b = require('./publicGuard');
const inertErr = new Error('real error with /path/and sk-key123');
const inertResult2 = guardR5b.sanitizeError(inertErr);
assertEqual(inertResult2.message, inertErr.message, 'error unchanged when inert');

console.log();

// ===== Test R6: FIX 6 — Fan-out amplification =====
console.log('R6. Fan-out amplification prevention');
setPublicMode(true);
process.env.PUBLIC_MAX_TARGETS_PER_TURN = '4';
process.env.PUBLIC_MAX_TOKENS_PER_TURN = '300';
cleanGuardUsage();
delete require.cache[require.resolve('./publicGuard')];
const guardR6 = require('./publicGuard');

// Per-call rate limiting: 3 real targets should consume 3 rate units
const reqR6 = { headers: {}, ip: '10.0.0.99', connection: { remoteAddress: '10.0.0.99' } };
process.env.PUBLIC_TURNS_PER_MIN = '5';

// First call with 3 real targets
const rateErr1 = guardR6.consumeRatePerCall('10.0.0.99', 3);
assertEqual(rateErr1, null, '3 real targets pass with limit 5');

// Second call with 3 real targets should fail (3+3 > 5)
const rateErr2 = guardR6.consumeRatePerCall('10.0.0.99', 3);
assert(rateErr2 && rateErr2.status === 429, '6 total calls exceeds limit of 5');

// Budget reservation
cleanGuardUsage();
process.env.PUBLIC_DAILY_TOKEN_BUDGET = '500';
delete require.cache[require.resolve('./publicGuard')];
const guardR6b = require('./publicGuard');

const res1 = guardR6b.reserveBudget(2, 300); // 2 targets * 300 = 600 > 500
assert(res1 && res1.blocked, 'reservation blocked when estimate exceeds budget');

const res2 = guardR6b.reserveBudget(1, 200); // 1 * 200 = 200 < 500
assert(res2 && res2.reserved === 200, 'reservation succeeds when within budget');

// When inert, per-call counting is a no-op
clearPublicEnv();
delete require.cache[require.resolve('./publicGuard')];
const guardR6c = require('./publicGuard');
const inertRate = guardR6c.consumeRatePerCall('10.0.0.99', 100);
assertEqual(inertRate, null, 'per-call rate inert when PUBLIC_MODE unset');

const inertReserve = guardR6c.reserveBudget(100, 99999);
assertEqual(inertReserve, null, 'budget reservation inert when PUBLIC_MODE unset');

console.log();

// ===== Test R7: FIX 7 — DELETE file route blocked =====
console.log('R7. DELETE file route blocked in PUBLIC_MODE');
setPublicMode(true);
delete require.cache[require.resolve('./publicGuard')];
const guardR7 = require('./publicGuard');

// blockFileMutationsMiddleware should return 403
let delRes = { status(c) { this.statusCode = c; return this; }, json(d) { this.data = d; } };
guardR7.blockFileMutationsMiddleware({}, delRes, () => { delRes.nextCalled = true; });
assertEqual(delRes.statusCode, 403, 'DELETE file returns 403 in PUBLIC_MODE');
assertEqual(delRes.data && delRes.data.error, 'file_operations_disabled', 'error is file_operations_disabled');
assert(!delRes.nextCalled, 'next is not called');

// When inert, should call next
clearPublicEnv();
delete require.cache[require.resolve('./publicGuard')];
const guardR7b = require('./publicGuard');
let delRes2 = { status(c) { this.statusCode = c; return this; }, json(d) { this.data = d; } };
let delNextCalled = false;
guardR7b.blockFileMutationsMiddleware({}, delRes2, () => { delNextCalled = true; });
assert(delNextCalled, 'file mutation middleware calls next when inert');

console.log();

// ===== Test R8: FIX 8 — Budget atomic reservation =====
console.log('R8. Budget atomic reservation');
setPublicMode(true);
process.env.PUBLIC_DAILY_TOKEN_BUDGET = '1000';
cleanGuardUsage();
delete require.cache[require.resolve('./publicGuard')];
const guardR8 = require('./publicGuard');

// Reserve 3 targets * 200 = 600
const res = guardR8.reserveBudget(3, 200);
assert(res && res.reserved === 600, 'reservation of 600 succeeds');

// Check that 600 is actually in the DB
const budgetRow = db.prepare("SELECT tokens FROM guard_usage WHERE ip = 'GLOBAL' AND key_type = 'daily_budget'").get();
assert(budgetRow && budgetRow.tokens === 600, 'reserved tokens are in the database');

// Now try to reserve 3 * 200 = 600 more (total would be 1200 > 1000)
const res8b = guardR8.reserveBudget(3, 200);
assert(res8b && res8b.blocked, 'second reservation blocked (would exceed budget)');

// When inert, reservation is a no-op
clearPublicEnv();
delete require.cache[require.resolve('./publicGuard')];
const guardR8b = require('./publicGuard');
const inertRes = guardR8b.reserveBudget(100, 99999);
assertEqual(inertRes, null, 'reservation inert when PUBLIC_MODE unset');

console.log();

// ===== Test R9: sanitizeOptions when PUBLIC_MODE unset (inert) =====
console.log('R9. sanitizeOptions inert when PUBLIC_MODE unset');
clearPublicEnv();
delete require.cache[require.resolve('./publicGuard')];
const guardR9 = require('./publicGuard');

const opts = { extraBody: { model: 'gpt-5' }, maxTokens: 9999, temperature: 0.5 };
const r9result = guardR9.sanitizeOptions(opts, 'gpt-4o', 300);
assert(r9result === opts, 'sanitizeOptions returns same object when inert');
assert(r9result.extraBody && r9result.extraBody.model === 'gpt-5', 'extraBody preserved when inert');

console.log();

// === Summary ===
console.log(`\n${'-'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failures} failed`);
if (failures > 0) {
  console.error('\nSome tests FAILED!');
  process.exit(1);
} else {
  console.log('\nAll tests passed!');
}
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
