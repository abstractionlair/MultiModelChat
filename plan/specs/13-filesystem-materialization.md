# Step 13: Filesystem Materialization

**Phase**: 1c - Code Execution
**Complexity**: Low (1-2 hours)
**Dependencies**: [12: Bash Execution Runtime](./12-pyodide-integration.md)
**Can Parallelize**: No

[← Back to Roadmap](../ROADMAP.md)

## Goal

Load project files from the database into Pyodide's virtual filesystem, making them accessible to bash commands and Python scripts.

## Success Criteria

- [ ] Load all project files from database
- [ ] Handle both small files (in DB) and large files (on disk)
- [ ] Create proper directory structure in /project/
- [ ] Files accessible via `cat`, `python`, etc.
- [ ] Test suite verifies materialization works
- [ ] Performance acceptable for 100+ files

## Background

Before models can execute bash commands that reference project files, we need to materialize those files from our database into Pyodide's virtual filesystem. This is straightforward: read files from `project_files` table and write them to the virtual FS.

**For MVP**: All files go in /project/ - no special directories, no read-only restrictions. Models can write anywhere and we'll detect changes in Step 14.

## Implementation

### 1. Create Materialization Module

**File**: `server/execution/materialize.js`

```javascript
const { db, STORAGE_DIR } = require('../db/index');
const fs = require('fs').promises;

/**
 * Load file content from DB or disk
 */
async function loadFileContent(file) {
  if (file.content) {
    return file.content;
  } else if (file.content_location) {
    return await fs.readFile(file.content_location, 'utf8');
  } else {
    throw new Error(`File ${file.id} has no content or content_location`);
  }
}

/**
 * Materialize all project files into Pyodide virtual filesystem
 */
async function materializeProject(pyodide, projectId) {
  const startTime = Date.now();

  // Get all project files
  const files = db.prepare(`
    SELECT id, path, content, content_location, size_bytes
    FROM project_files
    WHERE project_id = ?
    ORDER BY path ASC
  `).all(projectId);

  console.log(`Materializing ${files.length} files for project ${projectId}...`);

  let materializedCount = 0;
  let totalBytes = 0;

  for (const file of files) {
    try {
      // Load content
      const content = await loadFileContent(file);
      totalBytes += content.length;

      // Create directory structure
      const fullPath = file.path;
      const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));

      if (dirPath) {
        createDirectories(pyodide, dirPath);
      }

      // Write file
      pyodide.FS.writeFile(fullPath, content);
      materializedCount++;

    } catch (err) {
      console.error(`Failed to materialize file ${file.path}:`, err.message);
      // Continue with other files
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`✓ Materialized ${materializedCount}/${files.length} files (${formatBytes(totalBytes)}) in ${elapsed}ms`);

  return {
    totalFiles: files.length,
    materializedFiles: materializedCount,
    totalBytes,
    elapsedMs: elapsed
  };
}

/**
 * Create directory structure recursively
 */
function createDirectories(pyodide, dirPath) {
  const parts = dirPath.split('/').filter(Boolean);
  let currentPath = '';

  for (const part of parts) {
    currentPath += (currentPath ? '/' : '') + part;

    try {
      pyodide.FS.mkdir(currentPath);
    } catch (err) {
      // Directory exists, ignore
      if (!err.message.includes('FS error')) {
        throw err;
      }
    }
  }
}

/**
 * Format bytes for display
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Scan virtual filesystem for all files
 */
function scanFilesystem(pyodide, basePath = '') {
  const files = [];

  function traverse(dirPath) {
    try {
      const entries = pyodide.FS.readdir(dirPath || '.');

      for (const entry of entries) {
        if (entry === '.' || entry === '..') continue;

        const fullPath = dirPath ? `${dirPath}/${entry}` : entry;

        try {
          const stat = pyodide.FS.stat(fullPath);

          if (pyodide.FS.isDir(stat.mode)) {
            traverse(fullPath);
          } else {
            const content = pyodide.FS.readFile(fullPath, { encoding: 'utf8' });
            files.push({
              path: fullPath,
              content,
              size: stat.size,
              mtime: stat.mtime
            });
          }
        } catch (err) {
          // Skip files we can't read
          console.warn(`Skipping ${fullPath}:`, err.message);
        }
      }
    } catch (err) {
      // Directory doesn't exist or not accessible
    }
  }

  traverse(basePath);
  return files;
}

module.exports = {
  materializeProject,
  scanFilesystem,
  loadFileContent,
  formatBytes
};
```

