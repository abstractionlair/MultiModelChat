# Step 09: Chunking & Indexing

**Phase**: 1b - Files & Retrieval
**Complexity**: High (4-8 hours)
**Dependencies**: [07: File Storage Schema](./07-file-storage.md)
**Can Parallelize**: Yes - can do alongside [08: File APIs](./08-file-apis.md)

[← Back to Roadmap](../ROADMAP.md)

## Goal

Automatically chunk uploaded files into 50-line segments and index them in FTS5 for fast full-text search with precise location tracking.

## Success Criteria

- [ ] `content_chunks` table created
- [ ] `retrieval_index` FTS5 virtual table created
- [ ] Cleanup triggers delete chunks when files are deleted
- [ ] Chunking function splits files into 50-line segments
- [ ] Token estimation implemented
- [ ] Automatic indexing on file upload
- [ ] Reindexing utility for existing files

## Schema Design

### Content Chunks Table

```sql
CREATE TABLE content_chunks (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,     -- 'file' | 'conversation_message'
  source_id TEXT NOT NULL,       -- file.id or message.id
  project_id TEXT NOT NULL,
  chunk_index INTEGER,           -- Order within source (0, 1, 2...)
  content TEXT NOT NULL,
  location TEXT,                 -- JSON: see Location Schema below
  summary TEXT,                  -- Optional AI-generated summary
  token_count INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_chunks_source ON content_chunks(source_type, source_id);
CREATE INDEX idx_chunks_project ON content_chunks(project_id);
```

### Location Schema

```javascript
// For file chunks:
{
  "path": "src/utils/auth.js",
  "start_line": 1,
  "end_line": 50,
  "start_char": 0,
  "end_char": 2134
}

// For conversation chunks:
{
  "round_number": 23,
  "speaker": "agent:claude-sonnet-4-5"
}
```

### FTS5 Index

```sql
CREATE VIRTUAL TABLE retrieval_index USING fts5(
  chunk_id UNINDEXED,      -- References content_chunks.id
  project_id UNINDEXED,    -- For filtering by project
  content,                 -- Searchable text
  metadata UNINDEXED,      -- JSON: path, type, etc.
  tokenize = 'porter unicode61'
);
```

**Why FTS5?**
- Porter stemming (finds "running" when searching "run")
- Unicode support (handles non-ASCII characters)
- Fast prefix matching and phrase search
- Built into SQLite

### Cleanup Triggers

```sql
-- Delete chunks when file is deleted
CREATE TRIGGER cleanup_file_chunks
AFTER DELETE ON project_files
BEGIN
  DELETE FROM content_chunks WHERE source_type = 'file' AND source_id = OLD.id;
END;

-- Delete chunks when message is deleted
CREATE TRIGGER cleanup_message_chunks
AFTER DELETE ON conversation_messages
BEGIN
  DELETE FROM content_chunks WHERE source_type = 'conversation_message' AND source_id = OLD.id;
END;

-- Delete from FTS5 when chunk is deleted
CREATE TRIGGER cleanup_fts_chunks
AFTER DELETE ON content_chunks
BEGIN
  DELETE FROM retrieval_index WHERE chunk_id = OLD.id;
END;
```

## Implementation

### 1. Add to Schema

**File**: `server/db/schema.sql`

Add the tables and triggers from the Schema Design section above.

### 2. Create Migration

**File**: `server/db/migrations/004-chunking-indexing.js`

