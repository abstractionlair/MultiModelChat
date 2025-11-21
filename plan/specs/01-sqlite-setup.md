# Step 01: SQLite Setup

**Phase**: 1a - Foundations
**Complexity**: Low (1-2 hours)
**Dependencies**: None (start here!)
**Can Parallelize**: No

[← Back to Roadmap](../ROADMAP.md)

## Goal

Set up SQLite database with proper configuration (WAL mode, ULID ID generation) and basic infrastructure.

## Success Criteria

- [ ] SQLite database file created at `data.db`
- [ ] WAL mode enabled for better concurrency
- [ ] ULID ID generation utility implemented
- [ ] Database connection module exports reusable `db` instance
- [ ] Basic error handling and logging

## Implementation

### 1. Install Dependencies

```bash
npm install better-sqlite3 ulid
```

### 2. Create Database Module

**File**: `server/db/index.js`

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const { ulid } = require('ulid');

// Database file location
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data.db');

// Create/open database
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');  // Balance safety and performance
db.pragma('busy_timeout = 5000');   // Wait up to 5s for locks

// ID generation utility
function newId(prefix = '') {
  const id = ulid();
  return prefix ? `${prefix}_${id}` : id;
}

// Graceful shutdown
process.on('exit', () => db.close());
process.on('SIGHUP', () => process.exit(128 + 1));
process.on('SIGINT', () => process.exit(128 + 2));
process.on('SIGTERM', () => process.exit(128 + 15));

module.exports = { db, newId };
```

### 3. Add to .gitignore

**File**: `.gitignore`

```
# Database files
data.db
data.db-shm
data.db-wal
```

### 4. Create Initial Schema File

**File**: `server/db/schema.sql`

```sql
-- This file will be populated in subsequent steps
-- For now, just a placeholder comment
```

### 5. Test the Setup

**File**: `server/db/test-connection.js`

```javascript
const { db, newId } = require('./index');

console.log('Testing SQLite connection...');

// Test database connection
try {
  const result = db.prepare('SELECT 1 as test').get();
  console.log('✓ Database connected:', result);
} catch (err) {
  console.error('✗ Database connection failed:', err);
  process.exit(1);
}

// Test ULID generation
const id1 = newId();
const id2 = newId('conv');
console.log('✓ ULID generation works:', { id1, id2 });

// Test WAL mode
const mode = db.pragma('journal_mode', { simple: true });
console.log('✓ Journal mode:', mode);

console.log('\nAll tests passed!');
```

Run test:
```bash
node server/db/test-connection.js
```

## Files Changed

- `package.json` - Add dependencies
- `.gitignore` - Ignore database files
- `server/db/index.js` - New file
- `server/db/schema.sql` - New file (placeholder)
- `server/db/test-connection.js` - New file (temporary, for testing)

## Testing

1. Run `node server/db/test-connection.js`
2. Verify output shows:
   - Database connected
   - ULID generation works
   - Journal mode is WAL

3. Check that `data.db`, `data.db-shm`, `data.db-wal` were created

## Validation

```bash
# Check that database was created
ls -lh data.db*

# Verify WAL mode
sqlite3 data.db "PRAGMA journal_mode;"
# Should output: wal

# Verify database is accessible
sqlite3 data.db "SELECT 1;"
# Should output: 1
```

## Rollback Plan

If this step fails:
1. Delete `data.db*` files
2. Remove `server/db/` directory
3. Uninstall dependencies: `npm uninstall better-sqlite3 ulid`

## Notes

- **Why WAL mode?** Allows concurrent reads while writing, better performance for multi-user future
- **Why ULID?** Sortable by time, URL-safe, shorter than UUID
- **Why better-sqlite3?** Synchronous API, faster than async alternatives, simpler error handling

## Next Step

[02: Conversations Schema](./02-conversations-schema.md) - Define tables for storing conversations
