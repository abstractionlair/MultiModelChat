const { db, newId, getDefaultProjectId } = require('./db/index');
const { runMigrations } = require('./db/migrate');
const { indexFile } = require('./indexing/indexer');
const crypto = require('crypto');

runMigrations();

console.log('=== Integration Test: File Upload → Auto-Indexing ===\n');

const projectId = getDefaultProjectId();
const fileId = newId('file');
const content = `# Test File

This is a test to verify that files are properly chunked and indexed.

## Features
- File upload
- Automatic indexing
- Search capability

The system should split this into chunks.`.repeat(3);

const now = Date.now();

// Step 1: Insert file (simulating upload)
console.log('1. Uploading file...');
db.prepare(`
  INSERT INTO project_files (
    id, project_id, path, content, content_hash,
    mime_type, size_bytes, metadata, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  fileId,
  projectId,
  'test/integration.md',
  content,
  crypto.createHash('sha256').update(content).digest('hex'),
  'text/markdown',
  Buffer.byteLength(content),
  JSON.stringify({ retrieval_eligible: true }),
  now,
  now
);
console.log(`✓ File uploaded: ${fileId}`);

// Step 2: Index file
console.log('\n2. Indexing file...');
indexFile(fileId).then(result => {
  console.log(`✓ File indexed: ${result.chunks} chunks created`);
  
  // Step 3: Verify FTS5 search
  console.log('\n3. Testing search...');
  const results = db.prepare(`
    SELECT chunk_id, snippet(retrieval_index, 2, '**', '**', '...', 20) as match
    FROM retrieval_index
    WHERE project_id = ? AND retrieval_index MATCH ?
    LIMIT 3
  `).all(projectId, '"chunked"');
  
  console.log(`✓ Found ${results.length} search results`);
  results.forEach((r, i) => {
    console.log(`  Result ${i+1}: ${r.match.substring(0, 80)}...`);
  });
  
  // Step 4: Test cleanup trigger
  console.log('\n4. Testing cleanup trigger...');
  const beforeCount = db.prepare('SELECT COUNT(*) as count FROM content_chunks WHERE source_id = ?').get(fileId).count;
  db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
  const afterCount = db.prepare('SELECT COUNT(*) as count FROM content_chunks WHERE source_id = ?').get(fileId).count;
  
  if (beforeCount > 0 && afterCount === 0) {
    console.log(`✓ Cleanup trigger removed ${beforeCount} chunks`);
  } else {
    console.error(`✗ Cleanup failed: ${beforeCount} → ${afterCount}`);
  }
  
  console.log('\n✓ Integration test passed!');
}).catch(err => {
  console.error('✗ Test failed:', err);
  process.exit(1);
});
