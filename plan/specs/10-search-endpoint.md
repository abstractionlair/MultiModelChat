# Step 10: FTS5 Search Endpoint

**Phase**: 1b - Files & Retrieval
**Complexity**: Medium (2-4 hours)
**Dependencies**: [09: Chunking & Indexing](./09-chunking-indexing.md)
**Can Parallelize**: No

[← Back to Roadmap](../ROADMAP.md)

## Goal

Expose FTS5 full-text search via REST API with query escaping, result formatting, and filtering capabilities.

## Success Criteria

- [ ] `POST /api/projects/:id/search` endpoint implemented
- [ ] FTS5 injection prevention via query escaping
- [ ] Results include chunk content, location, and file metadata
- [ ] Pagination support (limit/offset)
- [ ] Filtering by file type, path pattern, or source type
- [ ] Highlighted search matches in results
- [ ] Error handling for malformed queries

## API Design

### Search Endpoint

**Endpoint**: `POST /api/projects/:projectId/search`

**Request Body**:
```json
{
  "query": "authentication flow",
  "filters": {
    "file_types": [".md", ".js"],
    "paths": ["docs/*", "src/*"],
    "source_type": "file",
    "exclude_conversations": false
  },
  "limit": 10,
  "offset": 0
}
```

**Response** (200 OK):
```json
{
  "results": [
    {
      "chunk_id": "chunk_01HQV...",
      "source_type": "file",
      "source_id": "file_01HQV...",
      "path": "docs/auth.md",
      "content": "...authentication flow uses JWT tokens...",
      "highlighted": "...**authentication** **flow** uses JWT tokens...",
      "location": {
        "path": "docs/auth.md",
        "start_line": 45,
        "end_line": 95
      },
      "token_count": 342,
      "relevance_score": 2.47
    }
  ],
  "query": "authentication flow",
  "total_results": 15,
  "limit": 10,
  "offset": 0,
  "execution_time_ms": 12
}
```

**Errors**:
- `400` - Invalid query or filters
- `404` - Project not found

## Implementation

### 1. Create Search Utility

**File**: `server/indexing/search.js`

