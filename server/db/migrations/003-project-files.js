const { db } = require('../index');

function up() {
  console.log('Running migration: 003-project-files');

  db.exec(`
    CREATE TABLE project_files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT,
      content_location TEXT,
      content_hash TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      UNIQUE(project_id, path)
    );
  `);

  db.exec('CREATE INDEX idx_project_files_project ON project_files(project_id);');
  db.exec('CREATE INDEX idx_project_files_path ON project_files(project_id, path);');
  db.exec('CREATE INDEX idx_project_files_hash ON project_files(content_hash);');

  console.log('✓ Project files table created');
  console.log('✓ Indexes created');
}

function down() {
  console.log('Rolling back migration: 003-project-files');
  db.exec('DROP TABLE IF EXISTS project_files;');
  console.log('✓ Project files table dropped');
}

module.exports = { up, down };
