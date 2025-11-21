const { db, newId } = require('../index');

function up() {
  console.log('Running migration: 002-projects');

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      settings TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Create default project
  const defaultProjectId = newId('proj');
  const now = Date.now();

  db.prepare(`
    INSERT INTO projects (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    defaultProjectId,
    'Default Project',
    'Auto-created default project',
    now,
    now
  );

  console.log('✓ Projects table created');
  console.log('✓ Default project created:', defaultProjectId);

  // Store default project ID in config for easy access
  db.prepare(`
    INSERT OR REPLACE INTO config (key, value, updated_at)
    VALUES (?, ?, ?)
  `).run('default_project_id', defaultProjectId, now);
}

function down() {
  console.log('Rolling back migration: 002-projects');
  db.exec('DROP TABLE IF EXISTS projects;');
  db.prepare('DELETE FROM config WHERE key = ?').run('default_project_id');
  console.log('✓ Projects table dropped');
}

module.exports = { up, down };
