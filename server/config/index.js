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
