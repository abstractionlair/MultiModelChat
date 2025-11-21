const crypto = require('crypto');
const path = require('path');

/**
 * Validate project file path
 * Prevents directory traversal attacks
 */
function validatePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Path is required and must be a string');
  }

  // Reject absolute paths and parent directory references
  if (filePath.startsWith('/') || filePath.includes('..')) {
    throw new Error('Invalid path: must be relative within project');
  }

  // Normalize and double-check
  const normalized = path.normalize(filePath);
  if (normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error('Invalid path after normalization');
  }

  return normalized;
}

/**
 * Compute SHA256 hash of content
 */
function computeHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Detect MIME type from file extension
 */
function detectMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.py': 'text/x-python',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.css': 'text/css',
    '.xml': 'application/xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

module.exports = { validatePath, computeHash, detectMimeType };
