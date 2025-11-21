const { db, newId } = require('./index');
const { runMigrations } = require('./migrate');

// Run migrations
runMigrations();

// Ensure projects table exists for the foreign key constraint
// In a real scenario, this would be created by the projects migration.
// For this test, we'll create it if it doesn't exist to avoid FK errors if enabled.
// Note: Foreign keys are not enabled by default in the connection setup in index.js,
// but we should still mock the table if we want to be robust or if we enable FKs later.
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
`);


// Test data insertion
const projectId = newId('proj');
const convId = newId('conv');

try {
  db.prepare(`
    INSERT INTO projects (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(projectId, 'Test Project', Date.now(), Date.now());

  db.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at, round_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(convId, projectId, 'Test Conversation', Date.now(), Date.now(), 1);

  // Insert messages for round 1
  const userMsgId = newId('msg');
  const agentMsgId = newId('msg');

  db.prepare(`
    INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userMsgId, convId, 1, 'user', 'Hello!', JSON.stringify({ ts: Date.now() }), Date.now());

  db.prepare(`
    INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(agentMsgId, convId, 1, 'agent:gpt-4', 'Hi there!', JSON.stringify({ modelId: 'gpt-4', ts: Date.now() }), Date.now());

  // Query back via view
  const rounds = db.prepare(`
    SELECT * FROM conversation_rounds WHERE conversation_id = ?
  `).all(convId);

  console.log('Rounds:', JSON.stringify(rounds, null, 2));

  // Query individual messages
  const messages = db.prepare(`
    SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY round_number, created_at
  `).all(convId);

  console.log('Messages:', messages);

  if (rounds.length === 1 && messages.length === 2) {
      console.log('\n✓ Conversations schema test passed!');
  } else {
      console.error('\n❌ Conversations schema test failed!');
      process.exit(1);
  }

} catch (err) {
  console.error('Test failed with error:', err);
  process.exit(1);
}
