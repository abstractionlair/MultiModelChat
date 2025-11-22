# Phase 1c Specifications

**Status**: ✓ Complete (all specs written)
**Created**: 2025-11-21
**Dependencies**: Phase 1b complete (Steps 07-11)

This document tracks the creation of Phase 1c specifications.

## Overview

Phase 1c adds bash-based code execution capabilities to the multi-model chat system, enabling models to:
- Execute bash commands with Python (Pyodide) and Node.js
- Install packages via pip (micropip) and npm
- Create and modify files using standard Unix commands
- Search project files via custom commands
- Have all created files automatically indexed for search

## Key Design Decision: Bash-Only Architecture

After reviewing Anthropic's MCP code execution article and extensive discussion, we chose a **bash-only architecture**:

**Single `bash` tool** instead of multiple specific tools (execute_python, write_file, etc.)

**Why?**
- Simpler implementation (one tool vs. many)
- More flexible (models use standard Unix commands)
- Matches how developers actually work
- Enables package installation (pip, npm)
- Models can write programs, not just function calls

**Models write actual programs** using heredoc syntax:
```bash
cat > analyze.py << 'EOF'
import csv
with open('data.csv') as f:
    rows = list(csv.DictReader(f))
print(f'Total rows: {len(rows)}')
EOF

python analyze.py
```

**Tool calling loop** - models can call bash multiple times per turn, see results, and iterate before responding to user.

## Specifications Written

### Step 12: Bash Execution Runtime
**File**: `12-pyodide-integration.md`
**Status**: ✓ Written
**Complexity**: Medium (2-3 hours)

Sets up bash execution environment with Python and Node.js:
- Pyodide runtime for Python execution
- Node.js for JavaScript execution
- Unix command emulation (cat, ls, mkdir, echo)
- Heredoc parsing for file creation
- Command routing (python → Pyodide, node → Node.js, etc.)
- Custom commands (search_project, list_project_files) - placeholders
- Timeout protection (30s default)

**Key deliverables**:
- `server/execution/bash.js` - BashExecutor class
- Command routing logic
- Comprehensive test suite

### Step 13: Filesystem Materialization
**File**: `13-filesystem-materialization.md`
**Status**: ✓ Written
**Complexity**: Low (1-2 hours)

Loads project files from database into Pyodide virtual filesystem:
- Read files from DB (content) or disk (content_location)
- Create directory structure in virtual FS
- All files writable (MVP simplicity)
- Files materialized with exact paths from DB
- Filesystem scanning for change detection

**Key deliverables**:
- `server/execution/materialize.js` - Materialization logic
- `scanFilesystem()` function for change detection
- Updated BashExecutor with `executeWithProject()`

### Step 14: Auto-Indexing
**File**: `14-tool-persistence.md`
**Status**: ✓ Written
**Complexity**: Medium (2-3 hours)

Automatically detects and indexes file changes after bash execution:
- Scan virtual filesystem for all files
- Compare against database using SHA256 hashes
- Detect new, modified, and deleted files
- Reindex changed files (delete old chunks first)
- All files auto-indexed (Python scripts, data, utilities)

**Key deliverables**:
- `server/execution/auto-index.js` - Auto-indexing logic
- Hash-based change detection
- Integration with indexing pipeline

### Step 15: Integration in /api/turn
**File**: `15-execution-in-turn.md`
**Status**: ✓ Written
**Complexity**: Medium (3-4 hours)

Integrates bash execution into conversation flow:
- Define `bash` tool for model adapters
- Tool calling loop (max 5 calls per turn)
- Execute bash commands with project context
- Auto-index after successful execution
- Custom commands call internal APIs
- Update system prompts with bash instructions
- Handle errors gracefully

**Key deliverables**:
- Updated `/api/turn` endpoint with tool loop
- `executeBashTool()` helper function
- Custom command implementations
- End-to-end tests

## Implementation Order

**Must be done sequentially**:
1. Step 12 (Bash Runtime) - Foundation for all execution
2. Step 13 (Materialization) - Needed for file access
3. Step 14 (Auto-Indexing) - Detects changes after execution
4. Step 15 (Integration) - Pulls everything together

