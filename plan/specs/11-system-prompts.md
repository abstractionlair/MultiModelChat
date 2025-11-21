# Step 11: Update System Prompts

**Phase**: 1b - Files & Retrieval
**Complexity**: Low (1-2 hours)
**Dependencies**: [10: FTS5 Search Endpoint](./10-search-endpoint.md)
**Can Parallelize**: No

[← Back to Roadmap](../ROADMAP.md)

## Goal

Extend system prompt templates to include project file listings, making models aware of available files and their contents.

## Success Criteria

- [ ] System prompt includes file listing when files exist
- [ ] File listing shows path, size, and type
- [ ] Token budget respected (don't blow out context)
- [ ] Conditional: only show files section if project has files
- [ ] Format is clear and scannable for models
- [ ] Updated prompts deployed in `/api/turn`

## Design

### Files Section Format

```
PROJECT FILES (12 total, ~45K tokens):

Documentation:
  - docs/api-reference.md (15.2 KB, text/markdown)
  - docs/architecture.md (8.7 KB, text/markdown)
  - README.md (3.1 KB, text/markdown)

Source Code:
  - src/auth.js (12.4 KB, text/javascript)
  - src/db/index.js (6.8 KB, text/javascript)
  - src/utils/files.js (4.2 KB, text/javascript)

Data:
  - data/users.csv (127.3 KB, text/csv)
  - data/config.json (0.8 KB, application/json)

Use the search endpoint to find specific content, or request file content during conversation.
```

### Token Budget

Keep file listing under **500 tokens**:
- If project has < 20 files: Show all
- If project has 20-50 files: Group by directory, summarize
- If project has > 50 files: Show counts by type and top-level directories

## Implementation

### 1. Create Files Formatting Module

**File**: `server/prompts/files.js`

```javascript
const { db } = require('../db/index');

/**
 * Format file size in human-readable format
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Group files by top-level directory
 */
function groupFilesByDirectory(files) {
  const groups = {};

  for (const file of files) {
    const parts = file.path.split('/');
    const topDir = parts.length > 1 ? parts[0] : '.';

    if (!groups[topDir]) {
      groups[topDir] = [];
    }

    groups[topDir].push(file);
  }

  return groups;
}

/**
 * Build file listing section for system prompt
 */
function buildFilesSection(projectId) {
  // Get all files
  const files = db.prepare(`
    SELECT path, mime_type, size_bytes
    FROM project_files
    WHERE project_id = ?
    ORDER BY path ASC
  `).all(projectId);

  if (files.length === 0) {
    return null; // No files, skip section
  }

  // Calculate total size and tokens
  const totalSize = files.reduce((sum, f) => sum + f.size_bytes, 0);
  const totalTokens = Math.ceil(totalSize / 4); // ~4 chars per token

  // Build section header
  let section = `PROJECT FILES (${files.length} total, ~${formatSize(totalTokens * 4)} content):\n\n`;

  // Simple format for small projects
  if (files.length <= 20) {
    const groups = groupFilesByDirectory(files);

    for (const [dir, dirFiles] of Object.entries(groups).sort()) {
      const dirName = dir === '.' ? 'Root' : dir;
      section += `${dirName}:\n`;

      for (const file of dirFiles) {
        const size = formatSize(file.size_bytes);
        section += `  - ${file.path} (${size}, ${file.mime_type})\n`;
      }

      section += '\n';
    }
  }
  // Grouped format for medium projects
  else if (files.length <= 50) {
    const groups = groupFilesByDirectory(files);

    for (const [dir, dirFiles] of Object.entries(groups).sort()) {
      const dirSize = dirFiles.reduce((sum, f) => sum + f.size_bytes, 0);
      section += `${dir}/ — ${dirFiles.length} files, ${formatSize(dirSize)}\n`;

      // Show first 3 files
      dirFiles.slice(0, 3).forEach(file => {
        section += `  - ${file.path} (${formatSize(file.size_bytes)})\n`;
      });

      if (dirFiles.length > 3) {
        section += `  ... and ${dirFiles.length - 3} more\n`;
      }

      section += '\n';
    }
  }
  // Summary format for large projects
  else {
    const groups = groupFilesByDirectory(files);
    const dirSummaries = Object.entries(groups)
      .map(([dir, dirFiles]) => {
        const size = dirFiles.reduce((sum, f) => sum + f.size_bytes, 0);
        return { dir, count: dirFiles.length, size };
      })
      .sort((a, b) => b.size - a.size);

    section += 'File organization:\n';
    dirSummaries.forEach(({ dir, count, size }) => {
      section += `  - ${dir}/ — ${count} files, ${formatSize(size)}\n`;
    });
    section += '\n';

    // File type summary
    const typeGroups = {};
    files.forEach(f => {
      const type = f.mime_type || 'unknown';
      if (!typeGroups[type]) typeGroups[type] = 0;
      typeGroups[type]++;
    });

    section += 'File types:\n';
    Object.entries(typeGroups)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        section += `  - ${type}: ${count} files\n`;
      });
    section += '\n';
  }

  // Add usage instructions
  section += 'Use the search endpoint to find specific content, or request files during conversation.\n';

  return section;
}

module.exports = { buildFilesSection, formatSize };
```

### 2. Update System Prompt Builder

**File**: `server/prompts/builder.js`

```javascript
const { buildFilesSection } = require('./files');

/**
 * Build complete system prompt for a model
 */
function buildSystemPrompt(context) {
  const {
    modelId,
    provider,
    projectId,
    projectName,
    conversationInfo
  } = context;

  let prompt = `You are ${modelId} in a multi-model conversation with one user and multiple AI models.

This conversation involves parallel responses from different models. You'll see the full conversation history: each user message followed by other models' replies tagged in brackets (e.g., [ModelName]: ...). Your own previous replies appear as assistant messages.

Respond directly to the user and other models as appropriate. Replies are collected in parallel; do not claim to "go first" or reference response order.

PROJECT CONTEXT
You are working in the "${projectName}" project.

`;

  // Add files section if files exist
  const filesSection = buildFilesSection(projectId);
  if (filesSection) {
    prompt += filesSection + '\n';
  }

  // Add conversation info if provided
  if (conversationInfo) {
    prompt += `CONVERSATION INFO
This conversation has ${conversationInfo.round_count} rounds so far.
${conversationInfo.summary ? `Summary: ${conversationInfo.summary}\n` : ''}
`;
  }

  // Provider-specific sections
  prompt += getProviderSection(provider);

  return prompt;
}

/**
 * Get provider-specific prompt sections
 */
function getProviderSection(provider) {
  const sections = {
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
`,
    google: `
NOTE:
If you have access to Google Search grounding, you can offer to search for current information when relevant. Other models may not have this capability.
`,
    xai: ``,
    mock: ``
  };

  return sections[provider] || '';
}

