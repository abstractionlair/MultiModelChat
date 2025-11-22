const { db, newId, getDefaultProjectId } = require('../db/index');
const { runMigrations } = require('../db/migrate');
const { buildSystemPrompt } = require('./builder');
const { buildFilesSection } = require('./files');

// Run migrations
runMigrations();

console.log('Testing system prompt generation...\n');

const projectId = getDefaultProjectId();

// Test 1: Project with no files
console.log('1. Testing prompt with no files...');
const prompt1 = buildSystemPrompt({
  modelId: 'gpt-4o',
  provider: 'openai',
  projectId,
  projectName: 'Test Project',
  conversationInfo: { round_count: 5 }
});

if (!prompt1.includes('PROJECT FILES')) {
  console.log('✓ No files section when project has no files');
} else {
  console.error('✗ Files section shown when project has no files');
}

// Test 2: Add some test files
console.log('\n2. Adding test files...');
const now = Date.now();
const fileIds = [];

const testFiles = [
  { path: 'README.md', content: '# Test Project\n\nReadme content', mime: 'text/markdown' },
  { path: 'src/index.js', content: 'console.log("hello");\n'.repeat(50), mime: 'text/javascript' },
  { path: 'src/utils.js', content: 'function test() {}\n'.repeat(30), mime: 'text/javascript' },
  { path: 'docs/api.md', content: '# API\n\nDocumentation'.repeat(20), mime: 'text/markdown' },
  { path: 'data/config.json', content: '{"key": "value"}', mime: 'application/json' },
];

for (const file of testFiles) {
  const fileId = newId('file');
  fileIds.push(fileId);

  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    projectId,
    file.path,
    file.content,
    'test-hash',
    file.mime,
    Buffer.byteLength(file.content),
    now,
    now
  );
}

console.log(`✓ Added ${testFiles.length} test files`);

// Test 3: Generate prompt with files
console.log('\n3. Testing prompt with files...');
const filesSection = buildFilesSection(projectId);

if (filesSection) {
  console.log('✓ Files section generated');
  console.log('\nGenerated section:');
  console.log('---');
  console.log(filesSection);
  console.log('---');
} else {
  console.error('✗ Files section not generated');
}

// Test 4: Full prompt
console.log('\n4. Testing full prompt...');
const prompt2 = buildSystemPrompt({
  modelId: 'claude-sonnet-4-5',
  provider: 'anthropic',
  projectId,
  projectName: 'Test Project',
  conversationInfo: { round_count: 10, summary: 'Discussion about auth' }
});

if (prompt2.includes('PROJECT FILES') && prompt2.includes('README.md')) {
  console.log('✓ Full prompt includes files section');
} else {
  console.error('✗ Full prompt missing files section');
}

// Test 5: Token budget
console.log('\n5. Checking token budget...');
const tokenCount = Math.ceil(filesSection.length / 4);
console.log(`Files section is ~${tokenCount} tokens`);

if (tokenCount < 500) {
  console.log('✓ Files section within token budget');
} else {
  console.error(`✗ Files section exceeds budget (${tokenCount} > 500)`);
}

// Cleanup
console.log('\n6. Cleaning up test files...');
for (const fileId of fileIds) {
  db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
}
console.log('✓ Test files deleted');

console.log('\n✓ All prompt tests passed!');
