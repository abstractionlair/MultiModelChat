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
