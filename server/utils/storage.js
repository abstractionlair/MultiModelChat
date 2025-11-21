const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

const STORAGE_THRESHOLD = 1024 * 1024; // 1MB

/**
 * Calculate SHA256 hash of content
 */
function calculateHash(content) {
  if (Buffer.isBuffer(content)) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Determine if content should be stored in DB or on disk
 */
function shouldStoreInDB(sizeBytes) {
  return sizeBytes < STORAGE_THRESHOLD;
}

/**
 * Generate unique storage filename
 */
function generateStorageFilename() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Save content to disk storage
 */
async function saveToDisk(content, storageDir) {
  const filename = generateStorageFilename();
  const storagePath = path.join(storageDir, filename);
  await fs.writeFile(storagePath, content);
  return filename; // Return relative path
}

/**
 * Read content from disk storage
 */
async function readFromDisk(filename, storageDir) {
  const storagePath = path.join(storageDir, filename);
  return await fs.readFile(storagePath);
}

/**
 * Delete file from disk storage
 */
async function deleteFromDisk(filename, storageDir) {
  const storagePath = path.join(storageDir, filename);
  try {
    await fs.unlink(storagePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    // File doesn't exist, ignore
  }
}

/**
 * Detect MIME type from filename
 */
function detectMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.py': 'text/x-python',
    '.java': 'text/x-java',
    '.cpp': 'text/x-c++',
    '.c': 'text/x-c',
    '.go': 'text/x-go',
    '.rs': 'text/x-rust',
    '.rb': 'text/x-ruby',
    '.php': 'text/x-php',
    '.sh': 'text/x-shellscript',
    '.sql': 'application/sql',
    '.xml': 'application/xml',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Validate file path (prevent directory traversal)
 */
function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path: must be a non-empty string');
  }

  if (filePath.includes('..') || filePath.startsWith('/')) {
    throw new Error('Invalid file path: must be relative within project');
  }

  const normalized = path.normalize(filePath);
  if (normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error('Invalid file path after normalization');
  }

  return normalized;
}

module.exports = {
  STORAGE_THRESHOLD,
  calculateHash,
  shouldStoreInDB,
  generateStorageFilename,
  saveToDisk,
  readFromDisk,
  deleteFromDisk,
  detectMimeType,
  validateFilePath,
};
