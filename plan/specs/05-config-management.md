# Step 05: Config Management

**Phase**: 1a - Foundations
**Complexity**: Medium (2-3 hours)
**Dependencies**: [04: Migrate Conversations](./04-migrate-conversations.md)
**Can Parallelize**: No

[← Back to Roadmap](../ROADMAP.md)

## Goal

Move configuration (model selections, system prompts, UI preferences) from environment variables and in-memory state to the SQLite `config` table.

## Success Criteria

- [ ] Config table stores model selections
- [ ] Config table stores system prompts (common, per-provider)
- [ ] Config API endpoints (`GET /api/config`, `POST /api/config`)
- [ ] UI loads config from API on startup
- [ ] Changes to config persist across server restarts

## Schema

Already exists from migrations, but verify:

```sql
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT,              -- JSON-encoded configuration
  updated_at INTEGER
);
```

## Config Structure

```javascript
// Stored as JSON strings in config.value
{
  // Model selections
  "active_models": [
    {
      "provider": "openai",
      "modelId": "gpt-4o",
      "name": "GPT-4",
      "options": {}
    },
    {
      "provider": "anthropic",
      "modelId": "claude-sonnet-4-5",
      "name": "Claude",
      "options": {}
    }
  ],

  // System prompts
  "system_prompts": {
    "common": "You are {{modelId}} in a multi-agent conversation...",
    "perProvider": {
      "openai": "",
      "anthropic": "",
      "google": "",
      "xai": ""
    }
  },

  // UI preferences
  "preferences": {
    "debugMode": false,
    "autoSave": false
  }
}
```

## Implementation

### 1. Config Module

**File**: `server/config/index.js`

```javascript
const { db } = require('../db/index');

/**
 * Get config value by key
 */
function getConfig(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);

  if (!row) return defaultValue;

  try {
    return JSON.parse(row.value);
  } catch (err) {
    console.error(`Failed to parse config key "${key}":`, err);
    return defaultValue;
  }
}

/**
 * Set config value by key
 */
function setConfig(key, value) {
  const jsonValue = JSON.stringify(value);
  const now = Date.now();

  db.prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
  `).run(key, jsonValue, now, jsonValue, now);
}

/**
 * Get all config as object
 */
function getAllConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const config = {};

  for (const row of rows) {
    try {
      config[row.key] = JSON.parse(row.value);
    } catch (err) {
      console.error(`Failed to parse config key "${row.key}":`, err);
    }
  }

  return config;
}

/**
 * Initialize default config if not set
 */
function initializeDefaultConfig() {
  // Default active models
  if (!getConfig('active_models')) {
    setConfig('active_models', [
      {
        provider: 'openai',
        modelId: process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o',
        name: 'GPT-4',
        options: {}
      },
      {
        provider: 'anthropic',
        modelId: process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-sonnet-4-5',
        name: 'Claude',
        options: {}
      }
    ]);
  }

  // Default system prompts
  if (!getConfig('system_prompts')) {
    const defaultCommon = 'You are {{modelId}} in a multi-agent conversation with one user and multiple AI models. ' +
      'This is a simplified conversation, driven off of user messages. There is one round per user message. ' +
      'You will see the full conversation from the beginning: each user message followed by other agents\' replies tagged in brackets, e.g., [ModelA]: ... ' +
      'Your own previous replies appear as assistant messages. Respond once per user turn, primarily addressing the user directly but also addressing the other models as appropriate. ' +
      'Coordination: Replies are collected in parallel and shown together; do not claim to "go first" or "start the discussion". Avoid meta-openers; contribute your content directly.';

    setConfig('system_prompts', {
      common: process.env.SYSTEM_PROMPT_COMMON || defaultCommon,
      perProvider: {
        openai: process.env.OPENAI_DEFAULT_PROMPT || '',
        anthropic: process.env.ANTHROPIC_DEFAULT_PROMPT || '',
        google: process.env.GOOGLE_DEFAULT_PROMPT || '',
        xai: process.env.XAI_DEFAULT_PROMPT || ''
      }
    });
  }

  // Default preferences
  if (!getConfig('preferences')) {
    setConfig('preferences', {
      debugMode: false,
      autoSave: false
    });
  }
}

