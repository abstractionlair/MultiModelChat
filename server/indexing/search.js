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
