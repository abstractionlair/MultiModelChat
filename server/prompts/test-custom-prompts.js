/**
 * Test that user-configured system prompts actually reach the built prompt
 * (the MMC-2 fix): common + per-provider + per-agent/per-model semantics,
 * {{modelId}} substitution, and absence when nothing is configured.
 *
 * Usage: node server/prompts/test-custom-prompts.js
 */

process.env.DB_PATH = require('path').join(require('os').tmpdir(), `mmc-test-prompts-${process.pid}.db`);

const { runMigrations } = require('../db/migrate');
runMigrations();

const { buildSystemPrompt } = require('./builder');

let failures = 0;

function check(name, cond) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}`);
  }
}

const base = {
  modelId: 'test-model',
  provider: 'mock',
  projectId: 'nonexistent-project',
  projectName: 'Test Project',
};

// 1. No systemPrompts → no CUSTOM INSTRUCTIONS section
const bare = buildSystemPrompt({ ...base });
check('no prompts → no CUSTOM INSTRUCTIONS section', !bare.includes('CUSTOM INSTRUCTIONS'));

// 2. Common prompt appears, with {{modelId}} substituted
const withCommon = buildSystemPrompt({
  ...base,
  systemPrompts: { common: 'You are {{modelId}}, keep answers short.' },
});
check('common prompt appears', withCommon.includes('keep answers short'));
check('{{modelId}} substituted', withCommon.includes('You are test-model,') && !withCommon.includes('{{modelId}}'));
check('CUSTOM INSTRUCTIONS section present', withCommon.includes('CUSTOM INSTRUCTIONS'));

// 3. Per-provider prompt appears when no agent override
const withProvider = buildSystemPrompt({
  ...base,
  systemPrompts: { common: 'COMMON-PART', perProvider: { mock: 'PROVIDER-PART' } },
});
check('per-provider prompt appears', withProvider.includes('PROVIDER-PART'));
check('common precedes provider', withProvider.indexOf('COMMON-PART') < withProvider.indexOf('PROVIDER-PART'));

// 4. Per-agent override replaces the provider prompt (MVP semantics)
const withAgent = buildSystemPrompt({
  ...base,
  agentId: 'agent-1',
  systemPrompts: {
    perProvider: { mock: 'PROVIDER-PART' },
    perAgent: { 'agent-1': 'AGENT-PART' },
  },
});
check('per-agent prompt appears', withAgent.includes('AGENT-PART'));
check('per-agent replaces provider prompt', !withAgent.includes('PROVIDER-PART'));

// 5. Empty-string per-agent override suppresses the provider prompt
const withEmptyAgent = buildSystemPrompt({
  ...base,
  agentId: 'agent-1',
  systemPrompts: {
    perProvider: { mock: 'PROVIDER-PART' },
    perAgent: { 'agent-1': '' },
  },
});
check('empty per-agent override suppresses provider prompt', !withEmptyAgent.includes('PROVIDER-PART'));

// 6. perModel by index used when no agentId match
const withPerModel = buildSystemPrompt({
  ...base,
  modelIndex: 1,
  systemPrompts: {
    perProvider: { mock: 'PROVIDER-PART' },
    perModel: ['ZERO-PART', 'ONE-PART'],
  },
});
check('perModel[index] appears', withPerModel.includes('ONE-PART'));
check('perModel replaces provider prompt', !withPerModel.includes('PROVIDER-PART'));

// 7. Structural sections still present
check('structural preamble retained', withCommon.includes('multi-model conversation'));
check('custom section comes after provider section', withCommon.indexOf('CUSTOM INSTRUCTIONS') > withCommon.indexOf('PROJECT CONTEXT'));

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll custom-prompt checks passed');
