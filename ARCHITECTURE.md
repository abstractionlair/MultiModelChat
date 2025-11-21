# Multi-Model Chat: Architecture Design

## Vision

A multi-user, multi-device chat system orchestrating parallel conversations with multiple AI models, featuring project-based organization, intelligent context management, and flexible retrieval mechanisms.

## Core Principles

1. **SQL for operational state** (config, sessions, metadata) - concurrent, queryable, scales to multi-user
2. **Flexible retrieval over prescriptive RAG** - Don't commit early to embeddings/vector search; "retrieval" means "mechanism for surfacing useful data"
3. **Model-aware context management** - Different models get different context based on capability and cost
4. **Unified retrieval** - Same mechanism for project files and conversation history
5. **Export as portability** - SQL is source of truth, export to files for sharing/backup

## Data Model

### ID Generation Strategy

All primary keys use **ULID** (Universally Unique Lexicographically Sortable Identifier):
- Sortable by creation time (unlike UUID v4)
- URL-safe, case-insensitive
- 26 characters (vs 36 for UUID)
- Example: `01HQVJX9KF3T0Q2Z8W1MXNBR4C`

```javascript
const { ulid } = require('ulid');

function newId(prefix = '') {
  const id = ulid();
  return prefix ? `${prefix}_${id}` : id;
}
```

### SQLite Schema