```javascript
const fs = require('fs');
const path = require('path');

function up(db) {
  console.log('Running migration: 004-chunking-indexing');

  // Read schema
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Extract relevant statements
  const statements = schema
    .split(';')
    .filter(s =>
      s.includes('CREATE TABLE content_chunks') ||
      s.includes('CREATE INDEX idx_chunks') ||
      s.includes('CREATE VIRTUAL TABLE retrieval_index') ||
      s.includes('CREATE TRIGGER cleanup')
    );

  // Execute statements
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (trimmed) {
      db.exec(trimmed + ';');
    }
  }

  console.log('✓ content_chunks table created');
  console.log('✓ retrieval_index FTS5 table created');
  console.log('✓ Cleanup triggers created');
}

function down(db) {
  console.log('Rolling back migration: 004-chunking-indexing');
  db.exec('DROP TRIGGER IF EXISTS cleanup_fts_chunks;');
  db.exec('DROP TRIGGER IF EXISTS cleanup_message_chunks;');
  db.exec('DROP TRIGGER IF EXISTS cleanup_file_chunks;');
  db.exec('DROP TABLE IF EXISTS retrieval_index;');
  db.exec('DROP INDEX IF EXISTS idx_chunks_project;');
  db.exec('DROP INDEX IF EXISTS idx_chunks_source;');
  db.exec('DROP TABLE IF EXISTS content_chunks;');
  console.log('✓ Chunking & indexing tables dropped');
}

module.exports = { up, down };
```

### 3. Create Chunking Module

**File**: `server/indexing/chunker.js`

```javascript
/**
 * Chunking utilities for splitting content into retrievable segments
 */

const CHUNK_SIZE_LINES = 50; // Lines per chunk

/**
 * Estimate token count (simple heuristic)
 * More accurate tokenizers can be added later
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // Rule of thumb: ~4 characters per token
  return Math.ceil(text.length / 4);
}

/**
 * Chunk file content into segments
 */
function chunkFileContent(content, filePath, projectId) {
  const lines = content.split('\n');
  const chunks = [];

  for (let i = 0; i < lines.length; i += CHUNK_SIZE_LINES) {
    const chunkLines = lines.slice(i, i + CHUNK_SIZE_LINES);
    const chunkContent = chunkLines.join('\n');

    const startLine = i + 1; // 1-indexed
    const endLine = Math.min(i + CHUNK_SIZE_LINES, lines.length);

    // Calculate character offsets
    const startChar = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0); // +1 for newline
    const endChar = startChar + chunkContent.length;

    chunks.push({
      index: Math.floor(i / CHUNK_SIZE_LINES),
      content: chunkContent,
      location: {
        path: filePath,
        start_line: startLine,
        end_line: endLine,
        start_char: startChar,
        end_char: endChar
      },
      tokenCount: estimateTokens(chunkContent),
      metadata: {
        path: filePath,
        type: 'file',
        lines: endLine - startLine + 1
      }
    });
  }

  return chunks;
}

/**
 * Chunk conversation message
 * Messages are not split - one chunk per message
 */
function chunkMessage(content, conversationId, roundNumber, speaker, projectId) {
  return [{
    index: 0,
    content: content,
    location: {
      round_number: roundNumber,
      speaker: speaker
    },
    tokenCount: estimateTokens(content),
    metadata: {
      type: 'conversation',
      conversation_id: conversationId,
      round: roundNumber,
      speaker: speaker
    }
  }];
}

module.exports = {
  chunkFileContent,
  chunkMessage,
  estimateTokens,
  CHUNK_SIZE_LINES
};
```

### 4. Create Indexing Module

**File**: `server/indexing/indexer.js`

