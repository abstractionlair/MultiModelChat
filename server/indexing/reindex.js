#!/usr/bin/env node

/**
 * Reindex all files or a specific project
 * Usage:
 *   node server/indexing/reindex.js [projectId]
 */

const { db } = require('../db/index');
const { runMigrations } = require('../db/migrate');
const { reindexProject } = require('./indexer');

async function main() {
  console.log('Starting reindexing...\n');

  runMigrations();

  const args = process.argv.slice(2);
  let projectIds;

  if (args.length > 0) {
    projectIds = args;
  } else {
    const projects = db.prepare('SELECT id FROM projects').all();
    projectIds = projects.map(p => p.id);
  }

  console.log(`Reindexing ${projectIds.length} project(s)...\n`);

  for (const projectId of projectIds) {
    console.log(`\n=== Project: ${projectId} ===`);

    const deleted = db.prepare(`
      DELETE FROM content_chunks
      WHERE project_id = ? AND source_type = 'file'
    `).run(projectId);

    console.log(`Cleared ${deleted.changes} existing chunks`);

    const results = await reindexProject(projectId);

    const success = results.filter(r => !r?.error && !r?.skipped).length;
    const skipped = results.filter(r => r?.skipped).length;
    const failed = results.filter(r => r?.error).length;

    console.log(`\nResults: ${success} indexed, ${skipped} skipped, ${failed} failed`);
  }

  console.log('\n✓ Reindexing complete!');
}

main().catch(err => {
  console.error('Reindexing failed:', err);
  process.exit(1);
});