```sql
-- ============================================================================
-- Configuration & Users
-- ============================================================================

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT,              -- JSON-encoded configuration
  updated_at INTEGER
);

-- Future: multi-user support
-- CREATE TABLE users (
--   id TEXT PRIMARY KEY,
--   name TEXT,
--   api_keys TEXT,        -- Encrypted JSON
--   preferences TEXT,     -- JSON
--   created_at INTEGER
-- );

-- ============================================================================
-- Projects
-- ============================================================================

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  settings TEXT,           -- JSON: {
                           --   default_models: [...],
                           --   context_strategy: 'smart'|'balanced'|'minimal',
                           --   max_context_tokens: number,
                           --   retrieval_config: {...}
                           -- }
  created_at INTEGER,
  updated_at INTEGER
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
  content_hash TEXT,       -- For change detection
  mime_type TEXT,
  size_bytes INTEGER,
  metadata TEXT,           -- JSON: {
                           --   always_in_context: boolean,
                           --   retrieval_eligible: boolean,
                           --   tool_accessible: boolean,
                           --   tags: string[],
                           --   summary: string (optional, for smart context)
                           -- }
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, path) -- Prevent duplicate paths within a project
);

CREATE INDEX idx_project_files_project ON project_files(project_id);
CREATE INDEX idx_project_files_path ON project_files(project_id, path);

-- ============================================================================
-- Conversations (write-once message storage for scalability)
-- ============================================================================

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT,              -- Auto-generated or user-set
  summary TEXT,            -- Auto-generated summary (updated every ~10 rounds)
  context_state TEXT,      -- JSON: tracks what's in working context
  created_at INTEGER,
  updated_at INTEGER,
  round_count INTEGER,     -- Denormalized for quick queries
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Write-once message storage (avoids rewriting full JSON blob on every turn)
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  speaker TEXT NOT NULL,   -- 'user' or 'agent:model-id'
  content TEXT NOT NULL,
  metadata TEXT,           -- JSON: { modelId?, agentId?, usage?, ts, attachments? }
  created_at INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_conversation ON conversation_messages(conversation_id, round_number);
CREATE INDEX idx_messages_speaker ON conversation_messages(conversation_id, speaker);

-- View for backward compatibility and easy round aggregation
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

CREATE INDEX idx_conversations_project ON conversations(project_id);
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

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
  capabilities TEXT,       -- JSON: {
                           --   tools: boolean,
                           --   vision: boolean,
                           --   streaming: boolean,
                           --   thinking: boolean
                           -- }
  updated_at INTEGER,
  PRIMARY KEY (provider, model_id)
);

-- Seed with initial data, update periodically from provider APIs

-- ============================================================================
-- Generic Retrieval Index (mechanism-agnostic)
-- ============================================================================

-- Chunks table: stores segmented content with precise location pointers
CREATE TABLE content_chunks (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,     -- 'file' | 'conversation_message'
  source_id TEXT NOT NULL,       -- file.id or message.id
  project_id TEXT NOT NULL,
  chunk_index INTEGER,           -- Order within source
  content TEXT NOT NULL,         -- The chunk text
  location TEXT,                 -- JSON: {
                                 --   file chunks: { path, start_line, end_line, start_char, end_char }
                                 --   conversation: { round_number, speaker }
                                 -- }
  summary TEXT,                  -- Brief description of chunk content (for smart model hints)
  token_count INTEGER,           -- Approximate size
  created_at INTEGER,
  -- Foreign key constraints with cascading deletes
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_chunks_source ON content_chunks(source_type, source_id);
CREATE INDEX idx_chunks_project ON content_chunks(project_id);

-- Trigger to cleanup chunks when source is deleted
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

-- Start with FTS5, can migrate to embeddings/hybrid later
CREATE VIRTUAL TABLE retrieval_index USING fts5(
  chunk_id UNINDEXED,      -- References content_chunks.id (not searchable)
  project_id UNINDEXED,    -- For filtering (not searchable)
  content,                 -- The searchable text
  metadata UNINDEXED,      -- JSON: additional search metadata (not searchable)
  tokenize = 'porter unicode61'
);

-- Note: FTS5 tables don't support foreign keys; use triggers for cleanup
CREATE TRIGGER cleanup_fts_chunks
AFTER DELETE ON content_chunks
BEGIN
  DELETE FROM retrieval_index WHERE chunk_id = OLD.id;
END;

-- Future: add vector embeddings table
-- CREATE TABLE embeddings (
--   id TEXT PRIMARY KEY,
--   source_type TEXT,
--   source_id TEXT,
--   chunk_id TEXT,
--   embedding BLOB,        -- Vector representation
--   model TEXT             -- Which embedding model used
-- );

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

## Context Management Strategy

### Model Tiers

Models are classified into tiers based on capability and cost:

- **Smart** (GPT-4, Claude Opus/Sonnet, Gemini 2.5 Pro): Large context, tool use, can make retrieval decisions
- **Balanced** (GPT-4o, Claude Sonnet): Good context, tools, mid-tier cost
- **Fast** (GPT-4o-mini, Gemini Flash): Smaller context, fast, cheaper
- **Cheap** (Haiku, older models): Minimal context, lowest cost

### Context Assembly Per Turn

For each model in a turn, assemble context based on tier:

#### 1. Always-Included Files
```sql
SELECT content FROM project_files
WHERE project_id = ?
AND json_extract(metadata, '$.always_in_context') = true;
```

#### 2. Working Context (Recent Conversation)
- **Smart models**: Last 20 rounds
- **Balanced models**: Last 10 rounds
- **Fast/Cheap models**: Last 5 rounds

#### 3. Retrieved Context (History + Files)

**For Smart Models** (agentic approach):
- Run retrieval query against current user message
- Return summaries with **precise pointers** (file path + line ranges, or conversation round)
- Models use existing `read_project_file(path, start_line, end_line)` tool to read what they need
- For conversation rounds: include full content in summary (usually small)
- Model decides what to read in full
- Reduces wasted context, gives model agency

**Example smart model context:**
```
Retrieved Context:
1. [File: docs/auth-flow.md, lines 45-67] JWT token validation and expiration handling (estimated 235 tokens)
2. [Conversation: Round 47, user] "How do we handle expired tokens in the mobile app?"
3. [File: api/endpoints.md, lines 120-145] POST /auth/refresh endpoint documentation (estimated 312 tokens)