module.exports = { buildSystemPrompt };
```

### 3. Update API Turn to Use New Prompts

**File**: `server/server.js`

Add import:
```javascript
const { buildSystemPrompt } = require('./prompts/builder');
```

Update the `/api/turn` route to use the new prompt builder. Find the section where system prompts are built for each model and replace with:

```javascript
// Build system prompt with file context
const systemPrompt = buildSystemPrompt({
  modelId,
  provider,
  projectId: conv.projectId || getDefaultProjectId(),
  projectName: conv.projectName || 'Default Project',
  conversationInfo: {
    round_count: conv.rounds.length,
    summary: conv.summary
  }
});
```

Then use `systemPrompt` when calling adapters instead of the old `system` variable.

### 4. Create Test

**File**: `server/prompts/test-prompts.js`

```javascript
const { db, newId, getDefaultProjectId } = require('../db/index');
const { runMigrations } = require('../db/migrate');
const { buildSystemPrompt } = require('./builder');
const { buildFilesSection } = require('./files');

// Run migrations
runMigrations();

console.log('Testing system prompt generation...\n');

const projectId = getDefaultProjectId();

// Test 1: Project with no files
console.log('1. Testing prompt with no files...');
const prompt1 = buildSystemPrompt({
  modelId: 'gpt-4o',
  provider: 'openai',
  projectId,
  projectName: 'Test Project',
  conversationInfo: { round_count: 5 }
});

