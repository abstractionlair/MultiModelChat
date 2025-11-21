# Technical Reference

**For vision and principles**: See [VISION.md](./VISION.md)
**For implementation plan**: See [ROADMAP.md](./ROADMAP.md)
**For detailed specs**: See [specs/](./specs/)

This document serves as a technical reference for schemas, APIs, and implementation patterns.

---

## Table of Contents

- [Database Schema](#database-schema)
- [API Endpoints](#api-endpoints)
- [System Prompt Templates](#system-prompt-templates)
- [Model Tier Mapping](#model-tier-mapping)
- [Code Execution Lifecycle](#code-execution-lifecycle)
- [Indexing Pipeline](#indexing-pipeline)
- [Storage Strategy](#storage-strategy)
- [Security Patterns](#security-patterns)
- [Concurrency & Scaling](#concurrency--scaling)

---

## Database Schema

### Complete SQLite Schema

```sql
-- ============================================================================
-- ID Generation: ULID (Universally Unique Lexicographically Sortable ID)
-- ============================================================================
-- Example: 01HQVJX9KF3T0Q2Z8W1MXNBR4C
-- Library: npm install ulid

-- ============================================================================
-- Configuration
-- ============================================================================

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT,              -- JSON-encoded configuration
  updated_at INTEGER
);

-- ============================================================================
-- Projects
-- ============================================================================

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  settings TEXT,           -- JSON: see Project Settings Schema below
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ============================================================================
-- Project Files (unified storage with metadata tags)
-- ============================================================================

CREATE TABLE project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,      -- Virtual path: "docs/api-reference.md"
  content TEXT,            -- For small files; large files use content_location
  content_location TEXT,   -- Optional: disk path for large files (e.g., "storage/abc123.bin")
  content_hash TEXT,       -- SHA256 for change detection
  mime_type TEXT,
  size_bytes INTEGER,
  metadata TEXT,           -- JSON: see File Metadata Schema below
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, path) -- Prevent duplicate paths
);

CREATE INDEX idx_project_files_project ON project_files(project_id);
CREATE INDEX idx_project_files_path ON project_files(project_id, path);

-- ============================================================================
-- Conversations (write-once message storage)
-- ============================================================================

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

-- Write-once message storage
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  speaker TEXT NOT NULL,   -- 'user' or 'agent:model-id'
  content TEXT NOT NULL,
  metadata TEXT,           -- JSON: see Message Metadata Schema below
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_conversation ON conversation_messages(conversation_id, round_number);
CREATE INDEX idx_messages_speaker ON conversation_messages(conversation_id, speaker);

-- View for backward compatibility
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

-- ============================================================================
-- Model Metadata (costs, capabilities, context limits)
-- ============================================================================

CREATE TABLE model_metadata (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT,
  context_window INTEGER,  -- Max tokens
  max_output_tokens INTEGER,
  cost_input REAL,         -- Per 1M tokens
  cost_output REAL,        -- Per 1M tokens
  tier TEXT,               -- 'smart' | 'balanced' | 'fast' | 'cheap'
  capabilities TEXT,       -- JSON: see Model Capabilities Schema below
  updated_at INTEGER,
  PRIMARY KEY (provider, model_id)
);

-- ============================================================================
-- Retrieval System (chunking + FTS5)
-- ============================================================================

-- Content chunks with precise location pointers
CREATE TABLE content_chunks (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,     -- 'file' | 'conversation_message'
  source_id TEXT NOT NULL,       -- file.id or message.id
  project_id TEXT NOT NULL,
  chunk_index INTEGER,           -- Order within source
  content TEXT NOT NULL,
  location TEXT,                 -- JSON: see Chunk Location Schema below
  summary TEXT,
  token_count INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_chunks_source ON content_chunks(source_type, source_id);
CREATE INDEX idx_chunks_project ON content_chunks(project_id);

-- Cleanup triggers
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

-- FTS5 full-text search index
CREATE VIRTUAL TABLE retrieval_index USING fts5(
  chunk_id UNINDEXED,      -- References content_chunks.id
  project_id UNINDEXED,    -- For filtering
  content,                 -- Searchable text
  metadata UNINDEXED,      -- JSON
  tokenize = 'porter unicode61'
);

-- Cleanup trigger for FTS5
CREATE TRIGGER cleanup_fts_chunks
AFTER DELETE ON content_chunks
BEGIN
  DELETE FROM retrieval_index WHERE chunk_id = OLD.id;
END;

-- ============================================================================
-- Sessions (active conversations per client)
-- ============================================================================

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  conversation_id TEXT,
  project_id TEXT,
  last_active INTEGER,
  client_info TEXT,        -- JSON: browser, device, etc.
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX idx_sessions_active ON sessions(last_active DESC);
```

### JSON Schemas

#### Project Settings
```javascript
{
  "default_models": ["gpt-4o", "claude-sonnet-4-5"],
  "context_strategy": "smart" | "balanced" | "minimal",
  "max_context_tokens": 128000,
  "retrieval_config": {
    "enabled": true,
    "chunk_size": 50,  // lines
    "max_results": 10
  }
}
```

#### File Metadata
```javascript
{
  "always_in_context": false,
  "retrieval_eligible": true,
  "tool_accessible": true,
  "tags": ["documentation", "api"],
  "summary": "API endpoint reference"
}
```

#### Message Metadata
```javascript
{
  "modelId": "gpt-4o",
  "agentId": "openai:gpt-4o:0",
  "usage": {
    "input_tokens": 1250,
    "output_tokens": 432,
    "total_tokens": 1682
  },
  "ts": 1703001234567,
  "attachments": [
    { "title": "data.csv", "chars": 15234 }
  ]
}
```

#### Model Capabilities
```javascript
{
  "tools": true,
  "vision": false,
  "streaming": true,
  "thinking": true,
  "code_execution": true
}
```

#### Chunk Location
```javascript
// For file chunks:
{
  "path": "docs/api.md",
  "start_line": 45,
  "end_line": 95,
  "start_char": 2134,
  "end_char": 4892
}

// For conversation chunks:
{
  "round_number": 23,
  "speaker": "agent:claude-sonnet-4-5"
}
```

---

## API Endpoints

### Configuration
- `GET /api/config` - Get all configuration
- `POST /api/config` - Update single config value `{key, value}`
- `POST /api/config/bulk` - Update multiple values `{key1: value1, ...}`

### Projects
- `GET /api/projects` - List all projects
- `POST /api/projects` - Create project
- `GET /api/projects/:id` - Get project details
- `PUT /api/projects/:id` - Update project settings
- `DELETE /api/projects/:id` - Delete project

### Project Files
- `GET /api/projects/:id/files` - List files
- `POST /api/projects/:id/files` - Upload/create file
- `GET /api/projects/:id/files/:fileId` - Get file content
- `PUT /api/projects/:id/files/:fileId` - Update file
- `PATCH /api/projects/:id/files/:fileId/metadata` - Update metadata only
- `DELETE /api/projects/:id/files/:fileId` - Delete file

### Conversations
- `GET /api/conversations?project_id=X&limit=50&offset=0` - List conversations
- `POST /api/turn` - Create turn (existing endpoint, extended)
- `GET /api/conversation/:id` - Get conversation with full history
- `GET /api/conversation/:id/export?format=md|json` - Export conversation
- `POST /api/conversation/:id/autosave` - Toggle auto-save
- `DELETE /api/conversation/:id` - Delete conversation
- `PUT /api/conversation/:id/title` - Set conversation title

### Search
- `POST /api/projects/:id/search` - Search files and conversations
  ```json
  {
    "query": "authentication flow",
    "filters": {
      "file_types": [".md", ".js"],
      "exclude_conversations": false
    },
    "limit": 10
  }
  ```

### Models
- `GET /api/models` - List available models (from providers)
- `GET /api/models/metadata` - Get model capabilities and costs
- `POST /api/models/metadata/refresh` - Refresh from provider APIs

### Health
- `GET /api/health` - Server health check

---

## System Prompt Templates

### Base Template

```javascript
function buildSystemPrompt(context) {
  const {
    modelId,
    provider,
    projectName,
    hasCodeExecution,
    projectTools,
    projectFiles,
    retrievalResults,
    conversationInfo
  } = context;

  return `You are ${modelId} in a multi-model conversation with one user and multiple AI models.

This conversation involves parallel responses from different models. You'll see the full conversation history: each user message followed by other models' replies tagged in brackets (e.g., [ModelName]: ...). Your own previous replies appear as assistant messages.

Respond directly to the user and other models as appropriate. Replies are collected in parallel; do not claim to "go first" or reference response order.

PROJECT CONTEXT
You are working in the "${projectName}" project.

${hasCodeExecution ? codeExecutionSection(context) : ''}
${projectTools?.length ? toolsSection(projectTools) : ''}
${projectFiles?.count ? filesSection(projectFiles) : ''}
${retrievalResults?.length ? retrievalSection(retrievalResults) : ''}
${conversationInfo ? conversationSection(conversationInfo) : ''}

${providerSpecificSection(provider)}`;
}
```

### Code Execution Section
```
CODE EXECUTION:
You have access to a Python code execution environment with the project filesystem mounted at /project/

Available Python libraries: os, sys, re, json, csv, math, datetime, pathlib, collections
Project files are mounted read-only at: /project/files/
Tools directory (read/write) at: /project/tools/

CREATING REUSABLE TOOLS:
When you write useful functions that might be needed again, save them to /project/tools/

Best practices:
1. Use descriptive names: parse_auth_logs.py, extract_api_errors.py
2. Include docstrings with parameters, returns, and examples
3. Keep focused: each tool should do one thing well
4. Make discoverable: clear names and documentation help future searches

Example tool:
\`\`\`python
def parse_auth_log(filepath, filter_status=None):
    """
    Parse authentication log CSV files.

    Args:
        filepath: Path to CSV file
        filter_status: Optional status to filter ('failed', 'success', etc.)

    Returns:
        List of dict entries matching filter

    Example:
        from parse_auth_log import parse_auth_log
        failed = parse_auth_log('/project/files/data/auth.csv', 'failed')
    """
    import csv
    # implementation...

# Save to persist across conversations
with open('/project/tools/parse_auth_log.py', 'w') as f:
    f.write(code)
\`\`\`

WHY CREATE TOOLS:
- This project may have 200k+ tokens of context
- You'll encounter similar patterns across conversations
- Other models (and future you) benefit from well-documented utilities
```

### Tools Section
```
AVAILABLE TOOLS:
The following tools exist in this project:
${tools.map(t => `- ${t.path}: ${t.description}`).join('\n')}

Import with: from ${toolName} import ${functionName}
```

### Files Section
```
PROJECT FILES (${count} total):
${files.map(f => `- ${f.path} (${f.size})${f.description ? ' - ' + f.description : ''}`).join('\n')}
```

### Retrieval Section
```
RETRIEVED CONTEXT:
Based on the current query, the following relevant information was found:

${results.map((r, i) => {
  if (r.type === 'file') {
    return `${i+1}. [File: ${r.path}, lines ${r.lines}] ${r.summary} (~${r.tokens} tokens)`;
  } else {
    return `${i+1}. [Conversation: Round ${r.round}, ${r.speaker}] ${r.content}`;
  }
}).join('\n')}

Use code execution to read specific sections or analyze this content further.
```

### Provider-Specific Sections

**OpenAI**:
```
REASONING:
You have extended thinking capabilities. Use them for complex analysis, debugging, or planning multi-step solutions.
```

**Anthropic**:
```
EXTENDED THINKING:
You can use extended thinking for complex reasoning. This is valuable for:
- Analyzing large codebases or datasets
- Debugging intricate issues
- Planning multi-step solutions
```

**Google** (if grounding enabled):
```
WEB SEARCH:
You have access to Google Search grounding for current information and citations. Other models in this conversation may not have this capability - you can offer to search for current information when relevant.
```

---

## Model Tier Mapping

```javascript
// server/config/model-tiers.js
const MODEL_TIERS = {
  // Smart tier - large context, tools, extended thinking
  'gpt-4': 'smart',
  'gpt-4-turbo': 'smart',
  'gpt-4o': 'smart',
  'claude-opus-4': 'smart',
  'claude-opus-4-1': 'smart',
  'claude-sonnet-4': 'smart',
  'claude-sonnet-4-5': 'smart',
  'gemini-2.0-pro': 'smart',
  'gemini-2.5-pro': 'smart',

  // Balanced tier - good context, tools, mid-cost
  'gpt-4o-mini': 'balanced',
  'claude-sonnet-3.5': 'balanced',
  'gemini-1.5-pro': 'balanced',

  // Fast tier - smaller context, fast, cheap
  'gpt-3.5-turbo': 'fast',
  'claude-haiku-3.5': 'fast',
  'gemini-1.5-flash': 'fast',
  'gemini-2.0-flash': 'fast',
};

function getModelTier(modelId) {
  return MODEL_TIERS[modelId] || 'balanced';
}

function supportsCodeExecution(modelId) {
  const tier = getModelTier(modelId);
  return tier === 'smart' || tier === 'balanced';
}
```

### Context Allocation by Tier

| Tier | Working Context | Max Retrieval Results | Strategy |
|------|----------------|----------------------|----------|
| Smart | Last 20 rounds | 10 chunks | Summaries + tool access |
| Balanced | Last 10 rounds | 5 chunks | Summaries + tool access |
| Fast | Last 5 rounds | 3 chunks | Direct insertion |
| Cheap | Last 5 rounds | 3 chunks | Direct insertion |

---

## Code Execution Lifecycle

### 1. Materialize Project Files

Before code execution, materialize DB content to filesystem:

```javascript
async function materializeProjectForExecution(projectId, sessionId) {
  const tempDir = `/tmp/project_${sessionId}`;

  // Create structure
  await fs.mkdir(`${tempDir}/files`, { recursive: true });
  await fs.mkdir(`${tempDir}/tools`, { recursive: true });

  // Load files from DB
  const files = await db.all(
    'SELECT path, content, content_location FROM project_files WHERE project_id = ?',
    [projectId]
  );

  for (const file of files) {
    const fullPath = path.join(tempDir, 'files', file.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    const content = file.content || await fs.readFile(file.content_location);
    await fs.writeFile(fullPath, content);
  }

  return tempDir;
}
```

### 2. Execute Code (Pyodide)

```javascript
const { loadPyodide } = require('pyodide');

async function executeCode(code, projectDir) {
  const pyodide = await loadPyodide();

  // Mount virtual filesystem
  for (const [path, content] of Object.entries(projectFiles)) {
    pyodide.FS.writeFile(`/project/${path}`, content);
  }

  // Execute
  try {
    const result = await pyodide.runPythonAsync(code);
    return { success: true, result, stdout: pyodide.stdout };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
```

### 3. Persist New Tools

After execution, detect and save new tools:

```javascript
async function persistToolsAfterExecution(projectId, tempDir) {
  const toolsDir = path.join(tempDir, 'tools');
  const toolFiles = await fs.readdir(toolsDir, { recursive: true });

  for (const filename of toolFiles) {
    const content = await fs.readFile(path.join(toolsDir, filename), 'utf-8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // Upsert to project_files
    await db.run(`
      INSERT INTO project_files (id, project_id, path, content, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET
        content = excluded.content,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `, [newId(), projectId, `tools/${filename}`, content, hash, Date.now()]);

    // Trigger reindexing
    await indexContent('file', fileId);
  }
}
```

---

## Indexing Pipeline

### On File Upload or Message Creation

```javascript
async function indexContent(sourceType, sourceId) {
  let content, metadata;

  if (sourceType === 'file') {
    const file = await db.get('SELECT * FROM project_files WHERE id = ?', [sourceId]);
    content = file.content || await fs.readFile(file.content_location, 'utf-8');
    metadata = { path: file.path, projectId: file.project_id };
  } else if (sourceType === 'conversation_message') {
    const msg = await db.get('SELECT * FROM conversation_messages WHERE id = ?', [sourceId]);
    content = msg.content;
    const meta = JSON.parse(msg.metadata);
    metadata = {
      conversationId: msg.conversation_id,
      round: msg.round_number,
      speaker: msg.speaker,
      projectId: meta.projectId
    };
  }

  // Chunk content
  const chunks = chunkContent(content, sourceType, metadata);

  // Insert chunks and index
  for (const chunk of chunks) {
    const chunkId = newId();

    await db.run(`
      INSERT INTO content_chunks (id, source_type, source_id, project_id, chunk_index, content, location, token_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [chunkId, sourceType, sourceId, metadata.projectId, chunk.index, chunk.content,
        JSON.stringify(chunk.location), chunk.tokenCount, Date.now()]);

    await db.run(`
      INSERT INTO retrieval_index (chunk_id, project_id, content, metadata)
      VALUES (?, ?, ?, ?)
    `, [chunkId, metadata.projectId, chunk.content, JSON.stringify(chunk.metadata)]);
  }
}
```

### Chunking Strategy

```javascript
function chunkContent(content, sourceType, metadata) {
  if (sourceType === 'file') {
    const lines = content.split('\n');
    const chunks = [];
    const chunkSize = 50; // lines per chunk

    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunkLines = lines.slice(i, i + chunkSize);
      chunks.push({
        index: Math.floor(i / chunkSize),
        content: chunkLines.join('\n'),
        location: {
          path: metadata.path,
          start_line: i + 1,
          end_line: Math.min(i + chunkSize, lines.length)
        },
        tokenCount: estimateTokens(chunkLines.join('\n')),
        metadata: { path: metadata.path }
      });
    }
    return chunks;
  } else {
    // Conversation messages: one chunk per message
    return [{
      index: 0,
      content: content,
      location: {
        round_number: metadata.round,
        speaker: metadata.speaker
      },
      tokenCount: estimateTokens(content),
      metadata: { round: metadata.round, speaker: metadata.speaker }
    }];
  }
}
```

---

## Storage Strategy

### Hybrid Approach

**Small files (< 1MB)**: Store in SQLite `content` column
- Fast retrieval
- Simplifies backups
- No external dependencies

**Large files (> 1MB)**: Store on disk, reference in `content_location`
- Prevents DB bloat
- Better performance for large files

```javascript
const STORAGE_THRESHOLD = 1024 * 1024; // 1MB

async function saveFile(projectId, filePath, content) {
  const sizeBytes = Buffer.byteLength(content);

  if (sizeBytes < STORAGE_THRESHOLD) {
    // Store in DB
    await db.run(`
      INSERT INTO project_files (id, project_id, path, content, size_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content
    `, [newId(), projectId, filePath, content, sizeBytes, Date.now()]);
  } else {
    // Store on disk
    const storageId = crypto.randomBytes(16).toString('hex');
    const storagePath = path.join(STORAGE_DIR, storageId);
    await fs.writeFile(storagePath, content);

    await db.run(`
      INSERT INTO project_files (id, project_id, path, content_location, size_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET content_location = excluded.content_location
    `, [newId(), projectId, filePath, storagePath, sizeBytes, Date.now()]);
  }
}
```

---

## Security Patterns

### FTS5 Query Escaping

Prevent injection by wrapping user queries in quotes:

```javascript
function escapeFTS5Query(query) {
  if (!query || typeof query !== 'string') return '""';

  const cleaned = query.replace(/"/g, '""').trim();
  return `"${cleaned}"`;  // Phrase search
}
```

### Path Validation

Prevent directory traversal attacks:

```javascript
function validateProjectPath(filePath) {
  if (filePath.includes('..') || filePath.startsWith('/')) {
    throw new Error('Invalid path: must be relative within project');
  }

  const normalized = path.normalize(filePath);
  if (normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error('Invalid path after normalization');
  }

  return normalized;
}
```

### Token Estimation

```javascript
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // Simple heuristic: ~4 chars per token
  return Math.ceil(text.length / 4);
}

// For production, use provider-specific tokenizers:
// npm install gpt-tokenizer     // For OpenAI
// npm install @anthropic-ai/tokenizer  // For Claude
```

---

## Concurrency & Scaling

### SQLite WAL Mode

Enable Write-Ahead Logging for better concurrent reads:

```javascript
const Database = require('better-sqlite3');
const db = new Database('data.db');

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
```

### Connection Pooling

For multi-user scenarios:

```javascript
class DatabasePool {
  constructor(path, poolSize = 5) {
    this.connections = [];
    for (let i = 0; i < poolSize; i++) {
      const db = new Database(path);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      this.connections.push({ db, inUse: false });
    }
  }

  async execute(fn) {
    let conn = this.connections.find(c => !c.inUse);
    if (!conn) {
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.execute(fn);
    }

    conn.inUse = true;
    try {
      return fn(conn.db);
    } finally {
      conn.inUse = false;
    }
  }
}
```

### Write Retry Logic

Handle `SQLITE_BUSY` errors:

```javascript
async function withRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return fn();
    } catch (err) {
      if (err.code === 'SQLITE_BUSY' && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 100;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}
```

### Scaling to PostgreSQL

For 100+ concurrent users, migrate to PostgreSQL:
- Schema is mostly compatible (use `TEXT` → `TEXT`, `INTEGER` → `BIGINT`)
- Replace `better-sqlite3` with `pg`
- Update JSON queries (`json_extract` → `->>`/`->>`)
- FTS5 → PostgreSQL full-text search (`to_tsvector`/`to_tsquery`)

---

## Additional References

- [System Prompt Templates](#system-prompt-templates) - Complete prompt building logic
- [Model Tier Mapping](#model-tier-mapping) - Context allocation by model
- [Code Execution Lifecycle](#code-execution-lifecycle) - Materialization, execution, persistence
- [Indexing Pipeline](#indexing-pipeline) - Chunking and FTS5 indexing

For implementation guidance, see:
- [ROADMAP.md](./ROADMAP.md) - Step-by-step implementation plan
- [specs/](./specs/) - Detailed specs for each step
- [VISION.md](./VISION.md) - Design principles and goals
