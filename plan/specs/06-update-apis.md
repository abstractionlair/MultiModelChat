# Step 06: Update APIs for SQLite

**Phase**: 1a - Foundations
**Complexity**: High (4-6 hours)
**Dependencies**: [05: Config Management](./05-config-management.md)
**Can Parallelize**: No

[← Back to Roadmap](../ROADMAP.md)

## Goal

Final refactor to ensure all API endpoints work correctly with SQLite. Remove reliance on in-memory Map structure and query SQLite directly where appropriate.

## Success Criteria

- [ ] `/api/turn` creates new conversations in SQLite
- [ ] `/api/conversation/:id` reads from SQLite
- [ ] `/api/conversation/:id/export` works with SQLite data
- [ ] `/api/models` uses config from SQLite
- [ ] Transcript auto-save still works
- [ ] No breaking changes to existing UI

## Implementation

### 1. Refactor `/api/turn` - New Conversation Creation

**File**: `server/server.js`

Update conversation creation logic:

```javascript
app.post('/api/turn', async (req, res) => {
  try {
    const { conversationId, userMessage, targetModels, systemPrompts, textAttachments } = req.body || {};

    // ... validation ...

    let convId = conversationId;
    let conv;

    if (convId && conversations.has(convId)) {
      // Existing conversation
      conv = conversations.get(convId);
    } else {
      // New conversation - create in SQLite
      convId = newId('conv');
      const defaultProjectId = getDefaultProjectId();
      const now = Date.now();

      db.prepare(`
        INSERT INTO conversations (id, project_id, title, created_at, updated_at, round_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        convId,
        defaultProjectId,
        `Conversation ${convId.slice(-6)}`, // Temp title
        now,
        now,
        0
      );

      // Create in-memory structure
      conv = {
        id: convId,
        project_id: defaultProjectId,
        rounds: [],
        perModelState: {}
      };
      conversations.set(convId, conv);
    }

    // ... rest of turn logic (already updated in step 04) ...
  } catch (e) {
    console.error('turn error', e);
    res.status(500).json({ error: 'internal_error', detail: String(e.message) });
  }
});
```

### 2. Refactor `/api/conversation/:id` - Direct SQLite Query

Update to optionally query SQLite directly instead of relying on in-memory Map:

```javascript
app.get('/api/conversation/:id', (req, res) => {
  const id = req.params.id;

  // Try in-memory first
  let conv = conversations.get(id);

  // If not in memory, load from SQLite
  if (!conv) {
    const dbConv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!dbConv) {
      return res.status(404).json({ error: 'not_found' });
    }

    // Load messages and reconstruct
    const { loadConversationsFromSQLite } = require('./db/migrate-memory-to-sqlite');
    const loaded = loadConversationsFromSQLite();
    conv = loaded.get(id);

    if (!conv) {
      return res.status(404).json({ error: 'not_found' });
    }

    // Add to in-memory cache
    conversations.set(id, conv);
  }

  res.json(conv);
});
```

### 3. Refactor `/api/models` - Use Config

Update to load defaults from config instead of env:

```javascript
const { getConfig } = require('./config/index');