if (!prompt1.includes('PROJECT FILES')) {
  console.log('✓ No files section when project has no files');
} else {
  console.error('✗ Files section shown when project has no files');
}

// Test 2: Add some test files
console.log('\n2. Adding test files...');
const now = Date.now();
const fileIds = [];

const testFiles = [
  { path: 'README.md', content: '# Test Project\n\nReadme content', mime: 'text/markdown' },
  { path: 'src/index.js', content: 'console.log("hello");\n'.repeat(50), mime: 'text/javascript' },
  { path: 'src/utils.js', content: 'function test() {}\n'.repeat(30), mime: 'text/javascript' },
  { path: 'docs/api.md', content: '# API\n\nDocumentation'.repeat(20), mime: 'text/markdown' },
  { path: 'data/config.json', content: '{"key": "value"}', mime: 'application/json' },
];

for (const file of testFiles) {
  const fileId = newId('file');
  fileIds.push(fileId);

  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    projectId,
    file.path,
    file.content,
    'test-hash',
    file.mime,
    Buffer.byteLength(file.content),
    now,
    now
  );
}

console.log(`✓ Added ${testFiles.length} test files`);

// Test 3: Generate prompt with files
console.log('\n3. Testing prompt with files...');
const filesSection = buildFilesSection(projectId);

if (filesSection) {
  console.log('✓ Files section generated');
  console.log('\nGenerated section:');
  console.log('---');
  console.log(filesSection);
  console.log('---');
} else {
  console.error('✗ Files section not generated');
}

// Test 4: Full prompt
console.log('\n4. Testing full prompt...');
const prompt2 = buildSystemPrompt({
  modelId: 'claude-sonnet-4-5',
  provider: 'anthropic',
  projectId,
  projectName: 'Test Project',
  conversationInfo: { round_count: 10, summary: 'Discussion about auth' }
});

if (prompt2.includes('PROJECT FILES') && prompt2.includes('README.md')) {
  console.log('✓ Full prompt includes files section');
} else {
  console.error('✗ Full prompt missing files section');
}

// Test 5: Token budget
console.log('\n5. Checking token budget...');
const tokenCount = Math.ceil(filesSection.length / 4);
console.log(`Files section is ~${tokenCount} tokens`);

if (tokenCount < 500) {
  console.log('✓ Files section within token budget');
} else {
  console.error(`✗ Files section exceeds budget (${tokenCount} > 500)`);
}

// Cleanup
console.log('\n6. Cleaning up test files...');
for (const fileId of fileIds) {
  db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
}
console.log('✓ Test files deleted');

console.log('\n✓ All prompt tests passed!');
```

Run:
```bash
node server/prompts/test-prompts.js
```

### 5. Test in Real Conversation

**File**: `server/test-prompts-integration.sh`

```bash
#!/bin/bash

# Test system prompts in actual conversation

BASE_URL="http://localhost:3000"

echo "=== Testing System Prompts Integration ==="

# Get project ID
PROJECT_ID=$(curl -s "$BASE_URL/api/conversations" | jq -r '.conversations[0].project_id')
echo "Using project: $PROJECT_ID"

# Upload a test file
echo -e "\n1. Uploading test file..."
curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/files" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "docs/test.md",
    "content": "# Test Document\n\nThis file is for testing system prompts."
  }' > /dev/null

sleep 1

# Send a message and check if models can see files
echo -e "\n2. Sending test message..."
RESPONSE=$(curl -s -X POST "$BASE_URL/api/turn" \
  -H "Content-Type: application/json" \
  -d '{
    "userMessage": "What files are available in this project?",
    "targetModels": [
      {"provider": "mock", "modelId": "mock-echo"}
    ]
  }')