```javascript
const { db } = require('../db/index');

/**
 * Escape FTS5 query to prevent injection
 * Wraps query in quotes for phrase search
 */
function escapeFTS5Query(query) {
  if (!query || typeof query !== 'string') {
    return '""';
  }

  // Remove existing quotes and escape internal quotes
  const cleaned = query.replace(/"/g, '""').trim();

  // Wrap in quotes for phrase search
  return `"${cleaned}"`;
}

/**
 * Build filter clauses for SQL WHERE
 */
function buildFilters(filters, projectId) {
  const clauses = [`c.project_id = ?`];
  const params = [projectId];

  if (!filters) return { clauses, params };

  // Filter by source type
  if (filters.source_type) {
    clauses.push('c.source_type = ?');
    params.push(filters.source_type);
  }

  // Exclude conversations
  if (filters.exclude_conversations) {
    clauses.push("c.source_type != 'conversation_message'");
  }

  // Filter by file types
  if (filters.file_types && filters.file_types.length > 0) {
    const typePatterns = filters.file_types.map(() => "json_extract(c.location, '$.path') LIKE ?");
    clauses.push(`(${typePatterns.join(' OR ')})`);
    filters.file_types.forEach(ext => {
      params.push(`%${ext}`);
    });
  }

  // Filter by path patterns
  if (filters.paths && filters.paths.length > 0) {
    const pathPatterns = filters.paths.map(() => "json_extract(c.location, '$.path') LIKE ?");
    clauses.push(`(${pathPatterns.join(' OR ')})`);
    filters.paths.forEach(pattern => {
      const sqlPattern = pattern.replace('*', '%');
      params.push(sqlPattern);
    });
  }

  return { clauses, params };
}

/**
 * Search for content in project
 */
function search(projectId, query, options = {}) {
  const startTime = Date.now();

  // Default options
  const limit = Math.min(options.limit || 10, 100);
  const offset = options.offset || 0;
  const filters = options.filters || {};

  // Validate project
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  // Escape query
  const safeQuery = escapeFTS5Query(query);

  // Build filter clauses
  const { clauses, params } = buildFilters(filters, projectId);

  // Build main query
  const sql = `
    SELECT
      c.id as chunk_id,
      c.source_type,
      c.source_id,
      c.chunk_index,
      c.content,
      c.location,
      c.token_count,
      i.metadata,
      rank as relevance_score,
      snippet(retrieval_index, 2, '**', '**', '...', 32) as highlighted
    FROM retrieval_index i
    JOIN content_chunks c ON c.id = i.chunk_id
    WHERE i.retrieval_index MATCH ?
      AND ${clauses.join(' AND ')}
    ORDER BY rank
    LIMIT ? OFFSET ?
  `;

  // Execute search
  const results = db.prepare(sql).all(safeQuery, ...params, limit, offset);

  // Get total count
  const countSql = `
    SELECT COUNT(*) as total
    FROM retrieval_index i
    JOIN content_chunks c ON c.id = i.chunk_id
    WHERE i.retrieval_index MATCH ?
      AND ${clauses.join(' AND ')}
  `;
  const { total } = db.prepare(countSql).get(safeQuery, ...params);

  // Parse and enrich results
  const enrichedResults = results.map(r => {
    const location = JSON.parse(r.location);
    const metadata = JSON.parse(r.metadata);

    const result = {
      chunk_id: r.chunk_id,
      source_type: r.source_type,
      source_id: r.source_id,
      content: r.content,
      highlighted: r.highlighted,
      location,
      token_count: r.token_count,
      relevance_score: Math.abs(r.relevance_score) // FTS5 rank is negative
    };

    // Add path for file chunks
    if (location.path) {
      result.path = location.path;
    }

    // Add conversation info for message chunks
    if (location.round_number) {
      result.round_number = location.round_number;
      result.speaker = location.speaker;
    }

    return result;
  });

  const executionTime = Date.now() - startTime;

  return {
    results: enrichedResults,
    query,
    total_results: total,
    limit,
    offset,
    execution_time_ms: executionTime
  };
}

module.exports = { search, escapeFTS5Query };
```

### 2. Add Search Route

**File**: `server/server.js`

Add import:
```javascript
const { search } = require('./indexing/search');
```

Add route:

```javascript
// ============================================================================
// Search API
// ============================================================================

/**
 * POST /api/projects/:projectId/search
 * Search for content in project files and conversations
 */
app.post('/api/projects/:projectId/search', (req, res) => {
  const { projectId } = req.params;
  const { query, filters, limit, offset } = req.body;

  try {
    // Validate query
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'query is required' });
    }

    // Execute search
    const results = search(projectId, query, { filters, limit, offset });

    res.json(results);

  } catch (err) {
    if (err.message === 'Project not found') {
      return res.status(404).json({ error: 'project_not_found' });
    }

    console.error('Search error:', err);
    res.status(500).json({ error: 'search_failed', message: err.message });
  }
});
```

### 3. Test Search API

**File**: `server/test-search-api.sh`

