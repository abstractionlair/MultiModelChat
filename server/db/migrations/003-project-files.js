const { db } = require('../index');
const fs = require('fs');
const path = require('path');

function up() {
  console.log('Running migration: 003-project-files');

  // Read schema
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Extract project_files table definition
  const statements = schema
    .split(';')
    .filter(s =>
      s.includes('CREATE TABLE project_files') ||
      s.includes('CREATE INDEX idx_project_files')
    );

  // Execute statements
  for (const stmt of statements) {
    if (stmt.trim()) {
      db.exec(stmt + ';');
    }
  }

  console.log('✓ project_files table created');
  console.log('✓ Indexes created');
}

function down() {
  console.log('Rolling back migration: 003-project-files');
  db.exec('DROP INDEX IF EXISTS idx_project_files_path;');
  db.exec('DROP INDEX IF EXISTS idx_project_files_project;');
  db.exec('DROP TABLE IF EXISTS project_files;');
  console.log('✓ project_files table dropped');
}

module.exports = { up, down };
