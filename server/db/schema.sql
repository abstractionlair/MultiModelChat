-- Configuration key-value store
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

-- Projects table for organizing conversations and files
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  settings TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
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