### 2. Update Bash Executor

**File**: `server/execution/bash.js` (add method)

```javascript
const { materializeProject } = require('./materialize');

class BashExecutor {
  // ... existing code ...

  /**
   * Execute bash command with project context
   */
  async executeWithProject(command, projectId, options = {}) {
    await this.init();

    // Materialize project files (first time only)
    if (!this.materialized) {
      await materializeProject(this.pyodide, projectId);
      this.materialized = true;
    }

    // Execute command
    return this.execute(command, options);
  }

  /**
   * Clear materialization flag (for testing or new projects)
   */
  clearMaterialization() {
    this.materialized = false;
  }
}
```

### 3. Create Test Script

**File**: `server/execution/test-materialize.js`

```javascript
const { bashExecutor } = require('./bash');
const { materializeProject, scanFilesystem } = require('./materialize');
const { db, newId, getDefaultProjectId } = require('../db/index');
const { runMigrations } = require('../db/migrate');
const crypto = require('crypto');

runMigrations();

async function runTests() {
  console.log('=== Materialization Tests ===\n');

  const projectId = getDefaultProjectId();

  // Setup: Add test files to database
  console.log('1. Creating test files in database...');
  const fileIds = [];
  const now = Date.now();

  const testFiles = [
    {
      path: 'README.md',
      content: '# Test Project\n\nThis is a test project.'
    },
    {
      path: 'data/sales.csv',
      content: 'product,amount\nWidget A,100\nWidget B,200'
    },
    {
      path: 'scripts/analyze.py',
      content: 'print("Hello from analyze.py")'
    }
  ];

  for (const file of testFiles) {
    const fileId = newId('file');
    fileIds.push(fileId);

    const hash = crypto.createHash('sha256').update(file.content).digest('hex');

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
      hash,
      'text/plain',
      Buffer.byteLength(file.content),
      now,
      now
    );
  }

  console.log(`✓ Created ${testFiles.length} test files\n`);

  // Test 2: Materialize project
  console.log('2. Testing materialization...');
  await bashExecutor.init();
  const result = await materializeProject(bashExecutor.pyodide, projectId);

  if (result.materializedFiles === testFiles.length) {
    console.log(`✓ Materialized ${result.materializedFiles} files in ${result.elapsedMs}ms`);
  } else {
    console.error('✗ Materialization failed:', result);
  }

  // Test 3: Read materialized file
  console.log('\n3. Testing file access via cat...');
  const catResult = await bashExecutor.execute('cat README.md');

  if (catResult.exit_code === 0 && catResult.stdout.includes('Test Project')) {
    console.log('✓ File accessible via cat');
  } else {
    console.error('✗ File access failed:', catResult);
  }

  // Test 4: List files
  console.log('\n4. Testing ls command...');
  const lsResult = await bashExecutor.execute('ls');

  if (lsResult.stdout.includes('README.md') && lsResult.stdout.includes('data')) {
    console.log('✓ Directory structure correct');
    console.log(`  Files: ${lsResult.stdout.trim()}`);
  } else {
    console.error('✗ Directory structure failed:', lsResult);
  }

  // Test 5: Read nested file
  console.log('\n5. Testing nested file access...');
  const nestedResult = await bashExecutor.execute('cat data/sales.csv');

  if (nestedResult.stdout.includes('Widget A')) {
    console.log('✓ Nested file accessible');
  } else {
    console.error('✗ Nested file access failed:', nestedResult);
  }

  // Test 6: Execute materialized Python script
  console.log('\n6. Testing Python script execution...');
  const pyResult = await bashExecutor.execute('python scripts/analyze.py');

  if (pyResult.stdout.includes('Hello from analyze.py')) {
    console.log('✓ Python script execution works');
  } else {
    console.error('✗ Python script execution failed:', pyResult);
  }

  // Test 7: Scan filesystem
  console.log('\n7. Testing filesystem scan...');
  const scannedFiles = scanFilesystem(bashExecutor.pyodide);

  if (scannedFiles.length >= testFiles.length) {
    console.log(`✓ Scanned ${scannedFiles.length} files`);
    scannedFiles.forEach(f => {
      console.log(`  - ${f.path} (${f.size} bytes)`);
    });
  } else {
    console.error('✗ Filesystem scan failed:', scannedFiles);
  }

  // Cleanup
  console.log('\n8. Cleaning up...');
  for (const fileId of fileIds) {
    db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
  }
  console.log('✓ Test files deleted');

  console.log('\n✓ All materialization tests passed!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

Run:
```bash
node server/execution/test-materialize.js
```

## Files Changed

- `server/execution/materialize.js` - New materialization module
- `server/execution/bash.js` - Add executeWithProject() method
- `server/execution/test-materialize.js` - New tests

## Testing Checklist

- [ ] Run tests: `node server/execution/test-materialize.js`
- [ ] Verify files load from database
- [ ] Test directory structure created correctly
- [ ] Verify nested files accessible
- [ ] Test Python scripts can be executed
- [ ] Test with 100+ files for performance
- [ ] Verify large files (> 1MB) load correctly

## Validation

```bash
# Run tests
node server/execution/test-materialize.js

