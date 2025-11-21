# Step 08: File Upload/Read APIs

**Phase**: 1b - Files & Retrieval
**Complexity**: Medium (2-4 hours)
**Dependencies**: [07: File Storage Schema](./07-file-storage.md)
**Can Parallelize**: Yes - can do alongside [09: Chunking & Indexing](./09-chunking-indexing.md)

[← Back to Roadmap](../ROADMAP.md)

## Goal

Implement REST API endpoints for uploading, listing, reading, and deleting project files with proper validation and security.

## Success Criteria

- [ ] `POST /api/projects/:id/files` - Upload file
- [ ] `GET /api/projects/:id/files` - List files
- [ ] `GET /api/projects/:id/files/:fileId` - Get file content
- [ ] `DELETE /api/projects/:id/files/:fileId` - Delete file
- [ ] Path validation prevents directory traversal
- [ ] File size limits enforced
- [ ] Content hash computed on upload
- [ ] Hybrid storage working (small in DB, large on disk)

## API Design

### 1. Upload File

**Endpoint**: `POST /api/projects/:projectId/files`

**Request Body**:
```json
{
  "path": "docs/api-reference.md",
  "content": "# API Reference\n...",
  "metadata": {
    "tags": ["documentation"],
    "retrieval_eligible": true
  }
}
```

**Response** (201 Created):
```json
{
  "id": "file_01HQVJX9KF3T0Q2Z8W1MXNBR4C",
  "path": "docs/api-reference.md",
  "size_bytes": 15234,
  "content_hash": "abc123...",
  "created_at": 1703001234567
}
```

**Errors**:
- `400` - Invalid path or content missing
- `404` - Project not found
- `413` - File too large (> 10MB)

### 2. List Files

**Endpoint**: `GET /api/projects/:projectId/files?limit=50&offset=0&filter=*.md`

**Response** (200 OK):
```json
{
  "files": [
    {
      "id": "file_...",
      "path": "docs/api-reference.md",
      "mime_type": "text/markdown",
      "size_bytes": 15234,
      "created_at": 1703001234567,
      "updated_at": 1703001234567
    }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

### 3. Get File Content

**Endpoint**: `GET /api/projects/:projectId/files/:fileId`

**Response** (200 OK):
```json
{
  "id": "file_...",
  "path": "docs/api-reference.md",
  "content": "# API Reference\n...",
  "mime_type": "text/markdown",
  "size_bytes": 15234,
  "content_hash": "abc123...",
  "metadata": {
    "tags": ["documentation"]
  },
  "created_at": 1703001234567,
  "updated_at": 1703001234567
}
```

**Note**: For files stored on disk, content is read from `content_location` transparently.

### 4. Delete File

**Endpoint**: `DELETE /api/projects/:projectId/files/:fileId`

**Response** (200 OK):
```json
{
  "ok": true,
  "deleted": "file_01HQVJX9KF3T0Q2Z8W1MXNBR4C"
}
```

## Implementation

### 1. Add File Utilities Module

**File**: `server/utils/files.js`

```javascript
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');

/**
 * Validate project file path
 * Prevents directory traversal attacks
 */
function validatePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Path is required and must be a string');
  }

  // Reject absolute paths and parent directory references
  if (filePath.startsWith('/') || filePath.includes('..')) {
    throw new Error('Invalid path: must be relative within project');
  }

  // Normalize and double-check
  const normalized = path.normalize(filePath);
  if (normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error('Invalid path after normalization');
  }

  return normalized;
}

/**
 * Compute SHA256 hash of content
 */
function computeHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Detect MIME type from file extension
 */
function detectMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.py': 'text/x-python',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.css': 'text/css',
    '.xml': 'application/xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

module.exports = { validatePath, computeHash, detectMimeType };
```

### 2. Add File Routes

**File**: `server/server.js`

Add imports:
```javascript
const { validatePath, computeHash, detectMimeType } = require('./utils/files');
const { STORAGE_DIR, STORAGE_THRESHOLD } = require('./db/index');
```

Add routes:

```javascript
// ============================================================================
// File APIs
// ============================================================================

/**
 * POST /api/projects/:projectId/files
 * Upload or update a file
 */
