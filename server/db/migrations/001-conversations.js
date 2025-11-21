const { db } = require('../index');

function up() {
  console.log('Running migration: 001-conversations');

  // Read schema from file
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'schema.sql'),
    'utf-8'
  );

  // Extract conversations-related statements
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s && (
      s.includes('CREATE TABLE conversations') ||
      s.includes('CREATE TABLE conversation_messages') ||
      s.includes('CREATE VIEW conversation_rounds') ||
      s.includes('CREATE INDEX idx_conversations') ||
      s.includes('CREATE INDEX idx_messages')
    ));

  // Execute in transaction
  db.transaction(() => {
    for (const stmt of statements) {
      if (stmt) db.exec(stmt + ';');
    }
  })();

  console.log('✓ Conversations tables created');
}

function down() {
  console.log('Rolling back migration: 001-conversations');

  db.transaction(() => {
    db.exec('DROP VIEW IF EXISTS conversation_rounds;');
    db.exec('DROP TABLE IF EXISTS conversation_messages;');
    db.exec('DROP TABLE IF EXISTS conversations;');
  })();

  console.log('✓ Conversations tables dropped');
}

module.exports = { up, down };
