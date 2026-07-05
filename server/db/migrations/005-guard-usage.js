const { db } = require('../index');

function up() {
  console.log('Running migration: 005-guard-usage');

  db.exec(`
    CREATE TABLE IF NOT EXISTS guard_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      utc_date TEXT NOT NULL,
      ip TEXT NOT NULL,
      key_type TEXT NOT NULL DEFAULT 'ip',
      turns INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(utc_date, ip, key_type)
    );
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_guard_usage_date ON guard_usage(utc_date);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_guard_usage_ip ON guard_usage(ip, utc_date);');

  console.log('✓ guard_usage table created');
}

function down() {
  console.log('Rolling back migration: 005-guard-usage');
  db.exec('DROP INDEX IF EXISTS idx_guard_usage_ip;');
  db.exec('DROP INDEX IF EXISTS idx_guard_usage_date;');
  db.exec('DROP TABLE IF EXISTS guard_usage;');
  console.log('✓ guard_usage table dropped');
}

module.exports = { up, down };