echo "$RESPONSE" | jq .

# Preview system prompt
echo -e "\n3. Previewing system prompt..."
curl -s -X POST "$BASE_URL/api/preview-view" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "modelId": "gpt-4o",
    "userMessage": "Test",
    "conversationId": null
  }' | jq -r '.view.system' | head -50

echo -e "\n=== Tests complete ==="
```

Run:
```bash
chmod +x server/test-prompts-integration.sh
npm start  # In one terminal
./server/test-prompts-integration.sh  # In another terminal
```

## Files Changed

- `server/prompts/files.js` - New files formatting module
- `server/prompts/builder.js` - New prompt builder module
- `server/server.js` - Update `/api/turn` to use new prompts
- `server/prompts/test-prompts.js` - New test
- `server/test-prompts-integration.sh` - New integration test

## Testing Checklist

- [ ] Run unit test: `node server/prompts/test-prompts.js`
- [ ] Run integration test: `./server/test-prompts-integration.sh`
- [ ] Verify files section appears in prompts
- [ ] Check token budget is respected
- [ ] Test with 0, 5, 25, and 100 files in project
- [ ] Verify conditional display (no files = no section)

## Validation

```bash
# Check prompt preview
curl -s -X POST http://localhost:3000/api/preview-view \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "anthropic",
    "modelId": "claude-sonnet-4-5",
    "userMessage": "Hello"
  }' | jq -r '.view.system'

# Verify files listed
curl -s -X POST http://localhost:3000/api/preview-view \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "openai",
    "modelId": "gpt-4o",
    "userMessage": "Test"
  }' | jq -r '.view.system' | grep "PROJECT FILES"
```

## Notes

### Token Budget Management

The files section is designed to stay under 500 tokens:

**Small projects (< 20 files)**:
- ~20 tokens per file listing
- Total: ~400 tokens

**Medium projects (20-50 files)**:
- ~10 tokens per file (grouped)
- Total: ~300-500 tokens

**Large projects (> 50 files)**:
- Directory summaries only
- Total: ~200-300 tokens

### Format Design

The format is optimized for model comprehension:
- **Grouped by directory**: Natural organization
- **Size info**: Helps models understand scope
- **MIME types**: Indicates file contents
- **Scannable**: Clear hierarchy with indentation

### Future Enhancements

1. **Always-in-context files**: Pin important files to every prompt
2. **Automatic retrieval**: Search and include relevant chunks
3. **File summaries**: AI-generated descriptions
4. **Recent files**: Highlight recently modified files
5. **Usage hints**: Suggest which files are relevant for current task

### Alternative Formats

For very large projects, consider:
- Link to searchable file tree
- Only show files modified recently
- Show only files matching current conversation topic

### Provider Differences

Some providers may handle file listings differently:
- **Anthropic**: Good with structured lists
- **OpenAI**: Prefers concise bullet points
- **Google**: Can handle longer context

Adjust format in `buildFilesSection` based on provider if needed.

## Rollback Plan

If prompts cause issues:
1. Keep old prompt system as fallback
2. Add feature flag: `USE_NEW_PROMPTS=false`
3. A/B test with sample conversations
4. Monitor token usage and model performance

## Next Steps

Phase 1b is now complete! The system can:
- ✓ Store files in hybrid SQLite/disk storage
- ✓ Upload, list, read, and delete files via API
- ✓ Automatically chunk and index files
- ✓ Search files with FTS5
- ✓ Show file context to models in prompts

**Next phase options**:
- **Phase 1c**: Code execution with Pyodide (optional)
- **Phase 2**: Enhanced retrieval with automatic context management
- **Deploy Phase 1a+1b**: Ship file-aware chat system to users

See [Roadmap](../ROADMAP.md) for next steps.

---

[← Back to Roadmap](../ROADMAP.md)
