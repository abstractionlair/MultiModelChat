# Step 15: Integration in /api/turn

**Phase**: 1c - Code Execution
**Complexity**: Medium (3-4 hours)
**Dependencies**: [14: Auto-Indexing](./14-tool-persistence.md)
**Can Parallelize**: No (final step of Phase 1c)

[← Back to Roadmap](../ROADMAP.md)

## Goal

Integrate bash execution into the `/api/turn` endpoint, enabling models to execute commands during conversations with automatic file materialization and indexing.

## Success Criteria

- [ ] `bash` tool definition added for all providers
- [ ] Tool calling loop implemented (models can call bash multiple times)
- [ ] System prompt updated with bash usage instructions
- [ ] Custom commands (search_project, list_project_files) implemented
- [ ] Test with real conversation flow
- [ ] Performance: execution < 5s for typical commands
- [ ] Error handling works gracefully

## Background

This step completes Phase 1c by wiring bash execution into the conversation flow. Models will be able to:
- Execute Python/JavaScript scripts
- Install packages (pip, npm)
- Create and modify files
- Search project files
- Build reusable utilities

All file changes are automatically indexed, making created content searchable.

## Implementation

### 1. Define Bash Tool

**File**: `server/execution/tools.js`

```javascript
const { bashExecutor } = require('./bash');
const { search } = require('../indexing/search');
const { db } = require('../db/index');

/**
 * Bash tool definition for all providers
 */
const bashTool = {
  name: 'bash',
  description: `Execute bash commands in the project directory.

Available commands:
  Languages: python, node
  Package managers: pip, npm
  Unix utilities: cat, ls, mkdir, rm, echo, grep, head, tail
  Project tools: search_project, list_project_files

Working directory: /project/
All files you create are automatically indexed for search.

Examples:
  bash('cat data.csv')
  bash('pip install pandas')
  bash('python analyze.py')
  bash('search_project "sales analysis"')`,

  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Bash command to execute'
      }
    },
    required: ['command']
  }
};

/**
 * Execute bash tool call
 */
async function executeBashTool(args, projectId) {
  const { command } = args;

  // Handle custom project commands
  if (command.startsWith('search_project ')) {
    return await executeSearchProject(command, projectId);
  }

  if (command.startsWith('list_project_files')) {
    return await executeListProjectFiles(command, projectId);
  }

  // Execute via bash executor
  const result = await bashExecutor.executeWithProject(command, projectId);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exit_code,
    file_changes: result.fileChanges ? {
      created: result.fileChanges.created.length,
      modified: result.fileChanges.modified.length,
      deleted: result.fileChanges.deleted.length
    } : undefined
  };
}

/**
 * Execute search_project command
 */
async function executeSearchProject(command, projectId) {
  // Parse: search_project "query" [limit]
  const match = command.match(/search_project\s+"([^"]+)"(?:\s+(\d+))?/);

  if (!match) {
    return {
      stdout: '',
      stderr: 'Usage: search_project "query" [limit]',
      exit_code: 1
    };
  }

  const [, query, limitStr] = match;
  const limit = limitStr ? parseInt(limitStr) : 10;

  try {
    const results = search(projectId, query, { limit, output_mode: 'content' });

    // Format results for bash output
    let output = `Found ${results.total_results} results (showing ${results.results.length}):\n\n`;

    for (const [i, result] of results.results.entries()) {
      const location = JSON.parse(result.location);
      output += `${i + 1}. ${location.path}`;

      if (location.start_line) {
        output += `:${location.start_line}-${location.end_line}`;
      }

      output += `\n   ${result.content.substring(0, 100)}...\n\n`;
    }

    return {
      stdout: output,
      stderr: '',
      exit_code: 0
    };
  } catch (err) {
    return {
      stdout: '',
      stderr: err.message,
      exit_code: 1
    };
  }
}

/**
 * Execute list_project_files command
 */
async function executeListProjectFiles(command, projectId) {
  // Parse: list_project_files [directory]
  const dir = command.replace('list_project_files', '').trim();

  try {
    const files = db.prepare(`
      SELECT path, size_bytes, mime_type
      FROM project_files
      WHERE project_id = ?
      ${dir ? 'AND path LIKE ?' : ''}
      ORDER BY path ASC
    `).all(projectId, dir ? `${dir}%` : undefined);

    let output = `Files in project${dir ? ` (${dir})` : ''} (${files.length} total):\n\n`;

    for (const file of files) {
      const size = formatSize(file.size_bytes);
      output += `${file.path} (${size}, ${file.mime_type})\n`;
    }

    return {
      stdout: output,
      stderr: '',
      exit_code: 0
    };
  } catch (err) {
    return {
      stdout: '',
      stderr: err.message,
      exit_code: 1
    };
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
  bashTool,
  executeBashTool
};
```

