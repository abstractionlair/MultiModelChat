# Step 02: Conversations Schema

**Phase**: 1a - Foundations
**Complexity**: Medium (2-4 hours)
**Dependencies**: [01: SQLite Setup](./01-sqlite-setup.md)
**Can Parallelize**: Can run parallel with [03: Projects Schema](./03-projects-schema.md)

[← Back to Roadmap](../ROADMAP.md)

## Goal

Create SQLite tables for storing conversations using **write-once message storage** (not JSON blobs) to avoid lock contention and enable per-message operations.

## Success Criteria

- [ ] `conversations` table created with metadata
- [ ] `conversation_messages` table created for individual messages
- [ ] View `conversation_rounds` created for backward compatibility
- [ ] Indexes on conversation_id and round_number
- [ ] Migration script tested with sample data

## Schema Design

### conversations Table

Stores conversation metadata (not the messages themselves).

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT,
  summary TEXT,            -- Auto-generated every ~10 rounds
  context_state TEXT,      -- JSON: tracks what's in working context
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  round_count INTEGER DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversations_project ON conversations(project_id);
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
```

### conversation_messages Table

Write-once storage for individual messages. Each message (user or agent) is one row.

```sql
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  speaker TEXT NOT NULL,       -- 'user' or 'agent:model-id'
  content TEXT NOT NULL,
  metadata TEXT,               -- JSON: { modelId?, agentId?, usage?, ts, attachments? }
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_conversation ON conversation_messages(conversation_id, round_number);
CREATE INDEX idx_messages_speaker ON conversation_messages(conversation_id, speaker);
```

### conversation_rounds View

For backward compatibility and easy round reconstruction:

```sql
CREATE VIEW conversation_rounds AS
SELECT
  conversation_id,
  round_number,
  json_group_array(
    json_object(
      'speaker', speaker,
      'content', content,
      'metadata', json(metadata)
    )
  ) as round_data
FROM conversation_messages
GROUP BY conversation_id, round_number
ORDER BY round_number;
```

## Implementation

### 1. Update Schema File

**File**: `server/db/schema.sql`

Add the tables and view above.

### 2. Create Migration Script

**File**: `server/db/migrations/001-conversations.js`

```javascript
const { db } = require('../index');

function up() {
  console.log('Running migration: 001-conversations');

  // Read schema from file
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'schema.sql'),
    'utf-8'
  );

  // Extract conversations-related statements
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s && (
      s.includes('CREATE TABLE conversations') ||
      s.includes('CREATE TABLE conversation_messages') ||
      s.includes('CREATE VIEW conversation_rounds') ||
      s.includes('CREATE INDEX idx_conversations') ||
      s.includes('CREATE INDEX idx_messages')
    ));

  // Execute in transaction
  db.transaction(() => {
    for (const stmt of statements) {
      if (stmt) db.exec(stmt + ';');
    }
  })();

  console.log('✓ Conversations tables created');
}

function down() {
  console.log('Rolling back migration: 001-conversations');

  db.transaction(() => {
    db.exec('DROP VIEW IF EXISTS conversation_rounds;');
    db.exec('DROP TABLE IF EXISTS conversation_messages;');
    db.exec('DROP TABLE IF EXISTS conversations;');
  })();

  console.log('✓ Conversations tables dropped');
}

module.exports = { up, down };
```

### 3. Create Migration Runner

**File**: `server/db/migrate.js`

```javascript
const { db } = require('./index');
const fs = require('fs');
const path = require('path');

// Track migrations
db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at INTEGER NOT NULL
  );
`);

function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.js')).sort();

  for (const file of files) {
    const name = file.replace('.js', '');
    const existing = db.prepare('SELECT name FROM migrations WHERE name = ?').get(name);

    if (!existing) {
      console.log(`Applying migration: ${name}`);
      const migration = require(path.join(migrationsDir, file));
      migration.up();
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
    } else {
      console.log(`Skipping migration: ${name} (already applied)`);
    }
  }

  console.log('All migrations complete');
}

// Run if called directly
if (require.main === module) {
  runMigrations();
}

module.exports = { runMigrations };
```

### 4. Test with Sample Data

**File**: `server/db/test-conversations.js`

```javascript
const { db, newId } = require('./index');
const { runMigrations } = require('./migrate');

// Run migrations
runMigrations();

// Test data insertion
const projectId = newId('proj');
const convId = newId('conv');

db.prepare(`
  INSERT INTO projects (id, name, created_at, updated_at)
  VALUES (?, ?, ?, ?)
`).run(projectId, 'Test Project', Date.now(), Date.now());

db.prepare(`
  INSERT INTO conversations (id, project_id, title, created_at, updated_at, round_count)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(convId, projectId, 'Test Conversation', Date.now(), Date.now(), 1);

// Insert messages for round 1
const userMsgId = newId('msg');
const agentMsgId = newId('msg');

db.prepare(`
  INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(userMsgId, convId, 1, 'user', 'Hello!', JSON.stringify({ ts: Date.now() }), Date.now());

db.prepare(`
  INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(agentMsgId, convId, 1, 'agent:gpt-4', 'Hi there!', JSON.stringify({ modelId: 'gpt-4', ts: Date.now() }), Date.now());

// Query back via view
const rounds = db.prepare(`
  SELECT * FROM conversation_rounds WHERE conversation_id = ?
`).all(convId);

console.log('Rounds:', JSON.stringify(rounds, null, 2));

// Query individual messages
const messages = db.prepare(`
  SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY round_number, created_at
`).all(convId);

console.log('Messages:', messages);

console.log('\n✓ Conversations schema test passed!');
```

Run test:
```bash
node server/db/test-conversations.js
```

## Files Changed

- `server/db/schema.sql` - Add conversations tables
- `server/db/migrations/001-conversations.js` - New migration
- `server/db/migrate.js` - New migration runner
- `server/db/test-conversations.js` - New test file

## Testing Checklist

- [ ] Run migration: `node server/db/migrate.js`
- [ ] Verify tables exist: `sqlite3 data.db ".tables"`
- [ ] Should see: `conversations conversation_messages migrations`
- [ ] Run test: `node server/db/test-conversations.js`
- [ ] Verify test inserts and queries data successfully

## Validation Queries

```sql
-- Check schema
.schema conversations
.schema conversation_messages
.schema conversation_rounds

-- Test view
SELECT * FROM conversation_rounds LIMIT 1;

-- Check indexes
.indexes conversation_messages
```

## Notes

### Why Write-Once Messages?

The original design used `rounds TEXT` (JSON blob) in conversations table. Problems:
- Every turn rewrites entire conversation → lock contention
- Can't query individual messages
- Hard to prune old messages
- Difficult to index for search

Write-once messages solve all these issues.

### Why a View?

The `conversation_rounds` view maintains backward compatibility if existing code expects rounds grouped together, while the underlying storage is optimized.

## Next Steps

- **Parallel**: [03: Projects Schema](./03-projects-schema.md) - Can do at the same time
- **Sequential**: [04: Migrate Conversations](./04-migrate-conversations.md) - After both 02 and 03
