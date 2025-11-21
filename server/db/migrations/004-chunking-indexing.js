const { db } = require('../index');

function up() {
  console.log('Running migration: 004-chunking-indexing');

  db.exec(`
    CREATE TABLE IF NOT EXISTS content_chunks (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      chunk_index INTEGER,
      content TEXT NOT NULL,
      location TEXT,
      summary TEXT,
      token_count INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_source ON content_chunks(source_type, source_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_project ON content_chunks(project_id);');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_index USING fts5(
      chunk_id UNINDEXED,
      project_id UNINDEXED,
      content,
      metadata UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);

  db.exec('DROP TRIGGER IF EXISTS cleanup_file_chunks;');
  db.exec(`
    CREATE TRIGGER cleanup_file_chunks
    AFTER DELETE ON project_files
    BEGIN
      DELETE FROM content_chunks WHERE source_type = 'file' AND source_id = OLD.id;
    END;
  `);

  db.exec('DROP TRIGGER IF EXISTS cleanup_message_chunks;');
  db.exec(`
    CREATE TRIGGER cleanup_message_chunks
    AFTER DELETE ON conversation_messages
    BEGIN
      DELETE FROM content_chunks WHERE source_type = 'conversation_message' AND source_id = OLD.id;
    END;
  `);

  db.exec('DROP TRIGGER IF EXISTS cleanup_fts_chunks;');
  db.exec(`
    CREATE TRIGGER cleanup_fts_chunks
    AFTER DELETE ON content_chunks
    BEGIN
      DELETE FROM retrieval_index WHERE chunk_id = OLD.id;
    END;
  `);

  console.log('✓ content_chunks table created');
  console.log('✓ retrieval_index FTS5 table created');
  console.log('✓ Cleanup triggers created');
}

function down() {
  console.log('Rolling back migration: 004-chunking-indexing');
  db.exec('DROP TRIGGER IF EXISTS cleanup_fts_chunks;');
  db.exec('DROP TRIGGER IF EXISTS cleanup_message_chunks;');
  db.exec('DROP TRIGGER IF EXISTS cleanup_file_chunks;');
  db.exec('DROP TABLE IF EXISTS retrieval_index;');
  db.exec('DROP INDEX IF EXISTS idx_chunks_project;');
  db.exec('DROP INDEX IF EXISTS idx_chunks_source;');
  db.exec('DROP TABLE IF EXISTS content_chunks;');
  console.log('✓ Chunking & indexing tables dropped');
}

module.exports = { up, down };