### 2. Update System Prompts

**File**: `server/prompts/builder.js` (update)

```javascript
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

BASH EXECUTION ENVIRONMENT:
You have access to a bash shell with Python and Node.js.

Commands available:
  python script.py        - Execute Python scripts
  pip install package     - Install Python packages (numpy, pandas, etc.)
  node script.js          - Execute JavaScript/Node.js
  npm install package     - Install npm packages
  cat, ls, mkdir, echo    - Unix utilities
  search_project "query"  - Search all project files
  list_project_files      - List all files in project

Working directory: /project/
All files you create are automatically saved and indexed for search.

To write files, use heredoc syntax:
cat > filename.py << 'EOF'
content here
EOF

To execute Python:
python script.py

To install packages:
pip install pandas numpy

Files persist across conversation rounds - reuse code you've written!

`;

  // Add files section if files exist
  const filesSection = buildFilesSection(projectId);
  if (filesSection) {
    prompt += filesSection + '\n';
  }

  // Add conversation info if provided
  if (conversationInfo) {
    prompt += `CONVERSATION INFO\n`;
    prompt += `This conversation has ${conversationInfo.round_count} rounds so far.\n`;
    if (conversationInfo.summary) {
      prompt += `Summary: ${conversationInfo.summary}\n`;
    }
    prompt += '\n';
  }

  // Provider-specific sections
  prompt += getProviderSection(provider);

  return prompt;
}
```

### 3. Update /api/turn Endpoint

**File**: `server/server.js` (update)

```javascript
const { bashTool, executeBashTool } = require('./execution/tools');

// ... existing code ...