Use read_project_file(path, start_line, end_line) to read sections that would be helpful.
```

**For Balanced/Fast/Cheap Models** (pre-populated approach):
- Run retrieval query
- Insert full content of top N results directly into context
- No tool use, simpler prompt
- More predictable cost

### Retrieval Query Strategy

```javascript
// Pseudo-code for retrieval with FTS injection protection
function retrieveRelevantContext(projectId, userMessage, conversationId, limit = 10) {
  // Escape FTS5 query syntax to prevent injection
  const escapedQuery = escapeFTS5Query(userMessage);

  // Guard against null conversationId
  const excludeConvClause = conversationId
    ? `AND c.source_id != ?`
    : '';

  // Search across both files and conversation history, return precise locations
  const query = `
    SELECT
      c.id,
      c.source_type,
      c.source_id,
      c.chunk_index,
      c.content,
      c.location,
      c.summary,
      c.token_count,
      idx.rank
    FROM retrieval_index idx
    JOIN content_chunks c ON idx.chunk_id = c.id
    WHERE c.project_id = ?
      AND retrieval_index MATCH ?  -- Correct FTS5 MATCH syntax
      ${excludeConvClause}
    ORDER BY rank
    LIMIT ?
  `;

  const params = conversationId
    ? [projectId, escapedQuery, conversationId, limit]
    : [projectId, escapedQuery, limit];

  const results = db.all(query, params);

// FTS5 query escaping to prevent syntax errors and injection
function escapeFTS5Query(query) {
  if (!query || typeof query !== 'string') return '""';

  // Remove or escape FTS5 operators: AND, OR, NOT, NEAR, *, (, ), "
  // Strategy: wrap in double quotes for literal search
  const cleaned = query
    .replace(/"/g, '""')  // Escape quotes
    .trim();

  return `"${cleaned}"`;  // Return as phrase search
}

  // Format results with precise pointers
  return results.map(r => {
    const loc = JSON.parse(r.location);
    if (r.source_type === 'file') {
      return {
        type: 'file',
        path: loc.path,
        lines: `${loc.start_line}-${loc.end_line}`,
        summary: r.summary || r.content.substring(0, 100) + '...',
        tokens: r.token_count
      };
    } else {
      return {
        type: 'conversation',
        round: loc.round_number,
        speaker: loc.speaker,
        content: r.content,  // Include full content for conversation rounds (usually smaller)
        tokens: r.token_count
      };
    }
  });
}
```

### Token Estimation Utility

Shared utility for consistent token counting across the system:

```javascript
// Rough approximation: ~4 characters per token for English text
// More accurate: use tiktoken for OpenAI, anthropic-tokenizer for Claude
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // Simple heuristic: 1 token ≈ 4 chars
  return Math.ceil(text.length / 4);
}

// For production, use provider-specific tokenizers:
// const { encode } = require('gpt-tokenizer');  // For OpenAI
// const tokens = encode(text).length;
```

### Context Budget Management

Track token usage to stay within model limits:

```javascript
function assembleContext(modelMetadata, projectId, conversationId, userMessage) {
  const budget = modelMetadata.context_window - modelMetadata.max_output_tokens - SAFETY_MARGIN;
  let used = 0;

  // Priority order:
  // 1. System prompt
  // 2. Always-included files
  // 3. Recent conversation rounds
  // 4. Retrieved context (files + history)

  // If approaching limit: drop oldest retrieved context first, then old conversation rounds
}
```

### Automatic Context Pruning

When conversation grows beyond working context size:
- Recent rounds stay in "working context"
- Older rounds indexed in `retrieval_index`
- Retrieved back when relevant
- Effectively infinite context via retrieval

## Retrieval Mechanism Evolution

### Phase 1: Full-Text Search (FTS5)
- SQLite built-in
- Fast, no dependencies
- Good for keyword search
- BM25 ranking

### Phase 2: Hybrid Search
- FTS5 for keywords
- Add embeddings table
- Combine scores (e.g., 0.7 * semantic + 0.3 * keyword)
- Rerank top results

### Phase 3: Advanced Retrieval
- Multi-query retrieval
- Hypothetical document embeddings
- Graph-based connections (conversations that reference same files)
- Temporal relevance (recent vs historical)

## API Endpoints (additions)

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
- `DELETE /api/projects/:id/files/:fileId` - Delete file
- `PATCH /api/projects/:id/files/:fileId/metadata` - Update file metadata

### Conversations
- `GET /api/projects/:projectId/conversations` - List conversations in project
- `GET /api/conversations/:id` - Get conversation (already exists)
- `POST /api/conversations/:id/export` - Export to file (Markdown/JSON)
- `DELETE /api/conversations/:id` - Delete conversation
- `PUT /api/conversations/:id/title` - Set conversation title

### Search
- `POST /api/projects/:projectId/search` - Search files and conversations
- `POST /api/search/global` - Search across all projects

### Models
- `GET /api/models/metadata` - Get model capabilities, costs, context limits
- `POST /api/models/metadata/refresh` - Update from provider APIs

## Model-Specific Tools

For smart models, provide tools to access project files and perform recursive searches:

```javascript
// File access tool - supports reading specific ranges
{
  name: "read_project_file",
  description: "Read a file from the current project. You can optionally specify line ranges to read specific sections mentioned in retrieval results.",
  parameters: {
    path: {
      type: "string",
      description: "Relative file path like 'docs/api.md' (no .. or absolute paths)"
    },
    start_line: {
      type: "number",
      description: "Optional: first line to read (1-indexed)",
      optional: true
    },
    end_line: {
      type: "number",
      description: "Optional: last line to read (inclusive)",
      optional: true
    }
  }
}

