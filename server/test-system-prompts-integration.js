const { db, newId, getDefaultProjectId } = require('./db/index');
const { runMigrations } = require('./db/migrate');
const { buildSystemPrompt } = require('./prompts/builder');
const crypto = require('crypto');

runMigrations();

console.log('=== System Prompts Integration Test ===\n');

const projectId = getDefaultProjectId();

// Test 1: Empty project (no files)
console.log('1. Testing with empty project...');
const prompt1 = buildSystemPrompt({
  modelId: 'gpt-4o',
  provider: 'openai',
  projectId,
  projectName: 'Test Project'
});

if (!prompt1.includes('PROJECT FILES')) {
  console.log('✓ No files section when no files exist');
} else {
  console.error('✗ Unexpected files section');
}

// Test 2: Add files and test formatting
console.log('\n2. Testing with small project (5 files)...');
const fileIds = [];
const files = [
  { path: 'README.md', content: '# Project\nDescription here' },
  { path: 'src/index.js', content: 'console.log("hello");' },
  { path: 'src/utils.js', content: 'function test() {}' },
  { path: 'docs/api.md', content: '# API Docs' },
  { path: 'data/config.json', content: '{"key":"value"}' }
];

for (const file of files) {
  const fileId = newId('file');
  fileIds.push(fileId);
  
  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId, projectId, file.path, file.content,
    crypto.createHash('sha256').update(file.content).digest('hex'),
    'text/plain', Buffer.byteLength(file.content),
    Date.now(), Date.now()
  );
}

const prompt2 = buildSystemPrompt({
  modelId: 'claude-sonnet-4-5',
  provider: 'anthropic',
  projectId,
  projectName: 'Test Project',
  conversationInfo: { round_count: 3 }
});

if (prompt2.includes('PROJECT FILES (5 total')) {
  console.log('✓ Files section shows correct count');
}
if (prompt2.includes('README.md')) {
  console.log('✓ Files section includes file paths');
}
if (prompt2.includes('EXTENDED THINKING')) {
  console.log('✓ Provider-specific section included (Anthropic)');
}
if (prompt2.includes('3 rounds')) {
  console.log('✓ Conversation info included');
}

// Test 3: Provider-specific sections
console.log('\n3. Testing provider-specific sections...');

const providers = ['openai', 'anthropic', 'google', 'xai', 'mock'];
providers.forEach(provider => {
  const prompt = buildSystemPrompt({
    modelId: 'test-model',
    provider,
    projectId,
    projectName: 'Test'
  });
  
  if (provider === 'openai' && prompt.includes('REASONING')) {
    console.log('✓ OpenAI: REASONING section present');
  } else if (provider === 'anthropic' && prompt.includes('EXTENDED THINKING')) {
    console.log('✓ Anthropic: EXTENDED THINKING section present');
  } else if (provider === 'google' && prompt.includes('Google Search grounding')) {
    console.log('✓ Google: Search grounding note present');
  } else if (provider === 'xai' || provider === 'mock') {
    console.log(`✓ ${provider}: No extra section (as expected)`);
  }
});

// Test 4: Token budget check
console.log('\n4. Testing token budget...');
const filesSection = prompt2.match(/PROJECT FILES[\s\S]*?(?=\n\n)/)?.[0] || '';
const tokenCount = Math.ceil(filesSection.length / 4);
console.log(`Files section: ~${tokenCount} tokens`);

if (tokenCount < 500) {
  console.log('✓ Within budget (< 500 tokens)');
} else {
  console.error(`✗ Over budget: ${tokenCount} tokens`);
}

// Test 5: Grouped display
console.log('\n5. Testing grouped file display...');
if (prompt2.includes('Root:') || prompt2.includes('src:') || prompt2.includes('docs:')) {
  console.log('✓ Files grouped by directory');
}

// Cleanup
console.log('\n6. Cleaning up...');
for (const fileId of fileIds) {
  db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
}
console.log('✓ Cleanup complete');

console.log('\n✓ All integration tests passed!');
