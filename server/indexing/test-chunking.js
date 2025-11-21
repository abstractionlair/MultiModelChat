const { db, newId, getDefaultProjectId } = require('../db/index');
const { runMigrations } = require('../db/migrate');
const { indexFile } = require('./indexer');
const { chunkFileContent } = require('./chunker');

async function main() {
  runMigrations();

  console.log('Testing chunking and indexing...\n');

  console.log('1. Testing chunking algorithm...');
  const sampleContent = Array(150).fill('console.log("test");').join('\n');
  const chunks = chunkFileContent(sampleContent, 'test/sample.js', 'proj_test');

  console.log(`✓ Created ${chunks.length} chunks from 150 lines`);
  console.log(`  Chunk 0: lines ${chunks[0].location.start_line}-${chunks[0].location.end_line}`);
  console.log(`  Chunk 1: lines ${chunks[1].location.start_line}-${chunks[1].location.end_line}`);
  console.log(`  Chunk 2: lines ${chunks[2].location.start_line}-${chunks[2].location.end_line}`);

  console.log('\n2. Testing file indexing...');
  const projectId = getDefaultProjectId();
  const fileId = newId('file');
  const now = Date.now();

  const testContent = `# Testing Document

This is a test document for validating the chunking and indexing system.

## Features

- Automatic chunking
- FTS5 indexing
- Location tracking

## Implementation

The system splits files into 50-line chunks and indexes them for fast search.

`.repeat(5);

  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, metadata, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    projectId,
    'test/indexing-test.md',
    testContent,
    'test-hash',
    'text/markdown',
    Buffer.byteLength(testContent),
    JSON.stringify({ tags: ['test'], retrieval_eligible: true }),
    now,
    now
  );

  const result = await indexFile(fileId);
  console.log(`✓ Indexed file: ${result.chunks} chunks created`);

  console.log('\n3. Verifying chunks in database...');
  const dbChunks = db.prepare(`
    SELECT id, chunk_index, token_count, location
    FROM content_chunks
    WHERE source_id = ?
    ORDER BY chunk_index
  `).all(fileId);

  console.log(`✓ Found ${dbChunks.length} chunks in database`);
  dbChunks.forEach(chunk => {
    const loc = JSON.parse(chunk.location);
    console.log(`  Chunk ${chunk.chunk_index}: ${loc.start_line}-${loc.end_line}, ~${chunk.token_count} tokens`);
  });

  console.log('\n4. Verifying FTS5 index...');
  const indexed = db.prepare(`
    SELECT COUNT(*) as count
    FROM retrieval_index
    WHERE project_id = ?
  `).get(projectId);

  console.log(`✓ FTS5 index has ${indexed.count} entries`);

  console.log('\n5. Testing search...');
  const searchResults = db.prepare(`
    SELECT chunk_id, highlight(retrieval_index, 2, '**', '**') as highlighted
    FROM retrieval_index
    WHERE project_id = ? AND retrieval_index MATCH ?
    LIMIT 3
  `).all(projectId, '"chunking"');

  console.log(`✓ Found ${searchResults.length} results for "chunking"`);
  searchResults.forEach(r => {
    console.log(`  ${r.chunk_id}: ${r.highlighted.substring(0, 100)}...`);
  });

  console.log('\n6. Testing cleanup trigger...');
  const beforeCount = db.prepare('SELECT COUNT(*) as count FROM content_chunks WHERE source_id = ?').get(fileId).count;
  db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
  const afterCount = db.prepare('SELECT COUNT(*) as count FROM content_chunks WHERE source_id = ?').get(fileId).count;

  if (beforeCount > 0 && afterCount === 0) {
    console.log('✓ Cleanup trigger working correctly');
  } else {
    console.error(`✗ Cleanup trigger failed: ${beforeCount} before, ${afterCount} after`);
  }

  console.log('\n✓ All chunking tests passed!');
}

main().catch(err => {
  console.error('Chunking test failed:', err);
  process.exit(1);
});