// Implementation must validate paths:
function validateProjectPath(path) {
  // Prevent directory traversal
  if (path.includes('..') || path.startsWith('/')) {
    throw new Error('Invalid path: must be relative within project');
  }
  // Normalize to prevent tricks like "foo/./../../etc"
  const normalized = path.normalize(path);
  if (normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error('Invalid path after normalization');
  }
  return normalized;
}

// List available files
{
  name: "list_project_files",
  description: "List all files in the current project, optionally filtered by path prefix or tags.",
  parameters: {
    prefix: { type: "string", optional: true },
    tags: { type: "array", items: { type: "string" }, optional: true }
  }
}

// Agentic search - allows smart models to refine retrieval
{
  name: "search_project",
  description: "Search project files and conversation history for specific information. Use this when you need to find something specific that wasn't in the initial retrieval results.",
  parameters: {
    query: {
      type: "string",
      description: "Search query (plain text, will be processed for relevance)"
    },
    filter: {
      type: "object",
      optional: true,
      properties: {
        file_types: { type: "array", items: { type: "string" } },
        paths: { type: "array", items: { type: "string" } },
        exclude_conversations: { type: "boolean" }
      }
    },
    limit: {
      type: "number",
      optional: true,
      description: "Max results to return (default: 10)"
    }
  }
}
```

### Why Agentic Search?

The system performs automatic retrieval based on the user's message, but smart models may realize they need additional context after seeing initial results. For example:
- Initial query: "How do we handle authentication?"
- Retrieved: General auth flow docs
- Model realizes: "I need the specific JWT refresh implementation"
- Model calls: `search_project("JWT refresh token implementation")`

This closes the loop on model autonomy and prevents "lost in the middle" scenarios where relevant info exists but wasn't surfaced initially.

## System Prompt Template

### Base System Prompt (All Models)

```
You are {{modelId}} in a multi-model conversation with one user and multiple AI models.

This conversation involves parallel responses from different models. You'll see the full conversation history: each user message followed by other models' replies tagged in brackets (e.g., [ModelName]: ...). Your own previous replies appear as assistant messages.

Respond directly to the user and other models as appropriate. Replies are collected in parallel; do not claim to "go first" or reference response order.

PROJECT CONTEXT
You are working in the "{{projectName}}" project.

Project Structure:
- files/          User's project files (docs, data, code, etc.) - READ ONLY
- tools/          Reusable Python functions you and other models have written - READ/WRITE
- conversations/  Past conversation transcripts - managed by system

