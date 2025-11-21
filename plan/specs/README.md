# Implementation Specs

This directory contains detailed specifications for each implementation step in the [roadmap](../ROADMAP.md).

## How to Use These Specs

Each spec is scoped to **one coding session** and **one pull request**. They include:

- **Goal**: What we're trying to achieve
- **Success Criteria**: Checklist of deliverables
- **Schema/Design**: SQL, APIs, or architecture details
- **Implementation**: Step-by-step code changes
- **Testing**: How to verify it works
- **Validation**: Queries or commands to check correctness
- **Files Changed**: What files are touched
- **Notes**: Context, decisions, gotchas

## Spec Index

### Phase 1a: Foundations

| Step | Name | Status |
|------|------|--------|
| [01](./01-sqlite-setup.md) | SQLite Setup | ✅ Ready |
| [02](./02-conversations-schema.md) | Conversations Schema | ✅ Ready |
| [03](./03-projects-schema.md) | Projects Schema | ✅ Ready |
| [04](./04-migrate-conversations.md) | Migrate Conversations | ✅ Ready |
| [05](./05-config-management.md) | Config Management | ✅ Ready |
| [06](./06-update-apis.md) | Update APIs | ✅ Ready |

### Phase 1b: Files & Retrieval

| Step | Name | Status |
|------|------|--------|
| 00 | **Write Phase 1b Specs** | 📝 TODO |
| 07 | File Storage Schema | 📝 TODO |
| 08 | File Upload/Read APIs | 📝 TODO |
| 09 | Chunking & Indexing | 📝 TODO |
| 10 | FTS5 Search Endpoint | 📝 TODO |
| 11 | Update System Prompts | 📝 TODO |

### Phase 1c: Code Execution (Optional)

| Step | Name | Status |
|------|------|--------|
| 00 | **Write Phase 1c Specs** | 📝 TODO |
| 12 | Pyodide Integration | 📝 TODO |
| 13 | Filesystem Materialization | 📝 TODO |
| 14 | Tool Persistence | 📝 TODO |
| 15 | Code Execution in API | 📝 TODO |

### Phase 2: Enhanced Retrieval

| Step | Name | Status |
|------|------|--------|
| 00 | **Write Phase 2 Specs** | 📝 TODO |
| 16 | Token Budget Management | 📝 TODO |
| 17 | Auto-Retrieval | 📝 TODO |
| 18 | Agentic Search Tool | 📝 TODO |
| 19 | Conversation Summaries | 📝 TODO |

### Phase 3+: Advanced Features

| Step | Name | Status |
|------|------|--------|
| 00 | **Write Phase 3 Specs** | 📝 TODO |
| 20 | Local Embeddings | 📝 TODO |
| 21 | Hybrid Search | 📝 TODO |
| 22 | Multi-User Schema | 📝 TODO |
| 23 | Cost Tracking | 📝 TODO |

## Status Legend

- ✅ **Ready**: Spec complete, can be implemented
- 📝 **TODO**: Spec needs to be written
- 🚧 **In Progress**: Currently being implemented
- ✓ **Done**: Implemented and merged

## Creating New Specs

Use this template for new specs:

```markdown
# Step XX: Title

**Phase**: Phase name
**Complexity**: Low/Medium/High (estimate hours)
**Dependencies**: Links to prerequisite steps
**Can Parallelize**: Yes/No

[← Back to Roadmap](../ROADMAP.md)

## Goal

One sentence description of what this step achieves.

## Success Criteria

- [ ] Checklist item 1
- [ ] Checklist item 2

## Implementation

### 1. First Major Task

Code, commands, explanations...

### 2. Second Major Task

More details...

## Files Changed

- `file/path.js` - Description of changes

## Testing

How to verify this works.

## Validation

Queries or commands to check correctness.

## Notes

Context, decisions, gotchas.

## Next Step

Link to the next spec in sequence.
```

---

[← Back to Roadmap](../ROADMAP.md) | [→ Start with Step 01](./01-sqlite-setup.md)
