const fs = require('fs/promises');
const { db, newId } = require('../db/index');
const { chunkFileContent, chunkMessage } = require('./chunker');

/**
 * Index a file: chunk it and add to search index
 */
async function indexFile(fileId) {
  const file = db.prepare(`
    SELECT id, project_id, path, content, content_location, content_hash, metadata
    FROM project_files
    WHERE id = ?
  `).get(fileId);

  if (!file) {
    throw new Error(`File not found: ${fileId}`);
  }

  const metadata = file.metadata ? JSON.parse(file.metadata) : {};

  const existing = db.prepare(`
    SELECT COUNT(*) as count
    FROM content_chunks
    WHERE source_type = 'file' AND source_id = ?
  `).get(fileId);

  if (existing.count > 0) {
    // Replacing a file keeps its id (upsert on project_id+path), so existing
    // chunks may describe old content. Only skip when the indexed hash still
    // matches; otherwise purge and reindex. Chunks without an indexed_hash
    // predate this check and get reindexed once.
    if (metadata.indexed_hash && metadata.indexed_hash === file.content_hash) {
      console.log(`File ${fileId} unchanged since last index, skipping`);
      return { skipped: true };
    }
    const removed = removeChunks('file', fileId);
    console.log(`File ${fileId} content changed: removed ${removed} stale chunks, reindexing`);
  }

  let content = file.content;
  if (!content && file.content_location) {
    content = await fs.readFile(file.content_location, 'utf8');
  }

  if (!content) {
    console.log(`File ${fileId} has no content, skipping index`);
    return { skipped: true };
  }

  if (metadata.retrieval_eligible === false) {
    console.log(`File ${fileId} not eligible for retrieval, skipping`);
    return { skipped: true };
  }

  const chunks = chunkFileContent(content, file.path, file.project_id);

  const insertChunk = db.prepare(`
    INSERT INTO content_chunks (
      id, source_type, source_id, project_id, chunk_index,
      content, location, token_count, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertIndex = db.prepare(`
    INSERT INTO retrieval_index (chunk_id, project_id, content, metadata)
    VALUES (?, ?, ?, ?)
  `);

  const now = Date.now();
  const chunkIds = [];

  db.transaction(() => {
    for (const chunk of chunks) {
      const chunkId = newId('chunk');
      chunkIds.push(chunkId);

      insertChunk.run(
        chunkId,
        'file',
        fileId,
        file.project_id,
        chunk.index,
        chunk.content,
        JSON.stringify(chunk.location),
        chunk.tokenCount,
        now
      );

      insertIndex.run(
        chunkId,
        file.project_id,
        chunk.content,
        JSON.stringify(chunk.metadata)
      );
    }
  })();

  const updatedMetadata = { ...metadata, last_indexed_at: now, indexed_hash: file.content_hash };
  db.prepare(`
    UPDATE project_files
    SET metadata = ?
    WHERE id = ?
  `).run(JSON.stringify(updatedMetadata), fileId);

  console.log(`✓ Indexed file ${fileId}: ${chunks.length} chunks`);

  return {
    fileId,
    chunks: chunks.length,
    chunkIds
  };
}

/**
 * Remove all chunks for a source. The cleanup_fts_chunks trigger cascades
 * each content_chunks delete to retrieval_index.
 */
function removeChunks(sourceType, sourceId) {
  const res = db.prepare(`
    DELETE FROM content_chunks WHERE source_type = ? AND source_id = ?
  `).run(sourceType, sourceId);
  return res.changes;
}

/**
 * Index a conversation message
 */
function indexMessage(messageId) {
  const message = db.prepare(`
    SELECT id, conversation_id, round_number, speaker, content, metadata
    FROM conversation_messages
    WHERE id = ?
  `).get(messageId);

  if (!message) {
    throw new Error(`Message not found: ${messageId}`);
  }

  if (!message.content || !message.content.trim()) {
    return { skipped: true };
  }

  const conv = db.prepare(`
    SELECT project_id FROM conversations WHERE id = ?
  `).get(message.conversation_id);

  if (!conv) {
    throw new Error(`Conversation not found: ${message.conversation_id}`);
  }

  const existing = db.prepare(`
    SELECT COUNT(*) as count
    FROM content_chunks
    WHERE source_type = 'conversation_message' AND source_id = ?
  `).get(messageId);

  if (existing.count > 0) {
    console.log(`Message ${messageId} already indexed, skipping`);
    return { skipped: true };
  }

  const chunks = chunkMessage(
    message.content,
    message.conversation_id,
    message.round_number,
    message.speaker,
    conv.project_id
  );

  const now = Date.now();
  const chunk = chunks[0];
  const chunkId = newId('chunk');

  db.transaction(() => {
    db.prepare(`
      INSERT INTO content_chunks (
        id, source_type, source_id, project_id, chunk_index,
        content, location, token_count, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chunkId,
      'conversation_message',
      messageId,
      conv.project_id,
      chunk.index,
      chunk.content,
      JSON.stringify(chunk.location),
      chunk.tokenCount,
      now
    );

    db.prepare(`
      INSERT INTO retrieval_index (chunk_id, project_id, content, metadata)
      VALUES (?, ?, ?, ?)
    `).run(
      chunkId,
      conv.project_id,
      chunk.content,
      JSON.stringify(chunk.metadata)
    );
  })();

  console.log(`✓ Indexed message ${messageId}`);

  return { messageId, chunkId };
}

/**
 * Reindex all files in a project
 */
async function reindexProject(projectId) {
  const files = db.prepare(`
    SELECT id FROM project_files WHERE project_id = ?
  `).all(projectId);

  console.log(`Reindexing ${files.length} files in project ${projectId}...`);

  const results = [];
  for (const file of files) {
    try {
      const result = await indexFile(file.id);
      results.push(result);
    } catch (err) {
      console.error(`Failed to index file ${file.id}:`, err);
      results.push({ fileId: file.id, error: err.message });
    }
  }

  return results;
}

/**
 * Index every conversation message that has no chunks yet. Messages are
 * immutable, so "no chunks" is the only staleness case. Run once after
 * deploying message indexing to cover pre-existing history.
 */
function backfillMessages() {
  const rows = db.prepare(`
    SELECT m.id
    FROM conversation_messages m
    LEFT JOIN content_chunks c
      ON c.source_type = 'conversation_message' AND c.source_id = m.id
    WHERE c.id IS NULL AND m.content IS NOT NULL AND m.content != ''
  `).all();

  console.log(`Backfilling ${rows.length} unindexed messages...`);

  let indexed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = indexMessage(row.id);
      if (!result.skipped) indexed++;
    } catch (err) {
      failed++;
      console.error(`Failed to index message ${row.id}:`, err.message);
    }
  }

  return { candidates: rows.length, indexed, failed };
}

module.exports = {
  indexFile,
  indexMessage,
  reindexProject,
  removeChunks,
  backfillMessages
};
