/**
 * Test the MMC-3 fixes: conversation messages get indexed and become
 * searchable; replacing a file (same id via upsert) purges stale chunks so
 * search serves the new content, not the old; backfillMessages covers
 * pre-existing history.
 *
 * Usage: node server/indexing/test-index-freshness.js
 */

process.env.DB_PATH = require('path').join(require('os').tmpdir(), `mmc-test-index-${process.pid}.db`);

const crypto = require('crypto');
const { runMigrations } = require('../db/migrate');
runMigrations();

const { db, newId } = require('../db/index');
const { indexFile, indexMessage, backfillMessages } = require('./indexer');
const { search } = require('./search');

let failures = 0;

function check(name, cond) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}`);
  }
}

function sha(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

const now = Date.now();
const projectId = newId('proj');
db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Index Freshness Test', now, now);

async function main() {
  // --- File replace: stale chunks must be purged ---
  const fileId = newId('file');
  const v1 = 'The zebrafish experiment ran on Tuesday and produced clean data.';
  db.prepare(`
    INSERT INTO project_files (id, project_id, path, content, content_hash, size_bytes, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fileId, projectId, 'notes/experiment.md', v1, sha(v1), v1.length, JSON.stringify({ retrieval_eligible: true }), now, now);

  await indexFile(fileId);
  let hits = search(projectId, 'zebrafish');
  check('v1 content searchable after first index', hits.results.length > 0);

  // Unchanged re-call skips (startup/reindex path stays cheap)
  const again = await indexFile(fileId);
  check('unchanged file skips reindex', again.skipped === true);

  // Simulate the upload route's upsert-replace: same row id, new content +
  // hash, metadata overwritten (which drops indexed_hash, as the route does)
  const v2 = 'The axolotl trial moved to Thursday with revised protocols.';
  db.prepare(`
    UPDATE project_files SET content = ?, content_hash = ?, size_bytes = ?, metadata = ?, updated_at = ?
    WHERE id = ?
  `).run(v2, sha(v2), v2.length, JSON.stringify({ retrieval_eligible: true }), Date.now(), fileId);

  await indexFile(fileId);
  hits = search(projectId, 'zebrafish');
  check('old content gone from search after replace', hits.results.length === 0);
  hits = search(projectId, 'axolotl');
  check('new content searchable after replace', hits.results.length > 0);

  const chunkCount = db.prepare(
    `SELECT COUNT(*) as c FROM content_chunks WHERE source_type = 'file' AND source_id = ?`
  ).get(fileId).c;
  const ftsCount = db.prepare(
    `SELECT COUNT(*) as c FROM retrieval_index WHERE chunk_id IN
     (SELECT id FROM content_chunks WHERE source_type = 'file' AND source_id = ?)`
  ).get(fileId).c;
  check('chunk and FTS row counts match (no orphans)', chunkCount === ftsCount);

  // --- Messages: indexMessage makes conversation content searchable ---
  const convId = newId('conv');
  db.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at, round_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(convId, projectId, 'Test conversation', now, now, 1);

  const msgId = newId('msg');
  db.prepare(`
    INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(msgId, convId, 1, 'user', 'Please summarize the quokka census results.', '{}', now);

  indexMessage(msgId);
  hits = search(projectId, 'quokka');
  check('message content searchable after indexMessage', hits.results.length > 0);

  const twice = indexMessage(msgId);
  check('already-indexed message skips', twice.skipped === true);

  const empty = db.prepare(`
    INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const emptyId = newId('msg');
  empty.run(emptyId, convId, 1, 'agent:mock', '', '{}', now);
  check('empty message skips without error', indexMessage(emptyId).skipped === true);

  // --- Backfill: pre-existing unindexed messages get covered ---
  const oldMsgId = newId('msg');
  db.prepare(`
    INSERT INTO conversation_messages (id, conversation_id, round_number, speaker, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(oldMsgId, convId, 1, 'agent:mock', 'Historic wombat sighting logged before indexing existed.', '{}', now);

  const backfill = backfillMessages();
  check('backfill indexes the unindexed message', backfill.indexed >= 1 && backfill.failed === 0);
  hits = search(projectId, 'wombat');
  check('backfilled message searchable', hits.results.length > 0);

  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll index-freshness checks passed');
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
