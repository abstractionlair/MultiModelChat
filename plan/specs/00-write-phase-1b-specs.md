# Step 00: Write Phase 1b Specs

**Phase**: 1b - Files & Retrieval
**Complexity**: Low (1-2 hours)
**Dependencies**: Phase 1a complete
**Can Parallelize**: No - do at start of Phase 1b

[← Back to Roadmap](../ROADMAP.md)

## Goal

Write detailed implementation specs for Phase 1b steps (07-11) covering file storage, upload/read APIs, chunking, indexing, and system prompt updates.

## Success Criteria

- [ ] Spec 07: File Storage Schema - written
- [ ] Spec 08: File Upload/Read APIs - written
- [ ] Spec 09: Chunking & Indexing - written
- [ ] Spec 10: FTS5 Search Endpoint - written
- [ ] Spec 11: Update System Prompts - written
- [ ] All specs follow the established pattern from Phase 1a
- [ ] Cross-links between specs are correct
- [ ] Each spec is scoped to one session/PR

## Spec Template

Use the pattern from Phase 1a specs. Each spec should include:

1. **Header**: Phase, complexity, dependencies, parallelization
2. **Goal**: One-sentence what we're achieving
3. **Success Criteria**: Checklist of deliverables
4. **Schema/Design**: SQL, API routes, or architecture
5. **Implementation**: Step-by-step code changes with file paths
6. **Files Changed**: List of touched files
7. **Testing**: How to verify it works
8. **Validation**: Commands/queries to check correctness
9. **Notes**: Context, decisions, gotchas
10. **Next Step**: Link to next spec

## Topics to Cover

### Spec 07: File Storage Schema
- `project_files` table design
- Hybrid storage (< 1MB in DB, > 1MB on disk)
- Indexes for efficient queries
- Content hash for change detection
- Metadata JSON structure

### Spec 08: File Upload/Read APIs
- `POST /api/projects/:id/files` - Upload file
- `GET /api/projects/:id/files` - List files
- `GET /api/projects/:id/files/:fileId` - Read file content
- `DELETE /api/projects/:id/files/:fileId` - Delete file
- Path validation (prevent directory traversal)
- File size limits and streaming

### Spec 09: Chunking & Indexing
- `content_chunks` table design
- `retrieval_index` FTS5 virtual table
- Chunking strategy (50 lines per chunk for code)
- Token estimation
- Automatic indexing on file upload
- Cleanup triggers for deleted files
- Background reindexing utility

### Spec 10: FTS5 Search Endpoint
- `POST /api/projects/:id/search` - Search endpoint
- Query escaping for FTS5 injection prevention
- Result formatting with line numbers
- Pagination support
- Filter by file type or path

### Spec 11: Update System Prompts
- Extend system prompt template to include file list
- Format file listing (count, paths, sizes)
- Conditional: only show if files exist
- Keep under token budget

## Implementation Notes

Reference ARCHITECTURE.md sections:
- Data Model (schema designs)
- Code Execution Lifecycle (materialization for Phase 1c)
- Indexing Pipeline (chunking strategy)
- Storage Strategy (hybrid approach)

## Deliverable

Five markdown files in `plan/specs/`:
- `07-file-storage.md`
- `08-file-apis.md`
- `09-chunking-indexing.md`
- `10-search-endpoint.md`
- `11-system-prompts.md`

## Next Step

After completing these specs:
[07: File Storage Schema](./07-file-storage.md) - Implement the first spec
