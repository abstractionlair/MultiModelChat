# Step 07: File Storage Schema

**Phase**: 1b - Files & Retrieval
**Complexity**: Medium (2-4 hours)
**Dependencies**: [06: Update APIs](./06-update-apis.md)
**Can Parallelize**: No (start of Phase 1b)

[← Back to Roadmap](../ROADMAP.md)

## Goal

Create `project_files` table with hybrid storage strategy (small files in SQLite, large files on disk) to enable file uploads and retrieval.

## Success Criteria

- [ ] `project_files` table created with proper schema
- [ ] Indexes on `project_id` and `path` for efficient queries
- [ ] Content hash (SHA256) for change detection
- [ ] Metadata JSON field for extensibility
- [ ] UNIQUE constraint on (project_id, path) to prevent duplicates
- [ ] Migration tested and verified

## Schema Design

```sql
CREATE TABLE project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,              -- Virtual path: "docs/api-reference.md"
  content TEXT,                    -- For small files (< 1MB)
  content_location TEXT,           -- Disk path for large files: "storage/abc123.bin"
  content_hash TEXT,               -- SHA256 for change detection
  mime_type TEXT,
  size_bytes INTEGER,
  metadata TEXT,                   -- JSON: see Metadata Schema below
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, path)         -- Prevent duplicate paths
);

CREATE INDEX idx_project_files_project ON project_files(project_id);
CREATE INDEX idx_project_files_path ON project_files(project_id, path);
```

### Metadata Schema

```javascript
{
  "always_in_context": false,      // Include in every model call
  "retrieval_eligible": true,      // Can be found via search
  "tool_accessible": true,         // Models can read via code execution
  "tags": ["documentation", "api"], // User-defined tags
  "summary": "API endpoint reference", // Optional description
  "language": "markdown",          // Programming language for syntax
  "last_indexed_at": 1703001234567 // Timestamp of last indexing
}
```

## Implementation

### 1. Add to Schema File

**File**: `server/db/schema.sql`

Add the table definition above to the schema file.

### 2. Create Migration

**File**: `server/db/migrations/003-project-files.js`

```javascript
const fs = require('fs');
const path = require('path');

function up(db) {
  console.log('Running migration: 003-project-files');

  // Read schema
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Extract project_files table definition
  const statements = schema
    .split(';')
    .filter(s =>
      s.includes('CREATE TABLE project_files') ||
      s.includes('CREATE INDEX idx_project_files')
    );

  // Execute statements
  for (const stmt of statements) {
    if (stmt.trim()) {
      db.exec(stmt + ';');
    }
  }

  console.log('✓ project_files table created');
  console.log('✓ Indexes created');
}

function down(db) {
  console.log('Rolling back migration: 003-project-files');
  db.exec('DROP INDEX IF EXISTS idx_project_files_path;');
  db.exec('DROP INDEX IF EXISTS idx_project_files_project;');
  db.exec('DROP TABLE IF EXISTS project_files;');
  console.log('✓ project_files table dropped');
}

module.exports = { up, down };
```

### 3. Create Storage Directory

**File**: `server/db/index.js`

Add storage directory setup:

```javascript
const fs = require('fs');

// ... existing code ...

// Storage directory for large files
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '..', '..', 'storage');

// Create storage directory if it doesn't exist
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Storage threshold (1MB)
const STORAGE_THRESHOLD = 1024 * 1024;

module.exports = {
  db,
  newId,
  getDefaultProjectId,
  STORAGE_DIR,
  STORAGE_THRESHOLD
};
```

### 4. Add to .gitignore

**File**: `.gitignore`

```
# Storage files
storage/
```

### 5. Test

**File**: `server/db/test-files.js`

```javascript
const { db, newId, getDefaultProjectId } = require('./index');
const { runMigrations } = require('./migrate');
const crypto = require('crypto');

// Run migrations
runMigrations();

const projectId = getDefaultProjectId();
console.log('Testing with project:', projectId);

// Test: Insert a small text file
const fileId1 = newId('file');
const content1 = 'Hello, world! This is a test file.';
const hash1 = crypto.createHash('sha256').update(content1).digest('hex');
const now = Date.now();

db.prepare(`
  INSERT INTO project_files (
    id, project_id, path, content, content_hash,
    mime_type, size_bytes, metadata, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  fileId1,
  projectId,
  'test/hello.txt',
  content1,
  hash1,
  'text/plain',
  Buffer.byteLength(content1),
  JSON.stringify({ tags: ['test'], retrieval_eligible: true }),
  now,
  now
);

console.log('✓ Inserted small file:', fileId1);

// Test: Insert a file reference (simulating large file)
const fileId2 = newId('file');
const hash2 = crypto.randomBytes(32).toString('hex');