**Cannot parallelize** due to dependencies.

## Architecture Highlights

### Virtual Filesystem Structure
```
/project/
  README.md
  data/
    sales.csv
  scripts/
    analyze.py
  utils/
    parse_logs.py
```

All files writable. Changes detected and auto-indexed.

### Execution Flow
```
User message
  ↓
System builds prompt (includes bash tool)
  ↓
Models generate responses
  ↓
Models call bash tool with commands
  ↓
BashExecutor initialized (first time only)
  ↓
Project files materialized to virtual FS (first time only)
  ↓
Command executed (routed to Python/Node/Unix)
  ↓
Results returned to model
  ↓
Model can call bash again (up to 5 times)
  ↓
After execution, filesystem scanned for changes
  ↓
New/modified files saved to DB and indexed
  ↓
Model generates final response to user
  ↓
Next turn: created files available and searchable
```

### Bash Tool Definition
```javascript
{
  name: 'bash',
  description: `Execute bash commands in the project directory.

Available commands:
  Languages: python, node
  Package managers: pip, npm
  Unix utilities: cat, ls, mkdir, rm, echo, grep, head, tail
  Project tools: search_project, list_project_files

Working directory: /project/
All files you create are automatically indexed for search.`,

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
}
```

### Security Layers
1. **Sandboxing**: Pyodide runs in WASM, isolated from Node.js
2. **Timeout protection**: 30s default, configurable
3. **Filesystem isolation**: Only /project/ accessible
4. **Path validation**: Already implemented in Phase 1b
5. **No network access**: Pyodide has no network by default

## Testing Strategy

### Unit Tests
- `server/execution/test-bash.js` - BashExecutor basics
- `server/execution/test-materialize.js` - File loading
- `server/execution/test-auto-index.js` - Change detection

### End-to-End Tests
- `server/test-execution-e2e.js` - Complete conversation flow with bash

### Performance Tests
Benchmarks to establish:
- Pyodide initialization time (target: < 3s)
- Materialization time by project size
- Execution time by command type
- Auto-indexing overhead

## Key Design Decisions

### 1. Bash-Only vs. Multiple Tools
**Decision**: Single bash tool
**Rationale**: Simpler, more flexible, matches developer workflow
**Trade-off**: Heredoc syntax slightly awkward vs. function tools

### 2. Auto-Index Everything vs. Selective
**Decision**: Auto-index all file changes
**Rationale**: Models can find anything they create, enables code search
**Trade-off**: Extra indexing overhead vs. missing created content

### 3. Read-Only vs. Read-Write Files
**Decision**: All files writable (changes detected after execution)
**Rationale**: MVP simplicity, models can modify for analysis
**Trade-off**: Potential confusion vs. implementation complexity

### 4. Pyodide vs. Native Python
**Decision**: Use Pyodide (Python in WASM)
**Rationale**: No Python installation needed, better sandboxing
**Trade-off**: 2-5x slower vs. native, but acceptable for this use case

### 5. Tool Calling vs. Triple-Backtick Parsing
**Decision**: Tool calling (models explicitly call bash tool)
**Rationale**: Models can iterate on errors, see output before responding
**Trade-off**: More API calls vs. cleaner UX

## Dependencies

### NPM Packages
- `pyodide@0.24.1` - Python runtime in WebAssembly

### Internal Modules
- `server/db/index.js` - Database and storage paths
- `server/indexing/indexer.js` - For indexing created files
- `server/prompts/builder.js` - System prompt construction
- `server/adapters/*` - Model adapters with tool support

## Success Criteria for Phase 1c

When Phase 1c is complete, the system should:

- [ ] Execute bash commands during conversations
- [ ] Support Python via Pyodide with pip (micropip)
- [ ] Support Node.js with npm
- [ ] Materialize all project files to virtual FS
- [ ] Auto-detect file changes after execution
- [ ] Index all created/modified files automatically
- [ ] Support custom commands (search_project, list_project_files)
- [ ] Handle execution errors gracefully
- [ ] Maintain < 5s execution latency p95
- [ ] Support 100+ files without performance issues
- [ ] Pass all test suites

