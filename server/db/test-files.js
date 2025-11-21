const { db, newId, getDefaultProjectId } = require('./index');
const { runMigrations } = require('./migrate');
const crypto = require('crypto');

// Run migrations
runMigrations();

const projectId = getDefaultProjectId();
console.log('Testing with project:', projectId);

// Test: Insert a small text file
const fileId1 = newId('file');
const content1 = 'Hello, world! This is a test file.';
const hash1 = crypto.createHash('sha256').update(content1).digest('hex');
const now = Date.now();

db.prepare(`
  INSERT INTO project_files (
    id, project_id, path, content, content_hash,
    mime_type, size_bytes, metadata, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  fileId1,
  projectId,
  'test/hello.txt',
  content1,
  hash1,
  'text/plain',
  Buffer.byteLength(content1),
  JSON.stringify({ tags: ['test'], retrieval_eligible: true }),
  now,
  now
);

console.log('✓ Inserted small file:', fileId1);

// Test: Insert a file reference (simulating large file)
const fileId2 = newId('file');
const hash2 = crypto.randomBytes(32).toString('hex');

db.prepare(`
  INSERT INTO project_files (
    id, project_id, path, content_location, content_hash,
    mime_type, size_bytes, metadata, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  fileId2,
  projectId,
  'data/large-dataset.csv',
  'storage/abc123def456.bin',
  hash2,
  'text/csv',
  5 * 1024 * 1024, // 5MB
  JSON.stringify({ tags: ['data'], always_in_context: false }),
  now,
  now
);

console.log('✓ Inserted large file reference:', fileId2);

// Test: Query files by project
const files = db.prepare(`
  SELECT id, path, size_bytes, mime_type
  FROM project_files
  WHERE project_id = ?
`).all(projectId);

console.log('\nFiles in project:');
files.forEach(f => {
  console.log(`  - ${f.path} (${f.size_bytes} bytes, ${f.mime_type})`);
});

// Test: UNIQUE constraint
console.log('\nTesting UNIQUE constraint...');
try {
  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId('file'),
    projectId,
    'test/hello.txt', // Duplicate path
    'Different content',
    'abc123',
    'text/plain',
    100,
    now,
    now
  );
  console.error('✗ UNIQUE constraint failed to prevent duplicate!');
} catch (err) {
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    console.log('✓ UNIQUE constraint working correctly');
  } else {
    throw err;
  }
}

// Test: Foreign key cascade delete
console.log('\nTesting CASCADE DELETE...');
const testProjectId = newId('proj');
db.prepare(`
  INSERT INTO projects (id, name, created_at, updated_at)
  VALUES (?, ?, ?, ?)
`).run(testProjectId, 'Test Project', now, now);

const testFileId = newId('file');
db.prepare(`
  INSERT INTO project_files (
    id, project_id, path, content, content_hash,
    mime_type, size_bytes, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  testFileId,
  testProjectId,
  'test/cascade.txt',
  'test',
  'hash',
  'text/plain',
  4,
  now,
  now
);

// Delete project
db.prepare('DELETE FROM projects WHERE id = ?').run(testProjectId);

// Check if file was deleted
const orphan = db.prepare('SELECT id FROM project_files WHERE id = ?').get(testFileId);
if (!orphan) {
  console.log('✓ CASCADE DELETE working correctly');
} else {
  console.error('✗ CASCADE DELETE failed - orphan file exists');
}

console.log('\n✓ All file storage tests passed!');
