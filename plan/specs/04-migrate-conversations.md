# Step 04: Migrate Conversations to SQLite

**Phase**: 1a - Foundations
**Complexity**: Medium (2-4 hours)
**Dependencies**: [02: Conversations Schema](./02-conversations-schema.md), [03: Projects Schema](./03-projects-schema.md)
**Can Parallelize**: No (needs both 02 and 03 complete)

[← Back to Roadmap](../ROADMAP.md)

## Goal

Update `server/server.js` to migrate the in-memory `conversations` Map to SQLite on startup, preserving existing conversation data.

## Success Criteria

- [ ] On startup, load in-memory conversations into SQLite
- [ ] Each conversation assigned to default project
- [ ] Rounds converted to individual messages
- [ ] In-memory Map populated from SQLite after migration
- [ ] Existing transcript export still works
- [ ] Server can restart without losing data

## Implementation

### 1. Create Migration Helper

**File**: `server/db/migrate-memory-to-sqlite.js`

```javascript
const { db, newId, getDefaultProjectId } = require('./index');

/**
 * Migrate in-memory conversations to SQLite
 * @param {Map} conversationsMap - The in-memory Map from server.js
 */
function migrateConversationsToSQLite(conversationsMap) {
  const defaultProjectId = getDefaultProjectId();
  let migrated = 0;

  // Check if any conversations already exist
  const existing = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
  if (existing.count > 0) {
    console.log(`Found ${existing.count} existing conversations in DB, skipping migration`);
    return;
  }

  console.log(`Migrating ${conversationsMap.size} conversations to SQLite...`);

  db.transaction(() => {
    for (const [convId, conv] of conversationsMap.entries()) {
      // Insert conversation record
      const now = Date.now();
      db.prepare(`
        INSERT INTO conversations (id, project_id, title, created_at, updated_at, round_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        convId,
        defaultProjectId,
        conv.title || `Conversation ${convId}`,
        conv.created_at || now,
        conv.updated_at || now,
        conv.rounds?.length || 0
      );

      // Insert messages from each round
      if (conv.rounds && Array.isArray(conv.rounds)) {
        for (let roundNum = 0; roundNum < conv.rounds.length; roundNum++) {
          const round = conv.rounds[roundNum];

          // User message
          if (round.user) {
            const userMsgId = newId('msg');
            db.prepare(`
              INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
              userMsgId,
              convId,
              roundNum + 1, // 1-indexed
              'user',
              round.user.content || '',
              JSON.stringify({
                ts: round.user.ts || now,
                attachments: round.attachments
              }),
              round.user.ts || now
            );
          }

          // Agent messages
          if (round.agents && Array.isArray(round.agents)) {
            for (const agent of round.agents) {
              const agentMsgId = newId('msg');
              db.prepare(`
                INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `).run(
                agentMsgId,
                convId,
                roundNum + 1,
                agent.speaker || `agent:${agent.modelId}`,
                agent.content || '',
                JSON.stringify({
                  modelId: agent.modelId,
                  agentId: agent.agentId,
                  usage: agent.usage,
                  ts: agent.ts || now
                }),
                agent.ts || now
              );
            }
          }
        }
      }

      migrated++;
    }
  })();

  console.log(`✓ Migrated ${migrated} conversations to SQLite`);
}

/**
 * Load conversations from SQLite into in-memory Map
 * @returns {Map} Conversations Map
 */
function loadConversationsFromSQLite() {
  const conversations = new Map();

  const allConvs = db.prepare('SELECT * FROM conversations').all();

  for (const conv of allConvs) {
    const messages = db.prepare(`
      SELECT * FROM conversation_messages
      WHERE conversation_id = ?
      ORDER BY round_number, created_at
    `).all(conv.id);

    // Reconstruct rounds structure
    const rounds = [];
    const roundsMap = new Map();

    for (const msg of messages) {
      if (!roundsMap.has(msg.round_number)) {
        roundsMap.set(msg.round_number, { user: null, agents: [] });
      }

      const round = roundsMap.get(msg.round_number);
      const metadata = msg.metadata ? JSON.parse(msg.metadata) : {};

      if (msg.speaker === 'user') {
        round.user = {
          speaker: 'user',
          content: msg.content,
          ts: metadata.ts || msg.created_at
        };
        if (metadata.attachments) {
          round.attachments = metadata.attachments;
        }
      } else {
        round.agents.push({
          speaker: msg.speaker,
          modelId: metadata.modelId,
          agentId: metadata.agentId,
          content: msg.content,
          ts: metadata.ts || msg.created_at,
          usage: metadata.usage
        });
      }
    }

    // Convert map to array
    for (const [roundNum, round] of roundsMap.entries()) {
      rounds[roundNum - 1] = round; // 0-indexed array
    }

    conversations.set(conv.id, {
      id: conv.id,
      project_id: conv.project_id,
      title: conv.title,
      rounds,
      perModelState: {}, // TODO: Add persistence for this later
      autoSave: conv.auto_save ? JSON.parse(conv.auto_save) : undefined,
      created_at: conv.created_at,
      updated_at: conv.updated_at
    });
  }

  console.log(`✓ Loaded ${conversations.size} conversations from SQLite`);
  return conversations;
}

module.exports = { migrateConversationsToSQLite, loadConversationsFromSQLite };
```

### 2. Update server.js Startup

**File**: `server/server.js`

Add at the top:
```javascript
const { db } = require('./db/index');
const { runMigrations } = require('./db/migrate');
const { migrateConversationsToSQLite, loadConversationsFromSQLite } = require('./db/migrate-memory-to-sqlite');
```

Replace the in-memory Map initialization:
```javascript
// OLD:
// const conversations = new Map();

// NEW:
let conversations = new Map();

// Run migrations on startup
runMigrations();

// Migrate existing in-memory data (if any) to SQLite
if (conversations.size > 0) {
  migrateConversationsToSQLite(conversations);
}

// Load from SQLite (either just-migrated or existing data)
conversations = loadConversationsFromSQLite();
```

### 3. Update Conversation Save Logic

After every turn, persist the new messages to SQLite.

Find the POST `/api/turn` handler and add after creating round:

```javascript
// After: conv.rounds.push(round);

// Persist to SQLite
const roundNum = conv.rounds.length;

// Insert user message
const userMsgId = newId('msg');
db.prepare(`
  INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  userMsgId,
  convId,
  roundNum,
  'user',
  userMessage,
  JSON.stringify({
    ts: round.user.ts,
    attachments: round.attachments
  }),
  round.user.ts
);

// Update conversation metadata
db.prepare(`
  UPDATE conversations
  SET updated_at = ?, round_count = ?
  WHERE id = ?
`).run(Date.now(), roundNum, convId);
```

After each agent response (in the tasks Promise.all loop), add:

```javascript
// After: round.agents.push(msg);

// Persist agent message to SQLite
const agentMsgId = newId('msg');
db.prepare(`
  INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  agentMsgId,
  convId,
  roundNum,
  msg.speaker,
  msg.content,
  JSON.stringify({
    modelId: msg.modelId,
    agentId: msg.agentId,
    usage: msg.usage,
    ts: msg.ts
  }),
  msg.ts
);
```

## Files Changed

- `server/db/migrate-memory-to-sqlite.js` - New migration helper
- `server/server.js` - Import DB, run migrations, save to SQLite

## Testing

### Manual Test

1. Start server with existing conversations (if any):
   ```bash
   npm start
   ```

2. Check that conversations were migrated:
   ```sql
   sqlite3 data.db "SELECT COUNT(*) FROM conversations;"
   sqlite3 data.db "SELECT COUNT(*) FROM conversation_messages;"
   ```

3. Create a new conversation via UI or curl

4. Restart server - verify conversations still exist

5. Check database:
   ```sql
   sqlite3 data.db "SELECT id, title, round_count FROM conversations;"
   ```

### Automated Test

**File**: `server/db/test-migration.js`

```javascript
const { db, newId } = require('./index');
const { runMigrations } = require('./migrate');
const { migrateConversationsToSQLite, loadConversationsFromSQLite } = require('./migrate-memory-to-sqlite');

runMigrations();

// Create mock in-memory conversations
const mockConversations = new Map();
const convId = newId('conv');

mockConversations.set(convId, {
  id: convId,
  rounds: [
    {
      user: { speaker: 'user', content: 'Hello', ts: Date.now() },
      agents: [
        { speaker: 'agent:gpt-4', modelId: 'gpt-4', content: 'Hi!', ts: Date.now() }
      ]
    }
  ]
});

// Migrate
migrateConversationsToSQLite(mockConversations);

// Load back
const loaded = loadConversationsFromSQLite();

console.log('Original:', mockConversations.get(convId));
console.log('Loaded:', loaded.get(convId));

console.log('\n✓ Migration test passed!');
```

## Rollback Plan

If issues occur:
1. Stop server
2. Delete `data.db*`
3. Revert code changes
4. Restart server (back to in-memory)

## Notes

### Backward Compatibility

The in-memory Map structure is preserved, so existing code continues to work. We just add persistence underneath.

### Future Optimization

Later, we can move away from loading everything into memory and query SQLite directly per request. But for Phase 1a, keep it simple.

## Next Step

[05: Config Management](./05-config-management.md) - Store model selections and prompts in SQLite
