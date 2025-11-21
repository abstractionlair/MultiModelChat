const { db, newId } = require('./index');
const { runMigrations } = require('./migrate');
const { migrateConversationsToSQLite, loadConversationsFromSQLite } = require('./migrate-memory-to-sqlite');

// Ensure DB is fresh-ish (or at least migrated)
runMigrations();

// Create mock in-memory conversations
const mockConversations = new Map();
const convId = newId('conv');

mockConversations.set(convId, {
    id: convId,
    title: 'Test Conversation',
    rounds: [
        {
            user: { speaker: 'user', content: 'Hello', ts: Date.now() },
            agents: [
                { speaker: 'agent:gpt-4', modelId: 'gpt-4', content: 'Hi!', ts: Date.now() }
            ]
        }
    ]
});

console.log('Mock conversation created:', convId);

// Clean up ALL existing conversations to ensure migration runs
// (The migration helper skips if ANY conversations exist)
db.prepare('DELETE FROM conversation_messages').run();
db.prepare('DELETE FROM conversations').run();

// Migrate
console.log('Migrating...');
migrateConversationsToSQLite(mockConversations);

// Load back
console.log('Loading back...');
const loaded = loadConversationsFromSQLite();

const loadedConv = loaded.get(convId);
console.log('Original rounds:', mockConversations.get(convId).rounds.length);
console.log('Loaded rounds:', loadedConv ? loadedConv.rounds.length : 'NOT FOUND');

if (loadedConv && loadedConv.rounds.length === 1 && loadedConv.rounds[0].user.content === 'Hello') {
    console.log('\n✓ Migration test passed!');
} else {
    console.error('\n✗ Migration test failed!');
    console.error('Loaded:', JSON.stringify(loadedConv, null, 2));
    process.exit(1);
}