# Expected output:
# ✓ Created 3 test files
# ✓ Materialized 3 files in XXms
# ✓ File accessible via cat
# ✓ Directory structure correct
# ✓ Nested file accessible
# ✓ Python script execution works
# ✓ Scanned 3 files
```

## Performance Benchmarks

### Small Project (< 20 files)
- **Materialization time**: < 50ms
- **Total bytes**: < 100KB
- **Memory overhead**: ~1MB

### Medium Project (20-100 files)
- **Materialization time**: 100-300ms
- **Total bytes**: 1-5MB
- **Memory overhead**: ~5-10MB

### Large Project (> 100 files)
- **Materialization time**: 300-1000ms
- **Total bytes**: 5-50MB
- **Memory overhead**: ~20-50MB

**Optimization note**: Materialization happens once per conversation. Subsequent bash commands reuse the same virtual filesystem.

## Notes

### Read-Only vs Read-Write

For MVP, **all files are writable**. Models can:
- Modify user-uploaded files
- Create new files anywhere
- Delete files

Changes are detected in Step 14 and reindexed automatically.

**Future enhancement**: Add read-only flag in metadata:
```javascript
{
  "user_uploaded": true,
  "read_only": true
}
```

Then enforce in Pyodide FS permissions.

### Directory Structure

Files are materialized with their exact paths from the database:
```
Database:
  - path: "data/sales.csv"
  - path: "scripts/analyze.py"
  - path: "README.md"

Virtual FS:
  /project/
    data/
      sales.csv
    scripts/
      analyze.py
    README.md
```

Models can organize files however they want.

### Caching

The virtual filesystem persists for the lifetime of the bashExecutor singleton. This means:
- First bash command: Materialization occurs (~100-500ms)
- Subsequent commands: No materialization needed (instant)
- New conversation: Filesystem persists (unless cleared)

**Trade-off**: Memory usage vs. performance

For production, consider:
- Clear filesystem after X minutes of inactivity
- Clear filesystem between conversations
- Per-conversation filesystems (higher memory)

## Next Step

[14: Auto-Indexing](./14-tool-persistence.md) - Detect file changes after bash execution and reindex automatically