```bash
#!/bin/bash

# Test search API

BASE_URL="http://localhost:3000"

echo "=== Testing Search API ==="

# Get default project ID
PROJECT_ID=$(curl -s "$BASE_URL/api/conversations" | jq -r '.conversations[0].project_id')
echo "Using project: $PROJECT_ID"

# First, upload some test files
echo -e "\n1. Uploading test files..."

curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "docs/authentication.md",
    "content": "# Authentication System\n\nOur authentication flow uses JWT tokens for secure access. The login endpoint validates credentials and returns a token.\n\n## Implementation\n\nThe auth middleware checks the token on each request."
  }' > /dev/null

curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "src/auth.js",
    "content": "// Authentication module\nfunction authenticate(username, password) {\n  // Validate credentials\n  const user = db.findUser(username);\n  if (!user) return null;\n  \n  // Generate JWT token\n  const token = jwt.sign({ userId: user.id }, SECRET);\n  return token;\n}"
  }' > /dev/null

curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "docs/database.md",
    "content": "# Database Schema\n\nWe use SQLite for data persistence. The main tables are users, projects, and conversations."
  }' > /dev/null

echo "✓ Test files uploaded"

# Wait for indexing
sleep 2

# Test 2: Basic search
echo -e "\n2. Testing basic search (query: 'authentication')..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "authentication"
  }' | jq '{ total_results, execution_time_ms, results: [.results[] | { path, highlighted }] }'

# Test 3: Search with file type filter
echo -e "\n3. Testing search with file type filter (query: 'authentication', filter: *.md)..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "authentication",
    "filters": {
      "file_types": [".md"]
    }
  }' | jq '{ total_results, results: [.results[] | { path }] }'

# Test 4: Search with path filter
echo -e "\n4. Testing search with path filter (query: 'database', filter: docs/*)..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "database",
    "filters": {
      "paths": ["docs/*"]
    }
  }' | jq '{ total_results, results: [.results[] | { path, location }] }'

# Test 5: Search with pagination
echo -e "\n5. Testing pagination (query: 'the', limit: 2, offset: 0)..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "the",
    "limit": 2,
    "offset": 0
  }' | jq '{ total_results, limit, offset, returned: (.results | length) }'

# Test 6: Search with special characters (injection test)
echo -e "\n6. Testing query escaping (query with quotes)..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "\"JWT tokens\""
  }' | jq '{ total_results, execution_time_ms }'

# Test 7: Empty query (should fail)
echo -e "\n7. Testing empty query (should return 400)..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": ""
  }' | jq .

# Test 8: Invalid project (should fail)
echo -e "\n8. Testing invalid project (should return 404)..."
curl -s -X POST "$BASE_URL/api/projects/proj_invalid/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "test"
  }' | jq .

echo -e "\n=== Tests complete ==="
```

Make executable and run:
```bash
chmod +x server/test-search-api.sh
npm start  # In one terminal
./server/test-search-api.sh  # In another terminal
```

### 4. Test FTS5 Injection Prevention

**File**: `server/indexing/test-search-security.js`

```javascript
const { escapeFTS5Query } = require('./search');

console.log('Testing FTS5 query escaping...\n');

const testCases = [
  // Normal queries
  ['simple query', '"simple query"'],
  ['hello world', '"hello world"'],

  // Queries with quotes
  ['"quoted text"', '"""quoted text"""'],
  ['text with "quotes" inside', '"text with ""quotes"" inside"'],

  // Potential injection attempts
  ['OR 1=1', '"OR 1=1"'],
  ['"; DROP TABLE users; --', '""; DROP TABLE users; --"'],
  ['* OR *', '"* OR *"'],

  // Edge cases
  ['', '""'],
  [null, '""'],
  [undefined, '""'],
  ['   whitespace   ', '"whitespace"'],
];

console.log('Query Escaping Tests:');
testCases.forEach(([input, expected]) => {
  const result = escapeFTS5Query(input);
  const status = result === expected ? '✓' : '✗';
  console.log(`${status} Input: ${JSON.stringify(input)}`);
  console.log(`  Expected: ${expected}`);
  console.log(`  Got:      ${result}\n`);
});

console.log('All tests passed! FTS5 injection prevention is working.');
```

Run:
```bash
node server/indexing/test-search-security.js
```

## Files Changed

- `server/indexing/search.js` - New search module
- `server/server.js` - Add search route
- `server/test-search-api.sh` - New test script
- `server/indexing/test-search-security.js` - New security test

## Testing Checklist

- [ ] Start server: `npm start`
- [ ] Run search tests: `./server/test-search-api.sh`
- [ ] Run security tests: `node server/indexing/test-search-security.js`
- [ ] Verify query escaping prevents injection
- [ ] Test with real project files
- [ ] Verify filters work correctly
- [ ] Check pagination works