app.post('/api/projects/:projectId/files', async (req, res) => {
  const { projectId } = req.params;
  const { path: filePath, content, metadata } = req.body;

  try {
    // Validate inputs
    if (!filePath || !content) {
      return res.status(400).json({ error: 'path and content are required' });
    }

    const validPath = validatePath(filePath);

    // Check project exists
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'project_not_found' });
    }

    // Size check
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    if (sizeBytes > MAX_FILE_SIZE) {
      return res.status(413).json({ error: 'file_too_large', max_bytes: MAX_FILE_SIZE });
    }

    // Compute hash
    const contentHash = computeHash(content);

    // Detect MIME type
    const mimeType = detectMimeType(validPath);

    // Prepare metadata
    const metadataStr = metadata ? JSON.stringify(metadata) : JSON.stringify({
      retrieval_eligible: true,
      tool_accessible: true
    });

    const now = Date.now();

    // Decide storage location
    let fileContent = null;
    let contentLocation = null;

    if (sizeBytes < STORAGE_THRESHOLD) {
      // Store in DB
      fileContent = content;
    } else {
      // Store on disk
      const storageId = crypto.randomBytes(16).toString('hex');
      contentLocation = path.join(STORAGE_DIR, storageId);
      await fs.writeFile(contentLocation, content, 'utf8');
    }

    // Upsert file
    const fileId = newId('file');
    const result = db.prepare(`
      INSERT INTO project_files (
        id, project_id, path, content, content_location, content_hash,
        mime_type, size_bytes, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET
        content = excluded.content,
        content_location = excluded.content_location,
        content_hash = excluded.content_hash,
        size_bytes = excluded.size_bytes,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      fileId,
      projectId,
      validPath,
      fileContent,
      contentLocation,
      contentHash,
      mimeType,
      sizeBytes,
      metadataStr,
      now,
      now
    );

    // Get the file (in case of conflict, use existing ID)
    const file = db.prepare(`
      SELECT id, path, size_bytes, content_hash, created_at
      FROM project_files
      WHERE project_id = ? AND path = ?
    `).get(projectId, validPath);

    res.status(201).json(file);

  } catch (err) {
    console.error('File upload error:', err);
    res.status(500).json({ error: 'upload_failed', message: err.message });
  }
});

/**
 * GET /api/projects/:projectId/files
 * List files in project
 */
app.get('/api/projects/:projectId/files', (req, res) => {
  const { projectId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const filter = req.query.filter; // e.g., "*.md" or "docs/*"

  try {
    // Check project exists
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'project_not_found' });
    }

    // Build query
    let query = `
      SELECT id, path, mime_type, size_bytes, created_at, updated_at
      FROM project_files
      WHERE project_id = ?
    `;
    const params = [projectId];

    // Simple filter support (LIKE pattern)
    if (filter) {
      const pattern = filter.replace('*', '%');
      query += ` AND path LIKE ?`;
      params.push(pattern);
    }

    query += ` ORDER BY path ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const files = db.prepare(query).all(...params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM project_files WHERE project_id = ?';
    const countParams = [projectId];
    if (filter) {
      const pattern = filter.replace('*', '%');
      countQuery += ' AND path LIKE ?';
      countParams.push(pattern);
    }
    const { count } = db.prepare(countQuery).get(...countParams);

    res.json({
      files,
      total: count,
      limit,
      offset
    });

  } catch (err) {
    console.error('File list error:', err);
    res.status(500).json({ error: 'list_failed', message: err.message });
  }
});

/**
 * GET /api/projects/:projectId/files/:fileId
 * Get file content and metadata
 */
app.get('/api/projects/:projectId/files/:fileId', async (req, res) => {
  const { projectId, fileId } = req.params;

  try {
    const file = db.prepare(`
      SELECT *
      FROM project_files
      WHERE id = ? AND project_id = ?
    `).get(fileId, projectId);

    if (!file) {
      return res.status(404).json({ error: 'file_not_found' });
    }

    // Load content
    let content = file.content;
    if (!content && file.content_location) {
      content = await fs.readFile(file.content_location, 'utf8');
    }

    // Parse metadata
    const metadata = file.metadata ? JSON.parse(file.metadata) : {};

    res.json({
      id: file.id,
      path: file.path,
      content,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      content_hash: file.content_hash,
      metadata,
      created_at: file.created_at,
      updated_at: file.updated_at
    });

  } catch (err) {
    console.error('File read error:', err);
    res.status(500).json({ error: 'read_failed', message: err.message });
  }
});

/**
 * DELETE /api/projects/:projectId/files/:fileId
 * Delete a file
 */
app.delete('/api/projects/:projectId/files/:fileId', async (req, res) => {
  const { projectId, fileId } = req.params;

  try {
    // Get file info (to delete disk file if needed)
    const file = db.prepare(`
      SELECT content_location
      FROM project_files
      WHERE id = ? AND project_id = ?
    `).get(fileId, projectId);

    if (!file) {
      return res.status(404).json({ error: 'file_not_found' });
    }

    // Delete from DB (triggers will clean up chunks and FTS index)
    const result = db.prepare(`
      DELETE FROM project_files
      WHERE id = ? AND project_id = ?
    `).run(fileId, projectId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'file_not_found' });
    }

    // Delete disk file if it exists
    if (file.content_location) {
      try {
        await fs.unlink(file.content_location);
      } catch (err) {
        console.error('Failed to delete disk file:', err);
        // Continue anyway - DB record is deleted
      }
    }

    res.json({ ok: true, deleted: fileId });

  } catch (err) {
    console.error('File delete error:', err);
    res.status(500).json({ error: 'delete_failed', message: err.message });
  }
});
```

### 3. Test File APIs

**File**: `server/test-file-apis.sh`

```bash
#!/bin/bash

