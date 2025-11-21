const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { ulid } = require('ulid');

// Database file location
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data.db');

// Create/open database
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');  // Balance safety and performance
db.pragma('busy_timeout = 5000');   // Wait up to 5s for locks

// Storage directory for large files
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '..', '..', 'storage');

// Create storage directory if it doesn't exist
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Storage threshold (1MB)
const STORAGE_THRESHOLD = 1024 * 1024;

// ID generation utility
function newId(prefix = '') {
  const id = ulid();
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Get the default project ID from config
 */
function getDefaultProjectId() {
  const result = db.prepare('SELECT value FROM config WHERE key = ?')
    .get('default_project_id');

  if (!result) {
    throw new Error('Default project not found - run migrations');
  }

  return result.value;
}

// Graceful shutdown
process.on('exit', () => db.close());
process.on('SIGHUP', () => process.exit(128 + 1));
process.on('SIGINT', () => process.exit(128 + 2));
process.on('SIGTERM', () => process.exit(128 + 15));

module.exports = {
  db,
  newId,
  getDefaultProjectId,
  STORAGE_DIR,
  STORAGE_THRESHOLD
};