```javascript
const { db, newId } = require('../db/index');
const { chunkFileContent, chunkMessage } = require('./chunker');
const fs = require('fs/promises');

/**
 * Index a file: chunk it and add to search index
 */
async function indexFile(fileId) {
  // Get file
  const file = db.prepare(`
    SELECT id, project_id, path, content, content_location, metadata
    FROM project_files
    WHERE id = ?
  `).get(fileId);

  if (!file) {
    throw new Error(`File not found: ${fileId}`);
  }

  // Check if already indexed
  const existing = db.prepare(`
    SELECT COUNT(*) as count
    FROM content_chunks
    WHERE source_type = 'file' AND source_id = ?
  `).get(fileId);

  if (existing.count > 0) {
    console.log(`File ${fileId} already indexed, skipping`);
    return { skipped: true };
  }

  // Load content
  let content = file.content;
  if (!content && file.content_location) {
    content = await fs.readFile(file.content_location, 'utf8');
  }

  if (!content) {
    console.log(`File ${fileId} has no content, skipping index`);
    return { skipped: true };
  }

  // Parse metadata
  const metadata = file.metadata ? JSON.parse(file.metadata) : {};

  // Check if indexing is disabled for this file
  if (metadata.retrieval_eligible === false) {
    console.log(`File ${fileId} not eligible for retrieval, skipping`);
    return { skipped: true };
  }

  // Chunk content
  const chunks = chunkFileContent(content, file.path, file.project_id);

  // Prepare statements
  const insertChunk = db.prepare(`
    INSERT INTO content_chunks (
      id, source_type, source_id, project_id, chunk_index,
      content, location, token_count, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertIndex = db.prepare(`
    INSERT INTO retrieval_index (chunk_id, project_id, content, metadata)
    VALUES (?, ?, ?, ?)
  `);

  // Insert chunks in transaction
  const now = Date.now();
  const chunkIds = [];

  db.transaction(() => {
    for (const chunk of chunks) {
      const chunkId = newId('chunk');
      chunkIds.push(chunkId);

      // Insert chunk
      insertChunk.run(
        chunkId,
        'file',
        fileId,
        file.project_id,
        chunk.index,
        chunk.content,
        JSON.stringify(chunk.location),
        chunk.tokenCount,
        now
      );

      // Insert into FTS5 index
      insertIndex.run(
        chunkId,
        file.project_id,
        chunk.content,
        JSON.stringify(chunk.metadata)
      );
    }
  })();

  // Update file metadata to track indexing
  const updatedMetadata = { ...metadata, last_indexed_at: now };
  db.prepare(`
    UPDATE project_files
    SET metadata = ?
    WHERE id = ?
  `).run(JSON.stringify(updatedMetadata), fileId);

  console.log(`✓ Indexed file ${fileId}: ${chunks.length} chunks`);

  return {
    fileId,
    chunks: chunks.length,
    chunkIds
  };
}

/**
 * Index a conversation message
 */
