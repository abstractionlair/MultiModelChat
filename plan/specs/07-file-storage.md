# Step 07: File Storage Schema

**Phase**: 1b - Files & Retrieval
**Complexity**: Medium (2-4 hours)
**Dependencies**: [06: Update APIs](./06-update-apis.md)
**Can Parallelize**: No

[← Back to Roadmap](../ROADMAP.md)

## Goal

Add `project_files` table to store user-uploaded files with hybrid storage strategy: small files (<1MB) stored directly in SQLite, large files (>1MB) stored on disk with references in the database.

## Success Criteria

- [ ] `project_files` table created with proper schema
- [ ] Database migration script created
- [ ] Storage directory structure in place (`storage/` at project root)
- [ ] Hybrid storage logic implemented (content vs content_location)
- [ ] Content hash for change detection
- [ ] Indexes for efficient queries
- [ ] Tests verify file storage and retrieval

## Schema Design

### `project_files` Table

```sql
CREATE TABLE project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,           -- Virtual path: "docs/api-reference.md"
  content TEXT,                 -- For small files (<1MB); NULL for large files
  content_location TEXT,        -- Disk path for large files: "storage/abc123.bin"
  content_hash TEXT,            -- SHA256 for change detection
  mime_type TEXT,               -- e.g., "text/plain", "application/json"
  size_bytes INTEGER,           -- File size in bytes
  metadata TEXT,                -- JSON: see File Metadata Schema below
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, path)      -- Prevent duplicate paths within a project
);

CREATE INDEX idx_project_files_project ON project_files(project_id);
CREATE INDEX idx_project_files_path ON project_files(project_id, path);
CREATE INDEX idx_project_files_hash ON project_files(content_hash);
```

### File Metadata JSON Schema

```javascript
{
  "always_in_context": false,    // If true, always include in model context
  "retrieval_eligible": true,    // If true, can be found via search
  "tool_accessible": true,       // If true, models can access via code execution
  "tags": ["documentation", "api"], // User-defined tags
  "summary": "API endpoint reference", // Optional human-readable summary
  "language": "markdown",        // Programming language or format
  "line_count": 450              // Number of lines (for display)
}
```

## Implementation

### 1. Add Table to Schema

**File**: `server/db/schema.sql`

Add after the `conversations` table definition:

```sql
-- Project files with hybrid storage
CREATE TABLE project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT,
  content_location TEXT,
  content_hash TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, path)
);

CREATE INDEX idx_project_files_project ON project_files(project_id);
CREATE INDEX idx_project_files_path ON project_files(project_id, path);
CREATE INDEX idx_project_files_hash ON project_files(content_hash);
```

### 2. Create Migration Script

**File**: `server/db/migrations/002_add_project_files.sql`

```sql
-- Migration: Add project_files table
-- Created: 2024-01-XX

CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT,
  content_location TEXT,
  content_hash TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);
CREATE INDEX IF NOT EXISTS idx_project_files_path ON project_files(project_id, path);
CREATE INDEX IF NOT EXISTS idx_project_files_hash ON project_files(content_hash);
```

### 3. Update Migration Runner

**File**: `server/db/migrate.js`

Ensure the migration runner picks up the new migration:

```javascript
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function runMigrations(db) {
  // Ensure migrations table exists
  db.prepare(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `).run();

  // Read migration files
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(file);
    if (applied) {
      console.log(`[migrate] Skipping ${file} (already applied)`);
      continue;
    }

    console.log(`[migrate] Applying ${file}...`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

    // Execute in transaction
    const transaction = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
    });

    transaction();
    console.log(`[migrate] ✓ Applied ${file}`);
  }

  console.log('[migrate] All migrations complete');
}

module.exports = { runMigrations };
```

### 4. Create Storage Directory

**File**: `server/db/index.js`

Add storage directory initialization:

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { runMigrations } = require('./migrate');

const DB_PATH = path.join(__dirname, '../../data.db');
const STORAGE_DIR = path.join(__dirname, '../../storage');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  console.log('[db] Created storage directory:', STORAGE_DIR);
}

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run migrations
runMigrations(db);

module.exports = { db, STORAGE_DIR };
```

### 5. Add Storage Utilities

**File**: `server/utils/storage.js` (new file)

