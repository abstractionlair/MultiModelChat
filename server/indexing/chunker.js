/**
 * Chunking utilities for splitting content into retrievable segments
 */

const CHUNK_SIZE_LINES = 50; // Lines per chunk

/**
 * Estimate token count (simple heuristic)
 * More accurate tokenizers can be added later
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // Rule of thumb: ~4 characters per token
  return Math.ceil(text.length / 4);
}

/**
 * Chunk file content into segments
 */
function chunkFileContent(content, filePath, projectId) {
  const lines = content.split('\n');
  const chunks = [];

  for (let i = 0; i < lines.length; i += CHUNK_SIZE_LINES) {
    const chunkLines = lines.slice(i, i + CHUNK_SIZE_LINES);
    const chunkContent = chunkLines.join('\n');

    const startLine = i + 1; // 1-indexed
    const endLine = Math.min(i + CHUNK_SIZE_LINES, lines.length);

    // Calculate character offsets
    const startChar = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0); // +1 for newline
    const endChar = startChar + chunkContent.length;

    chunks.push({
      index: Math.floor(i / CHUNK_SIZE_LINES),
      content: chunkContent,
      location: {
        path: filePath,
        start_line: startLine,
        end_line: endLine,
        start_char: startChar,
        end_char: endChar
      },
      tokenCount: estimateTokens(chunkContent),
      metadata: {
        path: filePath,
        type: 'file',
        lines: endLine - startLine + 1
      }
    });
  }

  return chunks;
}

/**
 * Chunk conversation message
 * Messages are not split - one chunk per message
 */
function chunkMessage(content, conversationId, roundNumber, speaker, projectId) {
  return [{
    index: 0,
    content: content,
    location: {
      round_number: roundNumber,
      speaker: speaker
    },
    tokenCount: estimateTokens(content),
    metadata: {
      type: 'conversation',
      conversation_id: conversationId,
      round: roundNumber,
      speaker: speaker
    }
  }];
}

module.exports = {
  chunkFileContent,
  chunkMessage,
  estimateTokens,
  CHUNK_SIZE_LINES
};