function indexMessage(messageId) {
  // Get message
  const message = db.prepare(`
    SELECT id, conversation_id, round_number, speaker, content, metadata
    FROM conversation_messages
    WHERE id = ?
  `).get(messageId);

  if (!message) {
    throw new Error(`Message not found: ${messageId}`);
  }

  // Get project_id from conversation
  const conv = db.prepare(`
    SELECT project_id FROM conversations WHERE id = ?
  `).get(message.conversation_id);

  if (!conv) {
    throw new Error(`Conversation not found: ${message.conversation_id}`);
  }

  // Check if already indexed
  const existing = db.prepare(`
    SELECT COUNT(*) as count
    FROM content_chunks
    WHERE source_type = 'conversation_message' AND source_id = ?
  `).get(messageId);

  if (existing.count > 0) {
    console.log(`Message ${messageId} already indexed, skipping`);
    return { skipped: true };
  }

  // Chunk message (just one chunk)
  const chunks = chunkMessage(
    message.content,
    message.conversation_id,
    message.round_number,
    message.speaker,
    conv.project_id
  );

  // Insert
  const now = Date.now();
  const chunk = chunks[0];
  const chunkId = newId('chunk');

  db.transaction(() => {
    db.prepare(`
      INSERT INTO content_chunks (
        id, source_type, source_id, project_id, chunk_index,
        content, location, token_count, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chunkId,
      'conversation_message',
      messageId,
      conv.project_id,
      chunk.index,
      chunk.content,
      JSON.stringify(chunk.location),
      chunk.tokenCount,
      now
    );

    db.prepare(`
      INSERT INTO retrieval_index (chunk_id, project_id, content, metadata)
      VALUES (?, ?, ?, ?)
    `).run(
      chunkId,
      conv.project_id,
      chunk.content,
      JSON.stringify(chunk.metadata)
    );
  })();

  console.log(`✓ Indexed message ${messageId}`);

  return { messageId, chunkId };
}

/**
 * Reindex all files in a project
 */
async function reindexProject(projectId) {
  const files = db.prepare(`
    SELECT id FROM project_files WHERE project_id = ?
  `).all(projectId);

  console.log(`Reindexing ${files.length} files in project ${projectId}...`);

  const results = [];
  for (const file of files) {
    try {
      const result = await indexFile(file.id);
      results.push(result);
    } catch (err) {
      console.error(`Failed to index file ${file.id}:`, err);
      results.push({ fileId: file.id, error: err.message });
    }
  }

  return results;
}

module.exports = {
  indexFile,
  indexMessage,
  reindexProject
};
```

### 5. Update File Upload to Auto-Index

**File**: `server/server.js`

Add import:
```javascript
const { indexFile } = require('./indexing/indexer');
```

Modify the POST `/api/projects/:projectId/files` route (add at the end, after file insertion):

```javascript
    // ... existing file upload code ...

    res.status(201).json(file);

    // Index file asynchronously (don't block response)
    indexFile(file.id).catch(err => {
      console.error('Background indexing failed:', err);
    });

  } catch (err) {
    // ... existing error handling ...
  }
});
```

### 6. Create Reindexing Utility

**File**: `server/indexing/reindex.js`

```javascript
#!/usr/bin/env node

/**
 * Reindex all files or a specific project
 * Usage:
 *   node server/indexing/reindex.js [projectId]
 */

const { db, getDefaultProjectId } = require('../db/index');
const { runMigrations } = require('../db/migrate');
const { reindexProject } = require('./indexer');

async function main() {
  console.log('Starting reindexing...\n');

  // Run migrations
  runMigrations();

  const args = process.argv.slice(2);
  let projectIds;

  if (args.length > 0) {
    // Reindex specific project
    projectIds = args;
  } else {
    // Reindex all projects
    const projects = db.prepare('SELECT id FROM projects').all();
    projectIds = projects.map(p => p.id);
  }

  console.log(`Reindexing ${projectIds.length} project(s)...\n`);

  for (const projectId of projectIds) {
    console.log(`\n=== Project: ${projectId} ===`);

    // Clear existing chunks for this project
    const deleted = db.prepare(`
      DELETE FROM content_chunks
      WHERE project_id = ? AND source_type = 'file'
    `).run(projectId);

    console.log(`Cleared ${deleted.changes} existing chunks`);

    // Reindex
    const results = await reindexProject(projectId);

    const success = results.filter(r => !r.error && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => r.error).length;

    console.log(`\nResults: ${success} indexed, ${skipped} skipped, ${failed} failed`);
  }

  console.log('\n✓ Reindexing complete!');
}

main().catch(err => {
  console.error('Reindexing failed:', err);
  process.exit(1);
});
```

Make executable:
```bash
chmod +x server/indexing/reindex.js
```

### 7. Test

**File**: `server/indexing/test-chunking.js`

```javascript
const { db, newId, getDefaultProjectId } = require('../db/index');
const { runMigrations } = require('../db/migrate');
const { indexFile } = require('./indexer');
const { chunkFileContent } = require('./chunker');

// Run migrations
runMigrations();

console.log('Testing chunking and indexing...\n');

// Test 1: Chunk a sample file
console.log('1. Testing chunking algorithm...');
const sampleContent = Array(150).fill('console.log("test");').join('\n');
const chunks = chunkFileContent(sampleContent, 'test/sample.js', 'proj_test');

console.log(`✓ Created ${chunks.length} chunks from 150 lines`);
console.log(`  Chunk 0: lines ${chunks[0].location.start_line}-${chunks[0].location.end_line}`);
console.log(`  Chunk 1: lines ${chunks[1].location.start_line}-${chunks[1].location.end_line}`);
console.log(`  Chunk 2: lines ${chunks[2].location.start_line}-${chunks[2].location.end_line}`);

// Test 2: Index a real file
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

`.repeat(5); // Make it long enough for multiple chunks

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

// Index it
const result = await indexFile(fileId);
console.log(`✓ Indexed file: ${result.chunks} chunks created`);

// Test 3: Verify chunks in database
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

// Test 4: Verify FTS5 index
console.log('\n4. Verifying FTS5 index...');
const indexed = db.prepare(`
  SELECT COUNT(*) as count
  FROM retrieval_index
  WHERE project_id = ?
`).get(projectId);

console.log(`✓ FTS5 index has ${indexed.count} entries`);

// Test 5: Test search
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

// Test 6: Test cleanup trigger
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
```

Run:
```bash
node server/indexing/test-chunking.js
```

## Files Changed

- `server/db/schema.sql` - Add content_chunks, retrieval_index, triggers
- `server/db/migrations/004-chunking-indexing.js` - New migration
- `server/indexing/chunker.js` - New chunking module
- `server/indexing/indexer.js` - New indexing module
- `server/indexing/reindex.js` - New reindexing utility
- `server/indexing/test-chunking.js` - New test
- `server/server.js` - Add auto-indexing to file upload

## Testing Checklist

- [ ] Run migrations: `node server/db/migrate.js`
- [ ] Verify tables: `sqlite3 data.db ".tables"` (should show content_chunks, retrieval_index)
- [ ] Run chunking test: `node server/indexing/test-chunking.js`
- [ ] Upload a file and verify indexing: Check logs for "Indexed file"
- [ ] Test reindexing: `node server/indexing/reindex.js`
- [ ] Verify triggers: Delete a file, check chunks are deleted

## Validation

```bash
# Check chunking tables
sqlite3 data.db "SELECT COUNT(*) FROM content_chunks;"
sqlite3 data.db "SELECT COUNT(*) FROM retrieval_index;"

# View sample chunks
sqlite3 data.db "
  SELECT c.chunk_index, c.token_count, json_extract(c.location, '$.path') as path
  FROM content_chunks c
  LIMIT 5;
"

# Test FTS5 search
sqlite3 data.db "
  SELECT chunk_id, snippet(retrieval_index, 2, '>', '<', '...', 20) as match
  FROM retrieval_index
  WHERE retrieval_index MATCH 'function'
  LIMIT 3;
"

# Verify triggers work
sqlite3 data.db "
  SELECT
    (SELECT COUNT(*) FROM project_files) as files,
    (SELECT COUNT(*) FROM content_chunks WHERE source_type='file') as chunks;
"
```

## Notes

### Why 50 Lines Per Chunk?

Balances several factors:
- **Context**: Enough to understand code structure
- **Granularity**: Not too broad, not too narrow
- **Token count**: ~200-500 tokens per chunk (fits in context)
- **Search precision**: Can pinpoint location

Adjust `CHUNK_SIZE_LINES` in `chunker.js` if needed.

### Token Estimation

Simple heuristic: 4 characters ≈ 1 token

For production, use proper tokenizers:
```bash
npm install gpt-tokenizer
npm install @anthropic-ai/tokenizer
```

### FTS5 Tokenizer

`porter unicode61` provides:
- **Porter stemming**: "running" matches "run"
- **Unicode support**: Handles ñ, 中文, emoji
- **Case folding**: "Hello" matches "hello"

### Performance

Indexing is **asynchronous** - doesn't block file uploads. For large projects:
- Use `reindex.js` utility during maintenance windows
- Consider batching insertions
- Monitor FTS5 index size

## Future Enhancements

- AI-generated summaries for chunks
- Semantic search with embeddings
- Incremental reindexing (only changed files)
- Conversation message indexing (currently only files)
- Custom chunk sizes per file type

## Next Step

[10: FTS5 Search Endpoint](./10-search-endpoint.md) - Expose search functionality via API
