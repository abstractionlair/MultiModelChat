const { db, newId, getDefaultProjectId } = require('./index');

/**
 * Migrate in-memory conversations to SQLite
 * @param {Map} conversationsMap - The in-memory Map from server.js
 */
function migrateConversationsToSQLite(conversationsMap) {
    const defaultProjectId = getDefaultProjectId();
    let migrated = 0;

    // Check if any conversations already exist
    const existing = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
    if (existing.count > 0) {
        console.log(`Found ${existing.count} existing conversations in DB, skipping migration`);
        return;
    }

    console.log(`Migrating ${conversationsMap.size} conversations to SQLite...`);

    const insertConversation = db.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at, round_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

    const insertMessage = db.prepare(`
    INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

    db.transaction(() => {
        for (const [convId, conv] of conversationsMap.entries()) {
            // Insert conversation record
            const now = Date.now();
            insertConversation.run(
                convId,
                defaultProjectId,
                conv.title || `Conversation ${convId}`,
                conv.created_at || now,
                conv.updated_at || now,
                conv.rounds?.length || 0
            );

            // Insert messages from each round
            if (conv.rounds && Array.isArray(conv.rounds)) {
                for (let roundNum = 0; roundNum < conv.rounds.length; roundNum++) {
                    const round = conv.rounds[roundNum];

                    // User message
                    if (round.user) {
                        const userMsgId = newId('msg');
                        insertMessage.run(
                            userMsgId,
                            convId,
                            roundNum + 1, // 1-indexed
                            'user',
                            round.user.content || '',
                            JSON.stringify({
                                ts: round.user.ts || now,
                                attachments: round.attachments
                            }),
                            round.user.ts || now
                        );
                    }

                    // Agent messages
                    if (round.agents && Array.isArray(round.agents)) {
                        for (const agent of round.agents) {
                            const agentMsgId = newId('msg');
                            insertMessage.run(
                                agentMsgId,
                                convId,
                                roundNum + 1,
                                agent.speaker || `agent:${agent.modelId}`,
                                agent.content || '',
                                JSON.stringify({
                                    modelId: agent.modelId,
                                    agentId: agent.agentId,
                                    usage: agent.usage,
                                    ts: agent.ts || now
                                }),
                                agent.ts || now
                            );
                        }
                    }
                }
            }

            migrated++;
        }
    })();

    console.log(`✓ Migrated ${migrated} conversations to SQLite`);
}

/**
 * Load conversations from SQLite into in-memory Map
 * @returns {Map} Conversations Map
 */
function loadConversationsFromSQLite() {
    const conversations = new Map();

    const allConvs = db.prepare('SELECT * FROM conversations').all();

    for (const conv of allConvs) {
        const messages = db.prepare(`
      SELECT * FROM conversation_messages
      WHERE conversation_id = ?
      ORDER BY round_number, created_at
    `).all(conv.id);

        // Reconstruct rounds structure
        const rounds = [];
        const roundsMap = new Map();

        for (const msg of messages) {
            if (!roundsMap.has(msg.round_number)) {
                roundsMap.set(msg.round_number, { user: null, agents: [] });
            }

            const round = roundsMap.get(msg.round_number);
            const metadata = msg.metadata ? JSON.parse(msg.metadata) : {};

            if (msg.speaker === 'user') {
                round.user = {
                    speaker: 'user',
                    content: msg.content,
                    ts: metadata.ts || msg.created_at
                };
                if (metadata.attachments) {
                    round.attachments = metadata.attachments;
                }
            } else {
                round.agents.push({
                    speaker: msg.speaker,
                    modelId: metadata.modelId,
                    agentId: metadata.agentId,
                    content: msg.content,
                    ts: metadata.ts || msg.created_at,
                    usage: metadata.usage
                });
            }
        }

        // Convert map to array
        for (const [roundNum, round] of roundsMap.entries()) {
            rounds[roundNum - 1] = round; // 0-indexed array
        }

        // Get project name
        const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(conv.project_id);
        const projectName = project ? project.name : 'Default Project';

        conversations.set(conv.id, {
            id: conv.id,
            projectId: conv.project_id, // camelCase for consistency
            project_id: conv.project_id, // keep for backward compatibility
            projectName,
            title: conv.title,
            rounds,
            perModelState: {}, // TODO: Add persistence for this later
            autoSave: conv.auto_save ? JSON.parse(conv.auto_save) : undefined,
            created_at: conv.created_at,
            updated_at: conv.updated_at
        });
    }

    console.log(`✓ Loaded ${conversations.size} conversations from SQLite`);
    return conversations;
}

module.exports = { migrateConversationsToSQLite, loadConversationsFromSQLite };