## Potential Issues and Mitigations

### Issue 1: Pyodide Initialization Slow
- **Impact**: First execution in conversation takes 2-3s
- **Mitigation**: Lazy initialization, show "executing..." to user
- **Future**: Pre-warm Pyodide on server start

### Issue 2: Memory Usage
- **Impact**: Pyodide + project files = 50-100MB per session
- **Mitigation**: Single runtime instance, clear FS between conversations
- **Future**: Per-conversation isolation, memory limits

### Issue 3: Heredoc Syntax Complexity
- **Impact**: Models struggle with heredoc syntax
- **Mitigation**: Clear examples in system prompt
- **Future**: Better error messages for syntax errors

### Issue 4: Execution Timeout
- **Impact**: Long-running code fails, frustrates users
- **Mitigation**: Clear 30s timeout in prompts
- **Future**: Streaming output, background execution

### Issue 5: Package Compatibility
- **Impact**: Not all Python packages work in Pyodide
- **Mitigation**: Document available packages (stdlib + micropip compatible)
- **Future**: Expand compatible package list

## Future Enhancements (Post-Phase 1c)

### Short-term (Phase 2)
1. Streaming execution output
2. Execution history in conversation transcript
3. Better error messages with hints
4. File usage analytics

### Medium-term (Phase 3)
1. Visualization support (matplotlib output as images)
2. Interactive execution (handle input())
3. Background/async execution for long tasks
4. Shared utilities across projects

### Long-term (Phase 4+)
1. Jupyter-style notebook mode
2. Collaborative execution (multiple models)
3. Resource limits (memory, CPU)
4. Code review by other models

## References

- [ARCHITECTURE.md](../ARCHITECTURE.md) - Complete technical reference
- [ROADMAP.md](../ROADMAP.md) - Implementation roadmap
- [Anthropic MCP Code Execution](https://www.anthropic.com/engineering/code-execution-with-mcp) - Design inspiration

## Notes for Implementer

### Before Starting
1. Read all four specs completely
2. Review Phase 1b implementation for patterns
3. Set up test environment (Node.js 18+)
4. Budget 8-12 hours total for Phase 1c

### Implementation Tips
1. Start with Step 12 tests to verify Pyodide works
2. Test materialization with 1 file, then 10, then 100
3. Test auto-indexing with file creation, modification, deletion
4. Use simple bash commands first, then complex workflows
5. Profile execution time to catch slowdowns early

### Common Pitfalls
1. **Forgetting await**: Pyodide operations are async
2. **Path separators**: Use `/` not `\` in virtual FS
3. **Timeout too short**: Complex code needs time
4. **Not clearing FS**: Memory leaks between sessions
5. **Heredoc escaping**: Watch for EOF marker in content

### Testing Workflow
```bash
# Step 12
node server/execution/test-bash.js

# Step 13
node server/execution/test-materialize.js

# Step 14
node server/execution/test-auto-index.js

# Step 15 (E2E)
npm start  # Terminal 1
node server/test-execution-e2e.js  # Terminal 2
```

## Deployment Checklist

Before deploying Phase 1c:

- [ ] All specs reviewed
- [ ] All tests passing
- [ ] Performance benchmarks acceptable
- [ ] Security review completed
- [ ] Documentation updated
- [ ] Monitoring/logging in place
- [ ] Rollback plan tested

## Conclusion

Phase 1c specifications are complete and ready for implementation. The bash-based design provides:

- **Simplicity**: One tool instead of many
- **Flexibility**: Standard Unix commands
- **Power**: Package installation, multi-language support
- **Discoverability**: Auto-indexing makes created code searchable
- **Security**: Sandboxing, timeouts, filesystem isolation

Estimated total implementation time: **8-12 hours** for an experienced developer.

Next steps:
1. Review specs with team
2. Begin implementation starting with Step 12
3. Test continuously during development
4. Deploy to staging for validation

---

**Spec author**: Claude (Sonnet 4.5)
**Date**: 2025-11-21
**Status**: Ready for implementation