db.prepare(`
  INSERT INTO project_files (
    id, project_id, path, content_location, content_hash,
    mime_type, size_bytes, metadata, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  fileId2,
  projectId,
  'data/large-dataset.csv',
  'storage/abc123def456.bin',
  hash2,
  'text/csv',
  5 * 1024 * 1024, // 5MB
  JSON.stringify({ tags: ['data'], always_in_context: false }),
  now,
  now
);

console.log('✓ Inserted large file reference:', fileId2);

// Test: Query files by project
const files = db.prepare(`
  SELECT id, path, size_bytes, mime_type
  FROM project_files
  WHERE project_id = ?
`).all(projectId);

console.log('\nFiles in project:');
files.forEach(f => {
  console.log(`  - ${f.path} (${f.size_bytes} bytes, ${f.mime_type})`);
});

// Test: UNIQUE constraint
console.log('\nTesting UNIQUE constraint...');
try {
  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId('file'),
    projectId,
    'test/hello.txt', // Duplicate path
    'Different content',
    'abc123',
    'text/plain',
    100,
    now,
    now
  );
  console.error('✗ UNIQUE constraint failed to prevent duplicate!');
} catch (err) {
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    console.log('✓ UNIQUE constraint working correctly');
  } else {
    throw err;
  }
}

// Test: Foreign key cascade delete
console.log('\nTesting CASCADE DELETE...');
const testProjectId = newId('proj');
db.prepare(`
  INSERT INTO projects (id, name, created_at, updated_at)
  VALUES (?, ?, ?, ?)
`).run(testProjectId, 'Test Project', now, now);

const testFileId = newId('file');
db.prepare(`
  INSERT INTO project_files (
    id, project_id, path, content, content_hash,
    mime_type, size_bytes, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  testFileId,
  testProjectId,
  'test/cascade.txt',
  'test',
  'hash',
  'text/plain',
  4,
  now,
  now
);

// Delete project
db.prepare('DELETE FROM projects WHERE id = ?').run(testProjectId);

// Check if file was deleted
const orphan = db.prepare('SELECT id FROM project_files WHERE id = ?').get(testFileId);
if (!orphan) {
  console.log('✓ CASCADE DELETE working correctly');
} else {
  console.error('✗ CASCADE DELETE failed - orphan file exists');
}

console.log('\n✓ All file storage tests passed!');
```

Run:
```bash
node server/db/test-files.js
```

## Files Changed

- `server/db/schema.sql` - Add project_files table
- `server/db/migrations/003-project-files.js` - New migration
- `server/db/index.js` - Add storage directory constants
- `server/db/test-files.js` - New test
- `.gitignore` - Ignore storage directory

## Testing Checklist

- [ ] Run migrations: `node server/db/migrate.js`
- [ ] Verify table created: `sqlite3 data.db ".schema project_files"`
- [ ] Run test: `node server/db/test-files.js`
- [ ] Check indexes: `sqlite3 data.db ".indexes project_files"`
- [ ] Verify storage directory created: `ls -la storage/`

## Validation

```bash
# Check table structure
sqlite3 data.db ".schema project_files"

# Check indexes
sqlite3 data.db ".indexes project_files"
# Should show: idx_project_files_path, idx_project_files_project

# Query test data
sqlite3 data.db "SELECT path, size_bytes FROM project_files;"

# Verify UNIQUE constraint
sqlite3 data.db "SELECT project_id, path, COUNT(*) as count FROM project_files GROUP BY project_id, path HAVING count > 1;"
# Should return no rows

# Check storage directory
ls -la storage/
```

## Rollback Plan

If this step fails:
1. Run down migration: Update `server/db/migrate.js` to support rollback, then run it
2. Delete storage directory: `rm -rf storage/`
3. Remove test file: `rm server/db/test-files.js`

## Notes

### Hybrid Storage Strategy

**Small files (< 1MB)**:
- Stored directly in `content` column
- Fast retrieval, no disk I/O
- Simplifies backups (single DB file)
- Good for: config files, source code, markdown docs

**Large files (> 1MB)**:
- Stored on disk, referenced in `content_location`
- Prevents DB bloat
- Better performance for large files
- Good for: datasets, images, videos, large CSVs

### Why SHA256 Hash?

Content hash enables:
- Change detection (has file been modified?)
- Deduplication (same content = same hash)
- Cache invalidation for indexing
- Integrity verification

### Path Structure

Paths are **virtual** - they don't have to match actual filesystem paths. Examples:
- `docs/api-reference.md`
- `src/utils/auth.js`
- `data/users.csv`

This keeps the storage location flexible and allows for logical organization independent of how files are actually stored.

### Metadata Extensibility

The `metadata` JSON field allows future expansion without schema changes:
- File-specific settings
- User annotations
- Custom tagging
- Indexing hints
- Display preferences

## Next Step

[08: File Upload/Read APIs](./08-file-apis.md) - Implement REST endpoints for file operations