app.post('/api/turn', async (req, res) => {
  const { userMessage, targetModels, conversationId } = req.body;

  // ... existing validation and setup ...

  try {
    // Get or create conversation
    let conv = conversationId ? conversations.get(conversationId) : null;

    if (!conv) {
      conv = {
        id: newDbId('conv'),
        projectId: getDefaultProjectId(),
        projectName: 'Default Project',
        rounds: [],
        createdAt: Date.now()
      };
      conversations.set(conv.id, conv);
    }

    const roundNumber = conv.rounds.length + 1;

    // Save user message
    const userMsgId = newDbId('msg');
    db.prepare(`
      INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userMsgId, conv.id, roundNumber, 'user', userMessage, Date.now());

    // Collect parallel responses
    const modelPromises = targetModels.map(async ({ provider, modelId }) => {
      try {
        // Build system prompt
        const systemPrompt = buildSystemPrompt({
          modelId,
          provider,
          projectId: conv.projectId,
          projectName: conv.projectName,
          conversationInfo: {
            round_count: roundNumber,
            summary: conv.summary
          }
        });

        // Build messages (full history)
        let messages = buildMessagesForModel(conv, userMessage, modelId);

        // Get adapter
        const adapter = getAdapter(provider);

        // Tool calling loop
        let response;
        let toolCallCount = 0;
        const maxToolCalls = 10;

        while (toolCallCount < maxToolCalls) {
          // Call model with tools
          response = await adapter({
            modelId,
            messages,
            system: systemPrompt,
            tools: [bashTool]
          });

          // Check for tool calls
          if (!response.tool_calls || response.tool_calls.length === 0) {
            // No more tool calls, we're done
            break;
          }

          // Execute tool calls
          const toolResults = [];

          for (const toolCall of response.tool_calls) {
            if (toolCall.name === 'bash') {
              const result = await executeBashTool(toolCall.args, conv.projectId);
              toolResults.push({
                tool_call_id: toolCall.id,
                content: JSON.stringify(result, null, 2)
              });
            }
          }

          // Add assistant message with tool calls
          messages.push({
            role: 'assistant',
            tool_calls: response.tool_calls
          });

          // Add tool results
          messages.push({
            role: 'tool',
            tool_results: toolResults
          });

          toolCallCount++;
        }

        if (toolCallCount >= maxToolCalls) {
          console.warn(`Model ${modelId} hit max tool call limit`);
        }

        // Save final response
        const agentId = `agent:${modelId}`;
        const msgId = newDbId('msg');

        const metadata = {
          modelId,
          agentId,
          provider,
          usage: response.usage || {},
          tool_calls_made: toolCallCount,
          ts: Date.now()
        };

        db.prepare(`
          INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(msgId, conv.id, roundNumber, agentId, response.text || '', JSON.stringify(metadata), Date.now());

        return {
          modelId,
          provider,
          agentId,
          text: response.text,
          usage: response.usage,
          tool_calls_made: toolCallCount
        };

      } catch (err) {
        console.error(`Error from ${modelId}:`, err);
        return {
          modelId,
          provider,
          agentId: `agent:${modelId}`,
          error: err.message
        };
      }
    });

    const responses = await Promise.all(modelPromises);

    // Update conversation
    conv.rounds.push({
      roundNumber,
      userMessage,
      responses
    });

    // Update conversation in DB
    db.prepare(`
      UPDATE conversations
      SET round_count = ?, updated_at = ?
      WHERE id = ?
    `).run(roundNumber, Date.now(), conv.id);

    res.json({
      conversationId: conv.id,
      roundNumber,
      responses
    });

  } catch (err) {
    console.error('Turn error:', err);
    res.status(500).json({ error: 'turn_failed', message: err.message });
  }
});
```

### 4. Update Adapters for Tool Support

**File**: `server/adapters/openai.js` (update)

```javascript
async function sendOpenAI({ modelId, messages, system, tools }) {
  const payload = {
    model: modelId,
    messages: [
      { role: 'system', content: system },
      ...messages.map(m => {
        if (m.tool_calls) {
          return {
            role: 'assistant',
            tool_calls: m.tool_calls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args)
              }
            }))
          };
        } else if (m.tool_results) {
          return {
            role: 'tool',
            tool_call_id: m.tool_results[0].tool_call_id,
            content: m.tool_results[0].content
          };
        } else {
          return m;
        }
      })
    ]
  };

  // Add tools if provided
  if (tools && tools.length > 0) {
    payload.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }

  const response = await openai.chat.completions.create(payload);
  const choice = response.choices[0];

  // Check for tool calls
  if (choice.finish_reason === 'tool_calls') {
    return {
      tool_calls: choice.message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments)
      })),
      usage: response.usage
    };
  }

  // Regular text response
  return {
    text: choice.message.content,
    usage: response.usage
  };
}
```

Similar updates needed for `anthropic.js`, `google.js`, etc.

### 5. Create End-to-End Test

**File**: `server/test-execution-e2e.js`

```javascript
const { db, newId, getDefaultProjectId } = require('./db/index');
const { runMigrations } = require('./db/migrate');
const crypto = require('crypto');

runMigrations();