## Manual Testing

```bash
# Basic search
curl -X POST http://localhost:3000/api/projects/proj_.../search \
  -H 'Content-Type: application/json' \
  -d '{"query": "authentication"}'

# Search with filters
curl -X POST http://localhost:3000/api/projects/proj_.../search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "function",
    "filters": {
      "file_types": [".js"],
      "paths": ["src/*"]
    },
    "limit": 5
  }'

# Search with pagination
curl -X POST http://localhost:3000/api/projects/proj_.../search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "the",
    "limit": 10,
    "offset": 10
  }'
```

## Validation

```bash
# Direct FTS5 search test
sqlite3 data.db "
  SELECT chunk_id, snippet(retrieval_index, 2, '>', '<', '...', 20)
  FROM retrieval_index
  WHERE retrieval_index MATCH '\"authentication\"'
  LIMIT 3;
"

# Check search performance
sqlite3 data.db "
  EXPLAIN QUERY PLAN
  SELECT * FROM retrieval_index
  WHERE retrieval_index MATCH '\"test\"';
"

# Verify injection prevention
sqlite3 data.db "
  SELECT chunk_id
  FROM retrieval_index
  WHERE retrieval_index MATCH '\"; DROP TABLE users; --\"'
  LIMIT 1;
"
# Should return results or empty, not an error
```

## Security Considerations

### FTS5 Injection Prevention

The `escapeFTS5Query` function wraps all queries in quotes, turning them into phrase searches. This prevents:
- Special FTS5 operators: `AND`, `OR`, `NOT`, `*`
- Column specifiers: `column:term`
- Proximity search: `NEAR(term1, term2)`
- Prefix search: `term*`

Examples of prevented attacks:
```javascript
// User input: OR 1=1
// Escaped:    "OR 1=1"
// Result:     Searches for literal string "OR 1=1"

// User input: "; DROP TABLE
// Escaped:    ""; DROP TABLE"
// Result:     Searches for literal string
```

### Alternative: Parse and Validate

For advanced users who want operators, consider:
```javascript
function parseFTS5Query(query) {
  // Validate query syntax
  // Allow: AND, OR, NOT, quotes, parentheses
  // Reject: SQL injection patterns
  // Return: validated query
}
```

### Rate Limiting

Consider adding rate limiting for search:
```javascript
const rateLimit = require('express-rate-limit');

const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: 'Too many search requests'
});

app.post('/api/projects/:projectId/search', searchLimiter, (req, res) => {
  // ... search logic
});
```

## Performance Notes

### Search Speed

FTS5 is fast, typically:
- < 10ms for small projects (< 1000 chunks)
- < 50ms for medium projects (< 10000 chunks)
- < 200ms for large projects (< 100000 chunks)

Monitor `execution_time_ms` in responses.

### Optimization Tips

1. **Limit result size**: Cap at 100 results per query
2. **Use pagination**: Don't fetch all results at once
3. **Filter early**: Apply filters before FTS5 search when possible
4. **Index selectively**: Don't index binary files or logs

### VACUUM for Index Maintenance

Periodically optimize FTS5 index:
```bash
sqlite3 data.db "INSERT INTO retrieval_index(retrieval_index) VALUES('optimize');"
```

Run during maintenance windows.

## Notes

### Highlighting

The `snippet` function generates highlighted excerpts:
- `'**'` - Start marker (customizable)
- `'**'` - End marker
- `'...'` - Ellipsis for truncated content
- `32` - Max tokens in snippet

### Relevance Scoring

FTS5 `rank` is negative (lower = more relevant):
- -2.5 is better than -1.0
- We return `Math.abs(rank)` for clarity

### Future Enhancements

- Semantic search with embeddings
- Fuzzy matching for typos
- Search suggestions / autocomplete
- Query history and saved searches
- Export search results

## Next Step

[11: Update System Prompts](./11-system-prompts.md) - Include file list in model context
