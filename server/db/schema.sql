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

-- Project files with hybrid storage strategy
CREATE TABLE project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,              -- Virtual path: "docs/api-reference.md"
  content TEXT,                    -- For small files (< 1MB)
  content_location TEXT,           -- Disk path for large files: "storage/abc123.bin"
  content_hash TEXT,               -- SHA256 for change detection
  mime_type TEXT,
  size_bytes INTEGER,
  metadata TEXT,                   -- JSON: { always_in_context, retrieval_eligible, tags, etc }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, path)         -- Prevent duplicate paths
);

CREATE INDEX idx_project_files_project ON project_files(project_id);
CREATE INDEX idx_project_files_path ON project_files(project_id, path);

-- Content chunks for retrieval
CREATE TABLE content_chunks (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,     -- 'file' | 'conversation_message'
  source_id TEXT NOT NULL,       -- file.id or message.id
  project_id TEXT NOT NULL,
  chunk_index INTEGER,           -- Order within source (0, 1, 2...)
  content TEXT NOT NULL,
  location TEXT,                 -- JSON: { path, start_line, end_line, start_char, end_char } | { round_number, speaker }
  summary TEXT,
  token_count INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_chunks_source ON content_chunks(source_type, source_id);
CREATE INDEX idx_chunks_project ON content_chunks(project_id);

-- FTS5 retrieval index
CREATE VIRTUAL TABLE retrieval_index USING fts5(
  chunk_id UNINDEXED,
  project_id UNINDEXED,
  content,
  metadata UNINDEXED,
  tokenize = 'porter unicode61'
);

-- Cleanup triggers for chunk lifecycle
CREATE TRIGGER cleanup_file_chunks
AFTER DELETE ON project_files
BEGIN
  DELETE FROM content_chunks WHERE source_type = 'file' AND source_id = OLD.id;
END;

CREATE TRIGGER cleanup_message_chunks
AFTER DELETE ON conversation_messages
BEGIN
  DELETE FROM content_chunks WHERE source_type = 'conversation_message' AND source_id = OLD.id;
END;

CREATE TRIGGER cleanup_fts_chunks
AFTER DELETE ON content_chunks
BEGIN
  DELETE FROM retrieval_index WHERE chunk_id = OLD.id;
END;