AVAILABLE CAPABILITIES
{{#if hasCodeExecution}}
CODE EXECUTION:
You have access to a Python code execution environment with the project filesystem mounted at /project/

Available Python libraries: os, sys, re, json, csv, math, datetime, pathlib, collections
Project files are mounted read-only at: /project/files/
Tools directory (read/write) at: /project/tools/

To execute code, use a Python code block. The code will run in a sandboxed environment and results will be returned to you.

WORKING WITH PROJECT FILES:
- Read files: open('/project/files/docs/api.md', 'r')
- List files: os.listdir('/project/files/')
- Parse data: Use standard library (csv, json, re) to analyze files
- Combine sources: Read multiple files and cross-reference

CREATING REUSABLE TOOLS:
When you write useful functions that might be needed again, save them to /project/tools/

Best practices for tools:
1. Use descriptive names: parse_auth_logs.py, extract_api_errors.py
2. Include docstrings: Explain what the function does, parameters, and return values
3. Keep focused: Each tool should do one thing well
4. Add examples: Show usage in docstring or comments

Example tool structure:
```python
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
    with open(filepath) as f:
        reader = csv.DictReader(f)
        results = list(reader)
        if filter_status:
            results = [r for r in results if r['status'] == filter_status]
        return results

# Save to tools directory
with open('/project/tools/parse_auth_log.py', 'w') as f:
    f.write(code)
```

USING EXISTING TOOLS:
{{#if projectTools.length}}
Available tools in this project:
{{#each projectTools}}
- {{this.path}}: {{this.description}}
{{/each}}

Import with: from {{toolName}} import {{functionName}}
{{else}}
No project tools yet. Consider creating reusable functions for common operations.
{{/if}}

WHY CREATE TOOLS:
- This project may have 200k+ tokens of context
- You'll encounter similar patterns across conversations
- Other models (and future you) benefit from well-documented utilities
- Tools reduce repetitive code and improve consistency

TOOL DISCOVERY:
Write clear docstrings! When you or other models need functionality, tool descriptions help identify relevant existing code. Good naming and documentation make tools discoverable.
{{/if}}

{{#if projectFiles.alwaysInContext}}
ALWAYS-INCLUDED CONTEXT:
The following files are marked as always-included and contain important project information:
{{#each projectFiles.alwaysInContext}}
- {{this.path}}: {{this.description}}
{{/each}}
{{/if}}

{{#if retrievalResults}}
RETRIEVED CONTEXT:
Based on the current query, the following relevant information was found:

{{#each retrievalResults}}
{{#if this.type == 'file'}}
{{this.index}}. [File: {{this.path}}, lines {{this.lines}}] {{this.summary}} (~{{this.tokens}} tokens)
{{else if this.type == 'conversation'}}
{{this.index}}. [Conversation: Round {{this.round}}, {{this.speaker}}] {{this.content}}
{{/if}}
{{/each}}

Use code execution to read specific sections or analyze this content further.
{{/if}}

{{#if projectFiles.available}}
PROJECT FILES ({{projectFiles.count}} total):
{{#if projectFiles.count <= 50}}
{{#each projectFiles.available}}
- {{this.path}} ({{this.size}}){{#if this.description}} - {{this.description}}{{/if}}
{{/each}}
{{else}}
Top-level directories:
{{#each projectFiles.directories}}
- {{this.path}}/ ({{this.fileCount}} files)
{{/each}}

Use os.listdir() or os.walk() to explore the full structure.
{{/if}}
{{/if}}

CONVERSATION CONTEXT:
{{#if conversationInfo}}
This is round {{conversationInfo.currentRound}} of conversation "{{conversationInfo.title}}".
{{#if conversationInfo.totalRounds > 20}}
Note: This conversation has {{conversationInfo.totalRounds}} total rounds. Recent rounds are shown below; earlier context available via retrieval or conversation transcripts.
{{/if}}
{{/if}}
```

### Provider-Specific Additions

```javascript
// Append to base prompt based on provider
const providerPrompts = {
  openai: `
REASONING:
You have extended thinking capabilities. Use them for complex analysis, debugging, or planning multi-step solutions.
`,

  anthropic: `
EXTENDED THINKING:
You can use extended thinking for complex reasoning. This is valuable for:
- Analyzing large codebases or datasets
- Debugging intricate issues
- Planning multi-step solutions
- Evaluating tradeoffs
`,

  google: `
{{#if hasGrounding}}
WEB SEARCH:
You have access to Google Search grounding for current information and citations. Other models in this conversation may not have this capability - you can offer to search for current information when relevant.
{{/if}}
`,

  xai: ``
};
```

### Dynamic Assembly

```javascript
function buildSystemPrompt(context) {
  const {
    modelId,
    projectName,
    hasCodeExecution,
    projectTools,
    projectFiles,
    retrievalResults,
    conversationInfo,
    provider
  } = context;

  // Compile base template with context
  let prompt = compileTemplate(baseSystemPrompt, {
    modelId,
    projectName,
    hasCodeExecution,
    projectTools,
    projectFiles,
    retrievalResults,
    conversationInfo
  });

  // Add provider-specific additions
  if (providerPrompts[provider]) {
    prompt += '\n\n' + compileTemplate(providerPrompts[provider], context);
  }

  // Add user's custom project-level prompt if set
  if (context.customPrompt) {
    prompt += '\n\n' + context.customPrompt;
  }

  return prompt;
}
```

## Code Execution Lifecycle

### Materializing Context (Before Execution)

When code execution is triggered, we need to materialize database content into a filesystem:

```javascript
async function materializeProjectForExecution(projectId, sessionId) {
  const tempDir = `/tmp/project_${sessionId}`;

  // Create directory structure
  await fs.mkdir(`${tempDir}/files`, { recursive: true });
  await fs.mkdir(`${tempDir}/tools`, { recursive: true });

  // Load project files from DB
  const files = await db.all(
    'SELECT path, content, content_location FROM project_files WHERE project_id = ?',
    [projectId]
  );

  for (const file of files) {
    const fullPath = path.join(tempDir, 'files', file.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Use content from DB or load from disk storage
    const content = file.content || await fs.readFile(file.content_location);
    await fs.writeFile(fullPath, content);
  }

  return tempDir;
}
```

### Persisting Changes (After Execution)

Detect and save new tools created during execution:

```javascript
async function persistToolsAfterExecution(projectId, tempDir) {
  const toolsDir = path.join(tempDir, 'tools');
  const toolFiles = await fs.readdir(toolsDir, { recursive: true });

  for (const filename of toolFiles) {
    const toolPath = path.join(toolsDir, filename);
    const content = await fs.readFile(toolPath, 'utf-8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // Check if file exists or changed
    const existing = await db.get(
      'SELECT content_hash FROM project_files WHERE project_id = ? AND path = ?',
      [projectId, `tools/${filename}`]
    );

    if (!existing || existing.content_hash !== hash) {
      // Upsert the tool
      await db.run(`
        INSERT INTO project_files (id, project_id, path, content, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, path) DO UPDATE SET
          content = excluded.content,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `, [newId(), projectId, `tools/${filename}`, content, hash, Date.now()]);

      // Trigger reindexing
      await queueForIndexing('file', fileId);
    }
  }
}
```

## Indexing Pipeline

### On File/Message Creation or Update

```javascript
// Triggered by file upload, tool creation, or message insertion
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

  // Chunk the content
  const chunks = chunkContent(content, sourceType, metadata);

  // Insert chunks
  for (const chunk of chunks) {
    const chunkId = newId();
    await db.run(`
      INSERT INTO content_chunks (id, source_type, source_id, project_id, chunk_index, content, location, token_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [chunkId, sourceType, sourceId, metadata.projectId, chunk.index, chunk.content,
        JSON.stringify(chunk.location), chunk.tokenCount, Date.now()]);

    // Index in FTS5
    await db.run(`
      INSERT INTO retrieval_index (chunk_id, project_id, content, metadata)
      VALUES (?, ?, ?, ?)
    `, [chunkId, metadata.projectId, chunk.content, JSON.stringify(chunk.metadata)]);
  }
}

// Chunking strategy for files (line-based, can evolve to semantic)
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
          end_line: Math.min(i + chunkSize, lines.length),
          start_char: content.split('\n').slice(0, i).join('\n').length,
          end_char: content.split('\n').slice(0, i + chunkSize).join('\n').length
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

### Background Reindexing

```javascript
// Rebuild entire index (for migrations or corruption recovery)
async function rebuildIndex(projectId) {
  // Clear existing chunks and index for project
  await db.run('DELETE FROM content_chunks WHERE project_id = ?', [projectId]);

  // Reindex all files
  const files = await db.all('SELECT id FROM project_files WHERE project_id = ?', [projectId]);
  for (const file of files) {
    await indexContent('file', file.id);
  }

  // Reindex all conversation messages
  const messages = await db.all(`
    SELECT m.id
    FROM conversation_messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE c.project_id = ?
  `, [projectId]);

  for (const msg of messages) {
    await indexContent('conversation_message', msg.id);
  }
}
```

## Storage Strategy: Hybrid Approach

### Small Files (< 1MB): Store in SQLite
- Fast retrieval
- Simplifies backups
- No external dependencies

### Large Files (> 1MB): Store on Disk
```javascript
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage');

async function saveFile(projectId, filePath, content) {
  const sizeBytes = Buffer.byteLength(content);
  const threshold = 1024 * 1024; // 1MB

  if (sizeBytes < threshold) {
    // Store in DB
    await db.run(`
      INSERT INTO project_files (id, project_id, path, content, size_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `, [newId(), projectId, filePath, content, sizeBytes, Date.now()]);
  } else {
    // Store on disk
    const storageId = crypto.randomBytes(16).toString('hex');
    const storagePath = path.join(STORAGE_DIR, storageId);
    await fs.writeFile(storagePath, content);

    await db.run(`
      INSERT INTO project_files (id, project_id, path, content_location, size_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET content_location = excluded.content_location, updated_at = excluded.updated_at
    `, [newId(), projectId, filePath, storagePath, sizeBytes, Date.now()]);
  }
}
```

## Implementation Phases (Revised for Incrementality)

### Phase 1a: SQLite Foundations (Week 1)
**Goal**: Move from in-memory to persistent storage while keeping existing API shape

- [ ] Install better-sqlite3, ulid dependencies
- [ ] SQLite setup: `data.db` with WAL mode enabled
- [ ] Schema: projects, conversations, conversation_messages tables only
- [ ] Migrate existing in-memory conversations Map to SQLite on startup
- [ ] Update `/api/turn` to insert into conversation_messages instead of rounds array
- [ ] Update `/api/conversation/:id` to read from conversation_messages and reconstruct rounds
- [ ] Keep existing transcript export working
- [ ] Basic project support: default project auto-created, all conversations belong to it
- [ ] Config table for storing model selections and prompts (replace env var defaults)

**Success criteria**: Restart server, conversations persist; existing UI works unchanged

### Phase 1b: Project Files + Basic Retrieval (Week 2)
**Goal**: Add file management and simple search without code execution yet

- [ ] project_files table with hybrid storage (< 1MB in DB, > 1MB on disk)
- [ ] File upload API: `POST /api/projects/:id/files`
- [ ] File read/list APIs for UI
- [ ] content_chunks table + FTS5 retrieval_index
- [ ] Indexing pipeline: chunk files on upload, index messages on conversation turn
- [ ] Token estimation utility (estimateTokens function)
- [ ] Simple search endpoint: `POST /api/projects/:id/search`
- [ ] Update system prompt to list available files (no code execution yet)
- [ ] FTS5 escaping and path validation

**Success criteria**: Upload files to project, search finds relevant chunks, models see file list

### Phase 1c: Code Execution (Week 3-4)
**Goal**: Add Pyodide code execution with tool persistence

- [ ] Pyodide integration for Python code execution
- [ ] Materialize project files to virtual filesystem before execution
- [ ] Execute code in sandboxed environment
- [ ] Persist new tools from /project/tools/ back to project_files
- [ ] Update system prompt with code execution guidance (tools/, best practices)
- [ ] Model tier mapping (smart vs balanced vs fast)
- [ ] Code execution lifecycle hooks integrated into `/api/turn`

**Success criteria**: Models can execute Python, read files, create reusable tools that persist

**Note**: Phase 1c is optional for initial deployment. Can deploy Phase 1a+1b for a working file-aware chat system, add code execution later.

### Phase 2: Project Files
- [ ] File upload/management API
- [ ] File metadata tagging UI
- [ ] Load "always_in_context" files into turns
- [ ] Simple file browser in UI

### Phase 3: Basic Retrieval
- [ ] FTS5 index for files and conversations
- [ ] Index conversations as they're created
- [ ] Simple search endpoint
- [ ] Conversation search UI

### Phase 4: Smart Context Management
- [ ] Model-tier-aware context assembly
- [ ] Working context + retrieval integration
- [ ] For smart models: summary + tool approach
- [ ] For other models: direct insertion
- [ ] Token budget tracking

### Phase 5: Advanced Retrieval
- [ ] Embeddings generation
- [ ] Hybrid search (keyword + semantic)
- [ ] Reranking
- [ ] Query expansion

### Phase 6: Automatic Context Pruning
- [ ] Drop old rounds from working context
- [ ] Retrieve historical rounds when relevant
- [ ] UI indicator for "context window status"

## Multi-User & Concurrency Considerations

### SQLite WAL Mode
Enable Write-Ahead Logging for better concurrent read performance:

```javascript
const Database = require('better-sqlite3');
const db = new Database('data.db');

// Enable WAL mode
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');  // Balance safety and performance
db.pragma('busy_timeout = 5000');   // Wait up to 5s for locks
```

### Connection Pooling (For Multi-User Server)

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
      // Wait for available connection
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

### Write Conflict Handling

```javascript
function withRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return fn();
    } catch (err) {
      if (err.code === 'SQLITE_BUSY' && i < maxRetries - 1) {
        // Exponential backoff
        const delay = Math.pow(2, i) * 100;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}
```

### Scaling Beyond SQLite

For true multi-user at scale (100+ concurrent users), consider migration path:
- **PostgreSQL**: Drop-in replacement with better concurrency
- **Keep SQLite for single-user/local mode**: Maintain portability
- **Schema designed to be DB-agnostic**: Uses standard SQL, minimal SQLite-specific features

## Conversation Summaries

Auto-generate conversation summaries for quick scanning:

```javascript
// After every ~10 rounds, generate a summary
async function maybeUpdateConversationSummary(conversationId) {
  const conv = await db.get('SELECT round_count, summary FROM conversations WHERE id = ?', [conversationId]);

  // Update every 10 rounds
  if (conv.round_count % 10 === 0) {
    const recentMessages = await db.all(`
      SELECT speaker, content
      FROM conversation_messages
      WHERE conversation_id = ?
        AND round_number >= ?
      ORDER BY round_number
      LIMIT 20
    `, [conversationId, Math.max(1, conv.round_count - 20)]);

    // Use a fast, cheap model for summarization
    const prompt = `Summarize this conversation in 2-3 sentences, focusing on key topics and decisions:\n\n${formatMessages(recentMessages)}`;
    const summary = await callCheapModel(prompt);

    await db.run('UPDATE conversations SET summary = ? WHERE id = ?', [summary, conversationId]);
  }
}
```

Use summaries for:
- Conversation browsing UI (show summaries instead of full text)
- Quick context when models reference past conversations
- Search result previews

## Embeddings Strategy (Phase 4+)

### Local Embeddings for Privacy

Instead of calling OpenAI/Google embedding APIs:

```javascript
const ort = require('onnxruntime-node');

class LocalEmbedder {
  constructor() {
    // Load quantized model (e.g., all-MiniLM-L6-v2)
    this.session = await ort.InferenceSession.create('models/embeddings.onnx');
  }

  async embed(text) {
    // Tokenize and run inference
    const tokens = this.tokenize(text);
    const feeds = { input_ids: new ort.Tensor('int64', tokens, [1, tokens.length]) };
    const results = await this.session.run(feeds);
    return Array.from(results.embeddings.data);  // Float array
  }
}
```

### Hybrid Search

Combine keyword (FTS5) and semantic (embeddings):

```javascript
async function hybridSearch(projectId, query, limit = 10) {
  // Keyword search (FTS5)
  const keywordResults = await fts5Search(projectId, query, limit * 2);

  // Semantic search (embeddings)
  const queryEmbedding = await embedder.embed(query);
  const semanticResults = await vectorSearch(projectId, queryEmbedding, limit * 2);

  // Combine and rerank (e.g., 70% semantic, 30% keyword)
  const combined = mergeResults(keywordResults, semanticResults, { semantic: 0.7, keyword: 0.3 });

  return combined.slice(0, limit);
}
```

Benefits of local embeddings:
- ✅ Privacy: No text sent to external APIs
- ✅ Cost: One-time model download, free after
- ✅ Speed: Local inference is fast
- ✅ Portability: Works offline

## Model Tier Mapping

Configuration layer to map real model IDs to tiers and capabilities:

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
  return MODEL_TIERS[modelId] || 'balanced';  // Default to balanced
}

function supportsCodeExecution(modelId) {
  const tier = getModelTier(modelId);
  return tier === 'smart' || tier === 'balanced';
}
```

## Decisions (Codified to Avoid Breaking Changes)

1. **Model metadata**: Manual updates initially; add `/api/models/refresh` endpoint for on-demand updates from provider APIs
2. **Retrieval summaries**: Extract heuristically (first N chars + location info); Phase 4+ can add model-generated summaries
3. **Multi-user**: Add `user_id` columns in Phase 2; Phase 1 is single-user with foundations for multi-user
4. **File versioning**: Not in Phase 1; consider in Phase 3 if needed (add `version` column, keep old versions)
5. **Conversation branching**: Not in Phase 1; add in Phase 4+ with `parent_message_id` in conversation_messages
6. **Collaborative projects**: Phase 3+; requires real-time sync (WebSocket) and conflict resolution
7. **Cost tracking**: Add in Phase 2; track token usage per conversation/project, surface in UI
8. **Rate limiting**: Phase 2+; use Redis or in-memory store with per-project/user limits

## Open Questions (Remaining)

1. **Code execution isolation**: Pyodide (WASM) vs Docker vs E2B for production?
2. **Large file handling**: What's the size threshold for disk storage? 1MB? 10MB?
3. **Embedding model**: Which local model for Phase 4? all-MiniLM-L6-v2 or larger?
4. **Real-time updates**: WebSocket for live conversation updates across tabs/users?

## Future Enhancements

- **Conversation branching**: Fork at any round to explore alternate paths
- **Collaborative editing**: Real-time updates via WebSocket
- **Scheduled conversations**: Cron-like triggers for recurring interactions
- **Model routing**: Auto-select models based on query complexity/cost
- **Custom tools**: User-defined tools for models (API integrations, code execution)
- **Conversation templates**: Starter prompts and file sets for common tasks
- **Analytics dashboard**: Token usage, costs, model performance over time