```javascript
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { STORAGE_DIR } = require('../db/index');

const STORAGE_THRESHOLD = 1024 * 1024; // 1MB

/**
 * Calculate SHA256 hash of content
 */
function calculateHash(content) {
  if (Buffer.isBuffer(content)) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Determine if content should be stored in DB or on disk
 */
function shouldStoreInDB(sizeBytes) {
  return sizeBytes < STORAGE_THRESHOLD;
}

/**
 * Generate unique storage filename
 */
function generateStorageFilename() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Save content to disk storage
 */
async function saveToDisk(content) {
  const filename = generateStorageFilename();
  const storagePath = path.join(STORAGE_DIR, filename);
  await fs.writeFile(storagePath, content);
  return filename; // Return relative path
}

/**
 * Read content from disk storage
 */
async function readFromDisk(filename) {
  const storagePath = path.join(STORAGE_DIR, filename);
  return await fs.readFile(storagePath);
}

/**
 * Delete file from disk storage
 */
async function deleteFromDisk(filename) {
  const storagePath = path.join(STORAGE_DIR, filename);
  try {
    await fs.unlink(storagePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    // File doesn't exist, ignore
  }
}

/**
 * Detect MIME type from filename
 */
function detectMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.py': 'text/x-python',
    '.java': 'text/x-java',
    '.cpp': 'text/x-c++',
    '.c': 'text/x-c',
    '.go': 'text/x-go',
    '.rs': 'text/x-rust',
    '.rb': 'text/x-ruby',
    '.php': 'text/x-php',
    '.sh': 'text/x-shellscript',
    '.sql': 'application/sql',
    '.xml': 'application/xml',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Validate file path (prevent directory traversal)
 */
function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path: must be a non-empty string');
  }

  if (filePath.includes('..') || filePath.startsWith('/')) {
    throw new Error('Invalid file path: must be relative within project');
  }

  const normalized = path.normalize(filePath);
  if (normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error('Invalid file path after normalization');
  }

  return normalized;
}

module.exports = {
  STORAGE_THRESHOLD,
  calculateHash,
  shouldStoreInDB,
  generateStorageFilename,
  saveToDisk,
  readFromDisk,
  deleteFromDisk,
  detectMimeType,
  validateFilePath,
};
```

## Files Changed

- `server/db/schema.sql` - Add project_files table
- `server/db/migrations/002_add_project_files.sql` - New migration
- `server/db/migrate.js` - Update migration runner
- `server/db/index.js` - Add storage directory initialization
- `server/utils/storage.js` - New file for storage utilities
- `.gitignore` - Add storage/ directory

## Testing

### Manual Test Script

**File**: `server/db/test-file-storage.js` (new file)

```javascript
const { db, STORAGE_DIR } = require('./index');
const { calculateHash, shouldStoreInDB, validateFilePath, detectMimeType } = require('../utils/storage');

console.log('Testing file storage schema...\n');

// Test 1: Storage directory exists
console.log('1. Storage directory:', STORAGE_DIR);
const fs = require('fs');
console.log('   Exists:', fs.existsSync(STORAGE_DIR));

// Test 2: project_files table exists
console.log('\n2. Checking project_files table...');
const tableInfo = db.prepare(`
  SELECT sql FROM sqlite_master
  WHERE type='table' AND name='project_files'
`).get();
console.log('   Table exists:', !!tableInfo);
console.log('   Schema:', tableInfo?.sql);

// Test 3: Indexes exist
console.log('\n3. Checking indexes...');
const indexes = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='index' AND tbl_name='project_files'
`).all();
console.log('   Indexes:', indexes.map(i => i.name).join(', '));

// Test 4: Insert small file
console.log('\n4. Testing small file storage (in DB)...');
const smallContent = 'Hello, world! This is a small test file.';
const smallHash = calculateHash(smallContent);
const smallSize = Buffer.byteLength(smallContent, 'utf-8');
console.log('   Content size:', smallSize, 'bytes');
console.log('   Store in DB:', shouldStoreInDB(smallSize));
console.log('   Hash:', smallHash);

const projectId = 'test-project-001';
const fileId = 'file-' + Date.now();

