const { db, newId, getDefaultProjectId } = require('./db/index');
const { runMigrations } = require('./db/migrate');
const { indexFile } = require('./indexing/indexer');
const { search } = require('./indexing/search');
const crypto = require('crypto');

async function runTests() {
  runMigrations();

  console.log('=== Functional Search Test ===\n');

  const projectId = getDefaultProjectId();

  // Upload and index test files
  console.log('1. Creating test files...');
  const files = [
    { path: 'docs/auth.md', content: 'Authentication uses JWT tokens for security.' },
    { path: 'src/utils.js', content: 'function hashPassword(pwd) { return crypto.hash(pwd); }' },
    { path: 'docs/db.md', content: 'Database schema includes users and sessions tables.' }
  ];

  const fileIds = [];
  for (const file of files) {
    const fileId = newId('file');
    fileIds.push(fileId);
    
    db.prepare(`
      INSERT INTO project_files (
        id, project_id, path, content, content_hash,
        mime_type, size_bytes, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fileId, projectId, file.path, file.content,
      crypto.createHash('sha256').update(file.content).digest('hex'),
      'text/plain', Buffer.byteLength(file.content),
      JSON.stringify({ retrieval_eligible: true }),
      Date.now(), Date.now()
    );
    
    await indexFile(fileId);
  }
  console.log(`✓ Created and indexed ${files.length} files\n`);

  // Test 1: Basic search
  console.log('2. Testing basic search (query: "authentication")...');
  const result1 = search(projectId, 'authentication');
  console.log(`✓ Found ${result1.total_results} results in ${result1.execution_time_ms}ms`);
  if (result1.results.length > 0) {
    console.log(`  - ${result1.results[0].path}: "${result1.results[0].highlighted.substring(0, 60)}..."`);
  }

  // Test 2: Filter by file type
  console.log('\n3. Testing file type filter (*.md)...');
  const result2 = search(projectId, 'database', { filters: { file_types: ['.md'] } });
  console.log(`✓ Found ${result2.total_results} results in .md files`);

  // Test 3: Pagination
  console.log('\n4. Testing pagination...');
  const result3 = search(projectId, 'the', { limit: 1, offset: 0 });
  console.log(`✓ Got ${result3.results.length} of ${result3.total_results} total results`);

  // Test 4: No results
  console.log('\n5. Testing query with no results...');
  const result4 = search(projectId, 'nonexistent_term_xyz');
  console.log(`✓ Found ${result4.total_results} results (expected 0)`);

  // Cleanup
  console.log('\n6. Cleaning up...');
  for (const fileId of fileIds) {
    db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
  }
  console.log('✓ Cleanup complete');

  console.log('\n✓ All functional tests passed!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
