const fs = require('fs/promises');
const { db, newId } = require('../db/index');
const { chunkFileContent, chunkMessage } = require('./chunker');

/**
 * Index a file: chunk it and add to search index
 */
async function indexFile(fileId) {
  const file = db.prepare(`
    SELECT id, project_id, path, content, content_location, metadata
    FROM project_files
    WHERE id = ?
  `).get(fileId);

  if (!file) {
    throw new Error(`File not found: ${fileId}`);
  }

  const existing = db.prepare(`
    SELECT COUNT(*) as count
    FROM content_chunks
    WHERE source_type = 'file' AND source_id = ?
  `).get(fileId);

  if (existing.count > 0) {
    console.log(`File ${fileId} already indexed, skipping`);
    return { skipped: true };
  }

  let content = file.content;
  if (!content && file.content_location) {
    content = await fs.readFile(file.content_location, 'utf8');
  }

  if (!content) {
    console.log(`File ${fileId} has no content, skipping index`);
    return { skipped: true };
  }

  const metadata = file.metadata ? JSON.parse(file.metadata) : {};

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

  const updatedMetadata = { ...metadata, last_indexed_at: now };
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

module.exports = {
  indexFile,
  indexMessage,
  reindexProject
};
