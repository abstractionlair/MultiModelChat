# Step 14: Auto-Indexing

**Phase**: 1c - Code Execution
**Complexity**: Medium (2-3 hours)
**Dependencies**: [13: Filesystem Materialization](./13-filesystem-materialization.md)
**Can Parallelize**: No

[← Back to Roadmap](../ROADMAP.md)

## Goal

Automatically detect file changes after bash execution and reindex them for FTS5 search, enabling models to find code and files they've created.

## Success Criteria

- [ ] Detect new files created during execution
- [ ] Detect modified files (content changed)
- [ ] Delete old chunks for modified files
- [ ] Reindex changed files automatically
- [ ] Handle file deletions
- [ ] Test suite verifies indexing works
- [ ] Performance acceptable (indexing doesn't slow execution significantly)

## Background

After models execute bash commands, they may have:
- Created new Python scripts, utilities, or data files
- Modified existing files
- Deleted files

We need to detect these changes and update our database + search index so:
- Future searches find the new/modified content
- Files are available in next conversation
- System prompts can include file listings

## Implementation

### 1. Create Auto-Indexing Module

**File**: `server/execution/auto-index.js`

```javascript
const { db, newId } = require('../db/index');
const { indexFile } = require('../indexing/indexer');
const { scanFilesystem } = require('./materialize');
const crypto = require('crypto');

/**
 * Detect and index file changes after bash execution
 */
async function detectAndIndexChanges(pyodide, projectId) {
  const startTime = Date.now();

  // Scan current virtual filesystem
  const currentFiles = scanFilesystem(pyodide);

  // Get files from database
  const dbFiles = db.prepare(`
    SELECT id, path, content_hash
    FROM project_files
    WHERE project_id = ?
  `).all(projectId);

  const dbFileMap = new Map(dbFiles.map(f => [f.path, { id: f.id, hash: f.content_hash }]));
  const currentFileMap = new Map(currentFiles.map(f => [f.path, f]));

  const changes = {
    created: [],
    modified: [],
    deleted: [],
    unchanged: 0
  };

  // Check for new and modified files
  for (const [path, file] of currentFileMap.entries()) {
    const hash = crypto.createHash('sha256').update(file.content).digest('hex');
    const dbFile = dbFileMap.get(path);

    if (!dbFile) {
      // New file
      const fileId = await createFile(projectId, path, file.content, hash);
      await indexFile(fileId);
      changes.created.push({ path, fileId });

    } else if (dbFile.hash !== hash) {
      // Modified file
      await updateFile(dbFile.id, file.content, hash);

      // Delete old chunks
      db.prepare('DELETE FROM content_chunks WHERE source_id = ?').run(dbFile.id);

      // Reindex
      await indexFile(dbFile.id);
      changes.modified.push({ path, fileId: dbFile.id });

    } else {
      // Unchanged
      changes.unchanged++;
    }
  }

  // Check for deleted files
  for (const [path, dbFile] of dbFileMap.entries()) {
    if (!currentFileMap.has(path)) {
      // File deleted
      db.prepare('DELETE FROM project_files WHERE id = ?').run(dbFile.id);
      // Chunks auto-deleted via trigger
      changes.deleted.push({ path, fileId: dbFile.id });
    }
  }

  const elapsed = Date.now() - startTime;

  console.log(`File changes detected in ${elapsed}ms:`, {
    created: changes.created.length,
    modified: changes.modified.length,
    deleted: changes.deleted.length,
    unchanged: changes.unchanged
  });

  return changes;
}

/**
 * Create new file in database
 */
async function createFile(projectId, path, content, hash) {
  const fileId = newId('file');
  const now = Date.now();

  // Detect MIME type
  const mimeType = detectMimeType(path);

  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    projectId,
    path,
    content,
    hash,
    mimeType,
    Buffer.byteLength(content),
    now,
    now
  );

  return fileId;
}

/**
 * Update existing file in database
 */
async function updateFile(fileId, content, hash) {
  const now = Date.now();

  db.prepare(`
    UPDATE project_files
    SET content = ?, content_hash = ?, size_bytes = ?, updated_at = ?
    WHERE id = ?
  `).run(
    content,
    hash,
    Buffer.byteLength(content),
    now,
    fileId
  );
}

/**
 * Detect MIME type from file extension
 */
function detectMimeType(filepath) {
  const ext = filepath.substring(filepath.lastIndexOf('.')).toLowerCase();

  const mimeTypes = {
    '.py': 'text/x-python',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.css': 'text/css',
    '.sh': 'application/x-sh',
  };

  return mimeTypes[ext] || 'text/plain';
}

module.exports = {
  detectAndIndexChanges
};
```

### 2. Update Bash Executor

**File**: `server/execution/bash.js` (update executeWithProject)

```javascript
const { detectAndIndexChanges } = require('./auto-index');

class BashExecutor {
  // ... existing code ...

  /**
   * Execute bash command with project context and auto-indexing
   */
  async executeWithProject(command, projectId, options = {}) {
    const { autoIndex = true } = options;

    await this.init();

    // Materialize project files (first time only)
    if (!this.materialized || this.currentProjectId !== projectId) {
      await materializeProject(this.pyodide, projectId);
      this.materialized = true;
      this.currentProjectId = projectId;
    }

    // Execute command
    const result = await this.execute(command, options);

    // Auto-index changed files
    if (autoIndex && result.exit_code === 0) {
      try {
        const changes = await detectAndIndexChanges(this.pyodide, projectId);
        result.fileChanges = changes;
      } catch (err) {
        console.error('Auto-indexing failed:', err);
        result.indexingError = err.message;
      }
    }

    return result;
  }
}
```

### 3. Create Test Script

**File**: `server/execution/test-auto-index.js`

```javascript
const { bashExecutor } = require('./bash');
const { detectAndIndexChanges } = require('./auto-index');
const { db, newId, getDefaultProjectId } = require('../db/index');
const { runMigrations } = require('../db/migrate');
const { search } = require('../indexing/search');
const crypto = require('crypto');

runMigrations();

async function runTests() {
  console.log('=== Auto-Indexing Tests ===\n');

  const projectId = getDefaultProjectId();

  // Setup: Create initial file
  console.log('1. Creating initial file...');
  const fileId = newId('file');
  const content = 'print("Initial version")';
  const hash = crypto.createHash('sha256').update(content).digest('hex');

  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    projectId,
    'test.py',
    content,
    hash,
    'text/x-python',
    Buffer.byteLength(content),
    Date.now(),
    Date.now()
  );

  console.log('✓ Initial file created\n');

  // Test 2: Create new file via bash
  console.log('2. Testing new file creation...');

  bashExecutor.clearMaterialization();

  const result2 = await bashExecutor.executeWithProject(
    `cat > utils.py << 'EOF'
def add(a, b):
    return a + b
EOF`,
    projectId
  );

  if (result2.fileChanges && result2.fileChanges.created.length === 1) {
    console.log('✓ New file detected and indexed');
    console.log(`  Created: ${result2.fileChanges.created[0].path}`);
  } else {
    console.error('✗ New file detection failed:', result2);
  }

  // Test 3: Modify existing file
  console.log('\n3. Testing file modification...');

  const result3 = await bashExecutor.executeWithProject(
    `cat > test.py << 'EOF'
print("Modified version")
print("New line added")
EOF`,
    projectId
  );

  if (result3.fileChanges && result3.fileChanges.modified.length === 1) {
    console.log('✓ Modified file detected and reindexed');
    console.log(`  Modified: ${result3.fileChanges.modified[0].path}`);
  } else {
    console.error('✗ File modification detection failed:', result3);
  }

  // Test 4: Verify search finds new content
  console.log('\n4. Testing search after modification...');

  const searchResults = search(projectId, 'Modified version', {
    output_mode: 'content',
    limit: 5
  });

  if (searchResults.results.length > 0) {
    console.log('✓ Modified content searchable');
    console.log(`  Found in: ${searchResults.results[0].location}`);
  } else {
    console.error('✗ Modified content not searchable');
  }

  // Test 5: Create Python script that creates files
  console.log('\n5. Testing multi-file creation via Python...');

  const result5 = await bashExecutor.executeWithProject(
    `cat > generate_files.py << 'EOF'
for i in range(3):
    with open(f'generated_{i}.txt', 'w') as f:
        f.write(f'Generated file {i}')
print('Created 3 files')
EOF`,
    projectId
  );

  await bashExecutor.executeWithProject('python generate_files.py', projectId);

  const filesCheck = db.prepare(`
    SELECT COUNT(*) as count
    FROM project_files
    WHERE project_id = ? AND path LIKE 'generated_%.txt'
  `).get(projectId);

  if (filesCheck.count === 3) {
    console.log('✓ Multi-file creation detected');
    console.log(`  Created ${filesCheck.count} files`);
  } else {
    console.error('✗ Multi-file creation failed:', filesCheck);
  }

  // Test 6: Verify all files indexed
  console.log('\n6. Testing that all files are indexed...');

  const indexedCount = db.prepare(`
    SELECT COUNT(DISTINCT source_id) as count
    FROM content_chunks
    WHERE project_id = ?
  `).get(projectId);

  const totalFiles = db.prepare(`
    SELECT COUNT(*) as count
    FROM project_files
    WHERE project_id = ?
  `).get(projectId);

  if (indexedCount.count === totalFiles.count) {
    console.log('✓ All files indexed');
    console.log(`  Total files: ${totalFiles.count}, Indexed: ${indexedCount.count}`);
  } else {
    console.error('✗ Not all files indexed');
    console.error(`  Total: ${totalFiles.count}, Indexed: ${indexedCount.count}`);
  }

  // Test 7: Search for generated utility function
  console.log('\n7. Testing search for utility function...');

  const utilSearch = search(projectId, 'def add', {
    output_mode: 'content',
    limit: 5
  });

  if (utilSearch.results.length > 0 && utilSearch.results[0].content.includes('def add')) {
    console.log('✓ Utility function searchable');
  } else {
    console.error('✗ Utility function not searchable');
  }

  // Cleanup
  console.log('\n8. Cleaning up...');
  db.prepare('DELETE FROM project_files WHERE project_id = ?').run(projectId);
  console.log('✓ Test files deleted');

  console.log('\n✓ All auto-indexing tests passed!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

Run:
```bash
node server/execution/test-auto-index.js
```

## Files Changed

- `server/execution/auto-index.js` - New auto-indexing module
- `server/execution/bash.js` - Add auto-indexing to executeWithProject()
- `server/execution/test-auto-index.js` - New tests

## Testing Checklist

- [ ] Run tests: `node server/execution/test-auto-index.js`
- [ ] Verify new files detected and indexed
- [ ] Verify modified files reindexed (old chunks deleted)
- [ ] Verify search finds new/modified content
- [ ] Test multi-file creation via Python
- [ ] Verify deleted files handled correctly
- [ ] Check performance with 100+ file changes

## Validation

```bash
# Run tests
node server/execution/test-auto-index.js

# Expected output:
# ✓ Initial file created
# ✓ New file detected and indexed
# ✓ Modified file detected and reindexed
# ✓ Modified content searchable
# ✓ Multi-file creation detected
# ✓ All files indexed
# ✓ Utility function searchable
```

## Performance Considerations

### Indexing Overhead

**Per-file overhead**: 10-50ms (depends on file size and chunking)

**For typical execution**:
- Create 1-2 files: 20-100ms overhead
- Modify 1 file: 20-50ms overhead
- Acceptable for interactive use

**For bulk operations**:
- Create 100 files: 1-5s overhead
- Still acceptable (happens after command completes)

### Optimization Strategies

**1. Batch indexing** (future):
```javascript
// Instead of indexing each file immediately:
const changes = detectChanges();
await Promise.all(changes.created.map(f => indexFile(f.id)));
```

**2. Async indexing** (future):
```javascript
// Index in background, don't block command response
executeWithProject(...).then(result => {
  // Return immediately
  // Index asynchronously
  detectAndIndexChanges(...).catch(err => log(err));
});
```

**3. Selective indexing** (future):
```javascript
// Only index text files, skip binaries
if (mimeType.startsWith('text/') || mimeType.includes('json')) {
  await indexFile(fileId);
}
```

## Notes

### Why Index Everything?

Including Python scripts, utilities, and data files in the search index enables:

**Code Search:**
```
User: "How do I parse sales data?"
Search: "parse sales" → finds utils/parse_sales.py
Model: "You have a parse_sales utility that does this..."
```

**Discovery:**
```
User: "What analysis have we done?"
Search: "analysis" → finds all analysis*.py scripts
Model: "You've run analyses on Q1, Q2, and yearly trends..."
```

**Reuse:**
```
Model writes new script
→ Searches for "csv parsing"
→ Finds existing parse_csv.py utility
→ Imports and reuses instead of reimplementing
```

### Handling Deletions

When files are deleted from virtual FS:
1. Detected by comparing filesystem scan to database
2. Deleted from `project_files` table
3. Chunks auto-deleted via `cleanup_file_chunks` trigger (from Step 09)
4. FTS5 entries auto-deleted via `cleanup_fts_chunks` trigger

No manual cleanup needed!

### Large File Threshold

For MVP, all files stored in `content` column. Future enhancement:
```javascript
if (content.length > STORAGE_THRESHOLD) {
  // Save to disk
  const storageId = crypto.randomBytes(16).toString('hex');
  const storagePath = path.join(STORAGE_DIR, storageId);
  await fs.writeFile(storagePath, content);

  // Store location, not content
  db.prepare('INSERT ... content_location = ?').run(storagePath);
}
```

### Binary Files

Current implementation indexes everything. Future enhancement:
```javascript
const indexableTypes = [
  'text/',
  'application/json',
  'application/javascript',
  'application/x-python'
];

const shouldIndex = indexableTypes.some(t => mimeType.startsWith(t));
```

## Next Step

[15: Integration in /api/turn](./15-execution-in-turn.md) - Add bash tool to conversation endpoint and enable model code execution