module.exports = { getConfig, setConfig, getAllConfig, initializeDefaultConfig };
```

### 2. Update server.js Startup

**File**: `server/server.js`

Add initialization:
```javascript
const { initializeDefaultConfig, getConfig } = require('./config/index');

// After runMigrations():
initializeDefaultConfig();
```

Replace usages of DEFAULT_MODELS with:
```javascript
// OLD:
// const DEFAULT_MODELS = { ... };

// NEW: Load from config
function getActiveModels() {
  return getConfig('active_models', []);
}

function getSystemPrompts() {
  return getConfig('system_prompts', { common: '', perProvider: {} });
}
```

### 3. Config API Endpoints

**File**: `server/server.js`

Add routes:

```javascript
const { getAllConfig, setConfig } = require('./config/index');

// GET /api/config - Get all configuration
app.get('/api/config', (req, res) => {
  try {
    const config = getAllConfig();
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: 'config_fetch_failed', detail: String(e.message) });
  }
});

// POST /api/config - Update configuration
app.post('/api/config', (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key) {
      return res.status(400).json({ error: 'key_required' });
    }

    setConfig(key, value);
    res.json({ ok: true, key, value });
  } catch (e) {
    res.status(500).json({ error: 'config_update_failed', detail: String(e.message) });
  }
});

// POST /api/config/bulk - Update multiple config values
app.post('/api/config/bulk', (req, res) => {
  try {
    const updates = req.body;

    if (typeof updates !== 'object') {
      return res.status(400).json({ error: 'invalid_format' });
    }

    for (const [key, value] of Object.entries(updates)) {
      setConfig(key, value);
    }

    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (e) {
    res.status(500).json({ error: 'bulk_update_failed', detail: String(e.message) });
  }
});
```

### 4. Update UI to Load Config

**File**: `web/app.js`

Add on page load:
```javascript
// Load config from server
async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();

    // Populate UI with active models
    if (config.active_models) {
      // Update model selector UI with active_models
      updateModelSelectors(config.active_models);
    }

    // Populate system prompts
    if (config.system_prompts) {
      document.getElementById('promptCommon').value = config.system_prompts.common || '';
      // ... populate per-provider prompts
    }

    // Apply preferences
    if (config.preferences) {
      document.getElementById('debugToggle').checked = config.preferences.debugMode || false;
      // ... other preferences
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

// Call on startup
loadConfig();
```

Add save handler:
```javascript
// Save config when models change
async function saveConfig(key, value) {
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value })
    });
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

// Example: Save active models when changed
document.getElementById('modelSelector').addEventListener('change', () => {
  const activeModels = getActiveModelsFromUI();
  saveConfig('active_models', activeModels);
});
```

## Files Changed

- `server/config/index.js` - New config module
- `server/server.js` - Load config, add API endpoints
- `web/app.js` - Load and save config via API

## Testing

### Manual Test

1. Start server:
   ```bash
   npm start
   ```

2. Check default config was created:
   ```sql
   sqlite3 data.db "SELECT key, substr(value, 1, 50) FROM config;"
   ```

3. Update config via API:
   ```bash
   curl -X POST http://localhost:3000/api/config \
     -H 'Content-Type: application/json' \
     -d '{"key":"preferences","value":{"debugMode":true}}'
   ```

4. Verify it persisted:
   ```bash
   curl http://localhost:3000/api/config | jq .preferences
   ```

5. Restart server and verify config still there

### Test Script

**File**: `server/config/test-config.js`

```javascript
const { getConfig, setConfig, getAllConfig, initializeDefaultConfig } = require('./index');
const { runMigrations } = require('../db/migrate');

runMigrations();
initializeDefaultConfig();

console.log('All config:', getAllConfig());

// Test get
const models = getConfig('active_models');
console.log('Active models:', models);

// Test set
setConfig('test_key', { foo: 'bar' });
const retrieved = getConfig('test_key');
console.log('Retrieved test_key:', retrieved);

console.log('\n✓ Config test passed!');
```

## Notes

### Environment Variables Still Work

If config isn't set, we fall back to env vars (for DEFAULT_MODELS, prompts, etc.). This maintains backward compatibility.

### Config vs Settings

- **Config**: Global settings (models, prompts, preferences)
- **Project Settings**: Per-project overrides (coming in Phase 1b)

## Next Step

[06: Update APIs](./06-update-apis.md) - Final refactor to use SQLite throughout