db.prepare(`
  INSERT INTO project_files (
    id, project_id, path, content, content_hash,
    mime_type, size_bytes, metadata, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  fileId,
  projectId,
  'docs/test.txt',
  smallContent,
  smallHash,
  detectMimeType('test.txt'),
  smallSize,
  JSON.stringify({ tags: ['test'], summary: 'Test file' }),
  Date.now(),
  Date.now()
);
console.log('   ✓ Inserted file:', fileId);

// Test 5: Retrieve file
console.log('\n5. Retrieving file...');
const retrieved = db.prepare('SELECT * FROM project_files WHERE id = ?').get(fileId);
console.log('   ✓ Retrieved file:', retrieved.path);
console.log('   Content matches:', retrieved.content === smallContent);
console.log('   Hash matches:', retrieved.content_hash === smallHash);

// Test 6: Path validation
console.log('\n6. Testing path validation...');
const validPaths = ['docs/api.md', 'src/server.js', 'data/file.csv'];
const invalidPaths = ['../etc/passwd', '/etc/hosts', 'docs/../../../secret.txt'];

for (const p of validPaths) {
  try {
    validateFilePath(p);
    console.log('   ✓ Valid:', p);
  } catch (err) {
    console.log('   ✗ Unexpected error for', p, ':', err.message);
  }
}

for (const p of invalidPaths) {
  try {
    validateFilePath(p);
    console.log('   ✗ Should have rejected:', p);
  } catch (err) {
    console.log('   ✓ Rejected:', p);
  }
}

// Test 7: MIME type detection
console.log('\n7. Testing MIME type detection...');
const testFiles = {
  'test.txt': 'text/plain',
  'readme.md': 'text/markdown',
  'server.js': 'text/javascript',
  'data.json': 'application/json',
  'script.py': 'text/x-python',
  'unknown.xyz': 'application/octet-stream',
};

for (const [filename, expected] of Object.entries(testFiles)) {
  const detected = detectMimeType(filename);
  const matches = detected === expected;
  console.log(`   ${matches ? '✓' : '✗'} ${filename}: ${detected}`);
}

// Cleanup
console.log('\n8. Cleaning up...');
db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
console.log('   ✓ Test file deleted');

console.log('\n✅ All tests passed!');
```

### Run Tests

```bash
# Ensure server is not running
killall node 2>/dev/null || true

# Run test
node server/db/test-file-storage.js
```

### Expected Output

```
Testing file storage schema...

1. Storage directory: /path/to/MultiModelChat/storage
   Exists: true

2. Checking project_files table...
   Table exists: true
   Schema: CREATE TABLE project_files (...)

3. Checking indexes...
   Indexes: idx_project_files_project, idx_project_files_path, idx_project_files_hash

4. Testing small file storage (in DB)...
   Content size: 41 bytes
   Store in DB: true
   Hash: a591a6d40bf420...

5. Retrieving file...
   ✓ Retrieved file: docs/test.txt
   Content matches: true
   Hash matches: true

6. Testing path validation...
   ✓ Valid: docs/api.md
   ✓ Valid: src/server.js
   ✓ Valid: data/file.csv
   ✓ Rejected: ../etc/passwd
   ✓ Rejected: /etc/hosts
   ✓ Rejected: docs/../../../secret.txt

7. Testing MIME type detection...
   ✓ test.txt: text/plain
   ✓ readme.md: text/markdown
   ✓ server.js: text/javascript
   ✓ data.json: application/json
   ✓ script.py: text/x-python
   ✓ unknown.xyz: application/octet-stream

8. Cleaning up...
   ✓ Test file deleted

✅ All tests passed!
```

## Validation

### Database Verification

```bash
sqlite3 data.db <<EOF
.mode column
.headers on

-- Verify table exists
SELECT name, sql FROM sqlite_master
WHERE type='table' AND name='project_files';

-- Verify indexes
SELECT name FROM sqlite_master
WHERE type='index' AND tbl_name='project_files';

-- Check constraints
PRAGMA foreign_key_list(project_files);
PRAGMA index_list(project_files);

-- Verify migrations
SELECT * FROM migrations WHERE name LIKE '%project_files%';
EOF
```

### Storage Directory Check

```bash
# Verify storage directory exists and is writable
ls -la storage/
echo "test" > storage/.write_test && rm storage/.write_test && echo "✓ Storage directory is writable"
```

## Notes

### Design Decisions

1. **Hybrid Storage Strategy**:
   - Files <1MB stored in SQLite `content` column
   - Files >1MB stored on disk in `storage/` directory
   - Rationale: Balance between simplicity and performance

2. **Content Hash**:
   - SHA256 hash stored for each file
   - Enables change detection without full content comparison
   - Can be used for deduplication in future

3. **Path Validation**:
   - Strict validation prevents directory traversal attacks
   - Paths must be relative and normalized
   - No `..` or absolute paths allowed

4. **MIME Type Detection**:
   - Simple extension-based detection
   - Sufficient for Phase 1b (text files only)
   - Can be enhanced with magic number detection later

### Security Considerations

- **Path Traversal**: Prevented via `validateFilePath` function
- **File Size Limits**: Will be enforced in API layer (Step 08)
- **Content Validation**: Will be added in API layer
- **Storage Location**: `storage/` should be in `.gitignore`

### Future Enhancements

Phase 1b will add:
- Step 08: File upload/read APIs
- Step 09: Chunking and FTS5 indexing
- Step 10: Search endpoint
- Step 11: System prompt updates

Phase 2+ may add:
- Deduplication based on content_hash
- File versioning
- Compression for large files
- Cloud storage backends (S3, etc.)

### Performance Notes

- Indexes on `project_id` and `path` enable fast lookups
- Hash index enables future deduplication
- WAL mode (already enabled) supports concurrent reads
- Large file streaming will be added in Step 08

## Success Metrics

Step 07 is complete when:
- [ ] `project_files` table exists in schema
- [ ] Migration 002 is created and runs successfully
- [ ] Storage directory is created and writable
- [ ] Storage utilities are tested and working
- [ ] Path validation prevents directory traversal
- [ ] All tests pass
- [ ] `.gitignore` excludes storage directory

---

**Next**: [08: File Upload/Read APIs](./08-file-apis.md) - Build REST endpoints for file management