async function runTests() {
  console.log('=== Code Execution E2E Test ===\n');

  const BASE_URL = 'http://localhost:3000';
  const projectId = getDefaultProjectId();

  // Setup: Upload test data file
  console.log('1. Uploading test data...');

  const fileId = newId('file');
  const csvContent = `product,amount
Widget A,100
Widget B,200
Widget C,150`;

  const hash = crypto.createHash('sha256').update(csvContent).digest('hex');

  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    projectId,
    'data/sales.csv',
    csvContent,
    hash,
    'text/csv',
    Buffer.byteLength(csvContent),
    Date.now(),
    Date.now()
  );

  console.log('✓ Test data uploaded\n');

  // Test 2: Send message requesting analysis
  console.log('2. Sending message to mock model...');

  const response = await fetch(`${BASE_URL}/api/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userMessage: 'Analyze sales data and tell me the top product',
      targetModels: [
        { provider: 'mock', modelId: 'mock-bash-user' }
      ]
    })
  });

  const data = await response.json();

  if (data.responses && data.responses.length > 0) {
    const firstResponse = data.responses[0];

    console.log('✓ Response received');
    console.log(`  Model: ${firstResponse.modelId}`);
    console.log(`  Tool calls: ${firstResponse.tool_calls_made}`);
    console.log(`  Response: ${firstResponse.text.substring(0, 100)}...`);
  } else {
    console.error('✗ No response received:', data);
  }

  // Test 3: Check if files were created
  console.log('\n3. Checking for created files...');

  const createdFiles = db.prepare(`
    SELECT path, size_bytes
    FROM project_files
    WHERE project_id = ? AND path NOT LIKE 'data/%'
    ORDER BY created_at DESC
    LIMIT 5
  `).all(projectId);

  if (createdFiles.length > 0) {
    console.log(`✓ Found ${createdFiles.length} created files:`);
    createdFiles.forEach(f => console.log(`  - ${f.path} (${f.size_bytes} bytes)`));
  } else {
    console.log('  No files created (this is OK for some models)');
  }

  // Test 4: Search for created content
  console.log('\n4. Testing search for created content...');

  const { search } = require('./indexing/search');
  const searchResults = search(projectId, 'Widget', { limit: 5 });

  if (searchResults.results.length > 0) {
    console.log(`✓ Found ${searchResults.total_results} search results`);
  } else {
    console.log('  No search results (may not have created searchable content)');
  }

  // Cleanup
  console.log('\n5. Cleaning up...');
  db.prepare('DELETE FROM project_files WHERE project_id = ?').run(projectId);
  if (data.conversationId) {
    db.prepare('DELETE FROM conversations WHERE id = ?').run(data.conversationId);
  }
  console.log('✓ Cleanup complete');

  console.log('\n✓ E2E test complete!');
}

// Check if server is running
fetch('http://localhost:3000/api/health')
  .then(() => runTests())
  .catch(err => {
    console.error('Server not running. Start with: npm start');
    process.exit(1);
  });
```

## Files Changed

- `server/execution/tools.js` - New tool definitions and executors
- `server/prompts/builder.js` - Add bash usage instructions
- `server/server.js` - Add tool calling loop to /api/turn
- `server/adapters/openai.js` - Add tool support
- `server/adapters/anthropic.js` - Add tool support (similar to OpenAI)
- `server/adapters/google.js` - Add tool support (similar to OpenAI)
- `server/test-execution-e2e.js` - New E2E test

## Testing Checklist

- [ ] Start server: `npm start`
- [ ] Run E2E test: `node server/test-execution-e2e.js`
- [ ] Test with mock provider
- [ ] Test with real providers (OpenAI, Anthropic, Google)
- [ ] Verify bash tool called successfully
- [ ] Verify files created and indexed
- [ ] Verify search finds created content
- [ ] Test multi-round tool calling
- [ ] Test error handling (bad commands, timeouts)

## Validation

```bash
# Start server
npm start

# In another terminal, run E2E test
node server/test-execution-e2e.js

# Expected output:
# ✓ Test data uploaded
# ✓ Response received
# ✓ Found X created files
# ✓ Found X search results
# ✓ E2E test complete!

# Test manually via curl
curl -s -X POST http://localhost:3000/api/turn \
  -H 'Content-Type: application/json' \
  -d '{
    "userMessage": "List the files and analyze sales data",
    "targetModels": [{"provider": "openai", "modelId": "gpt-4o"}]
  }' | jq .
```

## Phase 1c Complete!

With this step, Phase 1c (Code Execution) is complete. The system now provides:

✓ **Step 12**: Bash execution environment with Python & Node.js
✓ **Step 13**: Project file materialization
✓ **Step 14**: Auto-indexing of created/modified files
✓ **Step 15**: Full integration in /api/turn with tool calling

**What this enables**:
- Models execute Python and JavaScript code
- Models create reusable utilities
- All created files automatically searchable
- Tools accumulate over time
- Works across all providers (OpenAI, Anthropic, Google, xAI)

**Example conversation**:
```
User: "Analyze the sales data"
GPT-4o: [calls bash('search_project "sales"')]
        [calls bash('cat > analyze.py << EOF...\nEOF')]
        [calls bash('python analyze.py')]
        "I analyzed the sales data. Widget C is the top product..."
```

## Next Steps

You have three options:

1. **Deploy Phase 1a + 1b + 1c** - Ship complete system with code execution
2. **Phase 2**: Enhanced retrieval (auto-retrieval, token budgets, summaries)
3. **Phase 3**: Advanced features (embeddings, multi-user, cost tracking)

See [Roadmap](../ROADMAP.md) for next steps.

---

[← Back to Roadmap](../ROADMAP.md)