app.get('/api/models', async (req, res) => {
  try {
    const activeModels = getConfig('active_models', []);
    const systemPrompts = getConfig('system_prompts', { common: '', perProvider: {} });

    const data = await listAllModels(DEFAULT_MODELS); // Still uses DEFAULT_MODELS for discovery

    // Add config overrides
    data.activeModels = activeModels;
    data.prompts = systemPrompts;

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'models_list_failed', detail: String(e.message) });
  }
});
```

### 4. Add Conversation Listing Endpoint

New endpoint to list all conversations:

```javascript
// GET /api/conversations - List all conversations
app.get('/api/conversations', (req, res) => {
  try {
    const projectId = req.query.project_id || getDefaultProjectId();
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const convs = db.prepare(`
      SELECT
        id,
        project_id,
        title,
        summary,
        created_at,
        updated_at,
        round_count
      FROM conversations
      WHERE project_id = ?
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(projectId, limit, offset);

    const total = db.prepare(`
      SELECT COUNT(*) as count
      FROM conversations
      WHERE project_id = ?
    `).get(projectId);

    res.json({
      conversations: convs,
      total: total.count,
      limit,
      offset
    });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', detail: String(e.message) });
  }
});
```

### 5. Update System Prompt Builder

Update `buildSystemPrimer` to use config:

```javascript
const { getConfig } = require('./config/index');

function buildSystemPrimer(provider, modelId, providedPrompts, context = {}) {
  const providerKey = (provider || '').toLowerCase();

  // Get prompts from config if not provided
  const configPrompts = getConfig('system_prompts', { common: '', perProvider: {} });
  const prompts = providedPrompts || configPrompts;

  // ... rest of the function unchanged ...
}
```

### 6. Ensure Auto-Save Works

Verify that transcript auto-save still works with SQLite:

```javascript
// In /api/turn endpoint, after all agents respond:

if (conv.autoSave && conv.autoSave.enabled) {
  writeTranscript(conv, conv.autoSave.format || 'md')
    .then(p => { if (dbg) console.log('[autosave] wrote', p); })
    .catch(e => { if (dbg) console.log('[autosave] failed', e && e.message); });
}
```

The `writeTranscript` function should still work as-is since it reads from the `conv` object.

### 7. Add Health Check Endpoint

Useful for deployment:

```javascript
// GET /api/health - Server health check
app.get('/api/health', (req, res) => {
  try {
    // Check database connection
    db.prepare('SELECT 1').get();

    res.json({
      status: 'ok',
      database: 'connected',
      conversations: conversations.size,
      uptime: process.uptime()
    });
  } catch (e) {
    res.status(500).json({
      status: 'error',
      error: e.message
    });
  }
});
```

## Files Changed

- `server/server.js` - Update all endpoints

## Testing

### Comprehensive Test Plan

**File**: `test/integration/test-phase-1a.js`

```javascript
const axios = require('axios');
const BASE_URL = 'http://localhost:3000';

async function testPhase1a() {
  console.log('Testing Phase 1a Integration...\n');

  // 1. Health check
  console.log('1. Health check...');
  const health = await axios.get(`${BASE_URL}/api/health`);
  console.log('✓ Server healthy:', health.data);

  // 2. Get config
  console.log('\n2. Get config...');
  const config = await axios.get(`${BASE_URL}/api/config`);
  console.log('✓ Config loaded:', Object.keys(config.data));

  // 3. Create new conversation
  console.log('\n3. Create new conversation...');
  const turn = await axios.post(`${BASE_URL}/api/turn`, {
    userMessage: 'Hello, this is a test',
    targetModels: [
      { provider: 'openai', modelId: 'gpt-4o-mini' }
    ]
  });
  const convId = turn.data.conversationId;
  console.log('✓ Conversation created:', convId);

  // 4. Fetch conversation
  console.log('\n4. Fetch conversation...');
  const conv = await axios.get(`${BASE_URL}/api/conversation/${convId}`);
  console.log('✓ Conversation fetched:', conv.data.rounds.length, 'rounds');

  // 5. List conversations
  console.log('\n5. List conversations...');
  const list = await axios.get(`${BASE_URL}/api/conversations`);
  console.log('✓ Conversations listed:', list.data.total, 'total');

  // 6. Export conversation
  console.log('\n6. Export conversation...');
  const exported = await axios.get(`${BASE_URL}/api/conversation/${convId}/export?format=md`);
  console.log('✓ Exported length:', exported.data.length, 'characters');

  console.log('\n✅ All Phase 1a tests passed!');
}

testPhase1a().catch(err => {
  console.error('❌ Test failed:', err.response?.data || err.message);
  process.exit(1);
});
```

Run test:
```bash
# Start server in background
npm start &

# Run tests
node test/integration/test-phase-1a.js

# Stop server
killall node
```

### Manual Testing Checklist

- [ ] Start server fresh (delete data.db first)
- [ ] Create conversation via UI - works
- [ ] Add multiple rounds to conversation - works
- [ ] Restart server - conversation persists
- [ ] Export conversation as markdown - works
- [ ] Create second conversation - works
- [ ] List conversations endpoint returns both
- [ ] Health check endpoint returns OK
- [ ] Config API returns expected structure

## Validation

```bash
# Check database has expected data
sqlite3 data.db <<EOF
.mode column
.headers on
SELECT COUNT(*) as conversations FROM conversations;
SELECT COUNT(*) as messages FROM conversation_messages;
SELECT COUNT(*) as projects FROM projects;
SELECT key, length(value) as value_length FROM config;
EOF
```

Expected output:
- At least 1 conversation
- Multiple messages (2+ per round)
- 1 project (default)
- 3+ config keys (active_models, system_prompts, preferences)

## Rollback Plan

If critical issues:
1. Revert to previous commit
2. Delete data.db
3. Restart server

Data should be recoverable from transcript exports in `transcripts/` directory.

## Notes

### Performance Considerations

For Phase 1a, we still load everything into memory on startup. This is fine for:
- < 1000 conversations
- < 100k total messages

Later phases will optimize to query SQLite directly for large datasets.

### Backward Compatibility

All existing API endpoints work the same way. UI doesn't need changes (except optionally using the new `/api/conversations` list endpoint).

## Success Metrics

Phase 1a is complete when:
- [ ] Server restarts without losing data
- [ ] All existing UI functionality works
- [ ] New conversations persist to SQLite
- [ ] Config persists to SQLite
- [ ] Tests pass
- [ ] No regression in transcript export

---

**Phase 1a Complete! 🎉**

**Next**: [Phase 1b Planning](./07-write-phase-1b-specs.md) - Write detailed specs for file storage and retrieval