# Test file upload and retrieval APIs

BASE_URL="http://localhost:3000"

echo "=== Testing File APIs ==="

# Get default project ID
PROJECT_ID=$(curl -s "$BASE_URL/api/conversations" | jq -r '.conversations[0].project_id')
echo "Using project: $PROJECT_ID"

# Test 1: Upload a small file
echo -e "\n1. Uploading small file..."
FILE1=$(curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "test/hello.md",
    "content": "# Hello World\n\nThis is a test file.",
    "metadata": {"tags": ["test", "docs"]}
  }')
echo "$FILE1" | jq .

FILE1_ID=$(echo "$FILE1" | jq -r '.id')

# Test 2: List files
echo -e "\n2. Listing files..."
curl -s "$BASE_URL/api/projects/$PROJECT_ID/files" | jq .

# Test 3: Get file content
echo -e "\n3. Reading file..."
curl -s "$BASE_URL/api/projects/$PROJECT_ID/files/$FILE1_ID" | jq .

# Test 4: Upload with same path (update)
echo -e "\n4. Updating file..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "test/hello.md",
    "content": "# Hello World (Updated)\n\nThis file was updated.",
    "metadata": {"tags": ["test", "docs", "updated"]}
  }' | jq .

# Test 5: Upload a large file
echo -e "\n5. Uploading large file..."
LARGE_CONTENT=$(python3 -c "print('Line ' * 100000)")
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d "{
    \"path\": \"data/large.txt\",
    \"content\": \"$LARGE_CONTENT\"
  }" | jq .

# Test 6: Delete file
echo -e "\n6. Deleting file..."
curl -s -X DELETE "$BASE_URL/api/projects/$PROJECT_ID/files/$FILE1_ID" | jq .

# Test 7: Verify deletion
echo -e "\n7. Verify deletion (should 404)..."
curl -s "$BASE_URL/api/projects/$PROJECT_ID/files/$FILE1_ID" | jq .

echo -e "\n=== Tests complete ==="
```

Make executable and run:
```bash
chmod +x server/test-file-apis.sh
npm start  # In one terminal
./server/test-file-apis.sh  # In another terminal
```

## Files Changed

- `server/utils/files.js` - New utility module
- `server/server.js` - Add file API routes
- `server/test-file-apis.sh` - New test script

## Testing Checklist

- [ ] Start server: `npm start`
- [ ] Run test script: `./server/test-file-apis.sh`
- [ ] Verify small files stored in DB: `sqlite3 data.db "SELECT path, LENGTH(content) FROM project_files WHERE content IS NOT NULL;"`
- [ ] Verify large files stored on disk: `ls -lh storage/`
- [ ] Test path validation: Try uploading `../etc/passwd` (should fail)
- [ ] Test size limit: Upload 11MB file (should fail with 413)

## Manual Testing

```bash
# Upload a file
curl -X POST http://localhost:3000/api/projects/proj_.../files \
  -H 'Content-Type: application/json' \
  -d '{
    "path": "docs/readme.md",
    "content": "# Project README\n\nWelcome to the project."
  }'

# List files
curl http://localhost:3000/api/projects/proj_.../files

# Filter files
curl 'http://localhost:3000/api/projects/proj_.../files?filter=docs/*'

# Get file content
curl http://localhost:3000/api/projects/proj_.../files/file_...

# Delete file
curl -X DELETE http://localhost:3000/api/projects/proj_.../files/file_...
```

## Security Considerations

### Path Validation

The `validatePath` function prevents directory traversal:
- Rejects paths with `..`
- Rejects absolute paths starting with `/`
- Normalizes and validates twice (defense in depth)

Examples of rejected paths:
- `../../etc/passwd`
- `/etc/passwd`
- `docs/../../../secrets`

### File Size Limits

Default limit is 10MB per file. This prevents:
- Memory exhaustion
- Database bloat
- Denial of service attacks

For larger files, consider streaming or chunked uploads.

### Content Type Detection

MIME types are detected from file extensions, not from user input. This prevents:
- Content-type confusion attacks
- XSS via uploaded files

## Notes

### Hybrid Storage Threshold

Files < 1MB stay in SQLite for:
- Faster retrieval (no disk I/O)
- Simpler backups
- Atomic transactions

Files > 1MB go to disk for:
- DB performance
- Reduced memory usage
- Better scalability

### Future Enhancements

Consider adding:
- File streaming for very large files
- Multipart upload support
- Compression for text files
- Automatic cleanup of orphaned disk files
- File versioning

## Next Step

[09: Chunking & Indexing](./09-chunking-indexing.md) - Automatically chunk and index files for search
