# Multi-Model Chat: Vision

## What We're Building

A **project-aware, multi-model orchestration system** that lets you have parallel conversations with multiple AI models while managing large codebases, documents, and conversation histories that exceed context windows.

### The Core Problem

Current AI chat interfaces are limited:
- **No project context**: Models can't access your codebase or project files
- **Context window limits**: Conversations that exceed 200k tokens lose history
- **Single model**: Miss out on diverse perspectives and capabilities
- **Ephemeral**: Conversations and insights are lost when you close the tab
- **No tool building**: Can't create reusable utilities for recurring patterns

### Our Solution

A system that combines:
1. **Multi-model parallelism**: Get responses from GPT-4, Claude, Gemini simultaneously
2. **Project-based organization**: Files, conversations, and tools organized by project
3. **Intelligent retrieval**: Automatic surfacing of relevant files and conversation history
4. **Code execution**: Models can write and execute Python code to analyze your data
5. **Tool persistence**: Models build reusable tools that improve over time
6. **Persistent state**: Everything saved, searchable, exportable

## Core Principles

### 1. SQL for Operational State
- Configuration, sessions, and metadata in SQLite
- Concurrent access, queryable, scales to multi-user
- Transactions and referential integrity ensure consistency

### 2. Flexible Retrieval Over Prescriptive RAG
- Don't commit early to embeddings/vector search
- Start with FTS5 keyword search (surprisingly effective for code)
- "Retrieval" means "mechanism for surfacing useful data" - could be keyword, semantic, hybrid, or graph-based
- Evolve the mechanism as we learn what works

### 3. Model-Aware Context Management
- Different models get different context based on capability and cost
- **Smart models** (GPT-4, Claude Opus, Gemini Pro): Get retrieval summaries + tools, can request specific files
- **Cheap models** (Haiku, 4o-mini, Flash): Get pre-populated context, no tool overhead
- Each model stays within its context window via dynamic assembly

### 4. Unified Retrieval
- Same mechanism for project files AND conversation history
- When conversation exceeds working context, old rounds become retrievable
- Effectively infinite context via retrieval

### 5. Export as Portability
- SQL is source of truth (operational)
- Export conversations to Markdown/JSON anytime (archival, sharing)
- SQLite file + storage/ directory = complete portable backup

### 6. Code Execution as the Universal Tool
- Instead of building specific tools (`read_file`, `search_files`, `analyze_data`), give models code execution
- Models write Python to do whatever they need
- More flexible, handles novel workflows we haven't anticipated
- Tools they create persist for future use

## Key Capabilities

### For You (The User)
- **Compare model responses**: See how different models approach the same problem
- **Leverage model strengths**: GPT-4 for reasoning, Claude for code, Gemini for search
- **Work with large projects**: 200k+ token codebases, long conversation histories
- **Build institutional knowledge**: Models create reusable tools for your domain
- **Access anywhere**: Multi-device, eventually multi-user

### For Models (The AI Agents)
- **Project context**: Access to your files, past conversations, accumulated tools
- **Code execution**: Write Python to analyze data, parse files, combine sources
- **Agentic search**: Can request additional context when needed
- **Tool creation**: Build and share utilities with other models (and future selves)
- **Learning over time**: Each conversation adds to the project's tool library

## Design Philosophy

### Start Simple, Evolve Thoughtfully
- Phase 1a: Just persistence (SQLite conversations)
- Phase 1b: Add files and basic search
- Phase 1c: Add code execution (optional!)
- Later: Embeddings, multi-user, advanced features

Each phase delivers value independently.

### Optimize for the 80% Case
- Most projects: < 50 files, < 1000 conversations
- Most conversations: < 20 rounds
- Most files: < 1MB

Design for this, but support the 20% edge cases (200k+ tokens, thousands of files).

### Human-Readable + Machine-Queryable
- SQLite for live operational state (concurrent, transactional)
- Markdown exports for human reading and portability
- Best of both worlds

### Privacy and Control
- Runs locally via `npm start`
- API keys in `.env` (not committed)
- Project files stay on your machine (no cloud required)
- Future: Local embeddings instead of API calls

## Evolution Path

### Personal Tool → Hosted Service → Multi-User Platform

**Now (Phase 1)**: Single user, local, `npm start`
- Persistent conversations and files
- Basic retrieval
- Code execution for smart models

**Soon (Phase 2-3)**: Hosted, still single user
- Multiple devices access same projects
- Real-time sync
- Cost tracking and budgets

**Later (Phase 4+)**: Multi-user, collaborative
- Shared projects with permissions
- Real-time collaboration
- User management

The architecture supports this evolution without fundamental redesign.

## Success Criteria

We'll know this is successful when:
1. **You use it daily** for real work (not just experimentation)
2. **Projects exceed 200k tokens** and retrieval keeps it manageable
3. **Models build useful tools** that actually get reused
4. **Diverse perspectives** from multiple models lead to better solutions
5. **Nothing is lost** - you can find any past conversation or insight
6. **Others want to use it** and the multi-user path is clear

## Non-Goals (For Now)

What we're explicitly NOT building in Phase 1:
- ❌ Real-time streaming responses (nice-to-have later)
- ❌ Image/video upload (text files only for now)
- ❌ Multi-user authentication (single user first)
- ❌ Web-based code editor (upload files externally)
- ❌ Model fine-tuning or training
- ❌ Custom model integrations beyond the big 4 (OpenAI, Anthropic, Google, xAI)

These might come later, but won't distract from the core vision.

## Related Reading

- [Anthropic: Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) - Inspiration for code execution over bespoke tools
- [Lost in the Middle](https://arxiv.org/abs/2307.03172) - Why retrieval beats stuffing context
- [RAG vs Long Context](https://arxiv.org/abs/2407.16833) - When to use each approach

---

**Next**: See [ROADMAP.md](./ROADMAP.md) for implementation plan.
