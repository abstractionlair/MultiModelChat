const { db } = require('./index');
const fs = require('fs');
const path = require('path');

// Track migrations

db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at INTEGER NOT NULL
  );
`);

function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.js')).sort();

  for (const file of files) {
    const name = file.replace('.js', '');
    const existing = db.prepare('SELECT name FROM migrations WHERE name = ?').get(name);

    if (!existing) {
      console.log(`Applying migration: ${name}`);
      const migration = require(path.join(migrationsDir, file));
      migration.up();
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
    } else {
      console.log(`Skipping migration: ${name} (already applied)`);
    }
  }

  console.log('All migrations complete');
}

// Run if called directly
if (require.main === module) {
  runMigrations();
}

module.exports = { runMigrations };
