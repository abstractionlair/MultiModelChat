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

result = guard2c.checkAllowlist([{ provider: 'OPENAI', modelId: 'GPT-4O-MINI' }]);
assertEqual(result, null, 'OPENAI:GPT-4O-MINI matches default allowlist entry (case-insensitive)');

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

// Simulate requests from the same IP
const req = { headers: {}, ip: '10.0.0.1', connection: { remoteAddress: '10.0.0.1' } };

// First 3 should pass (minute limit is 3)
assertEqual(guard4.rateLimitCheck(req), null, 'request 1 passes');
assertEqual(guard4.rateLimitCheck(req), null, 'request 2 passes');
assertEqual(guard4.rateLimitCheck(req), null, 'request 3 passes');

// 4th should be rate limited
let rateResult = guard4.rateLimitCheck(req);
assert(rateResult && rateResult.status === 429, 'request 4 hits minute rate limit (429)');
assertEqual(rateResult && rateResult.error, 'rate_limit_minute', 'rate limit error is rate_limit_minute');
assert(rateResult && rateResult.retryAfter > 0, 'retryAfter is positive');

// Different IP should pass
const req2 = { headers: {}, ip: '10.0.0.2', connection: { remoteAddress: '10.0.0.2' } };
assertEqual(guard4.rateLimitCheck(req2), null, 'different IP passes rate limit');

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
assert(mockRes.data && mockRes.data.error === 'uploads_disabled', 'error is uploads_disabled');

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
