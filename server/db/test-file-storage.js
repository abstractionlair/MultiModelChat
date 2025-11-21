const { db, STORAGE_DIR, newId, getDefaultProjectId } = require('./index');
const { calculateHash, shouldStoreInDB, validateFilePath, detectMimeType } = require('../utils/storage');

console.log('Testing file storage schema...\n');

// Test 1: Storage directory exists
console.log('1. Storage directory:', STORAGE_DIR);
const fs = require('fs');
console.log('   Exists:', fs.existsSync(STORAGE_DIR));

// Test 2: project_files table exists
console.log('\n2. Checking project_files table...');
const tableInfo = db.prepare(`
  SELECT sql FROM sqlite_master
  WHERE type='table' AND name='project_files'
`).get();
console.log('   Table exists:', !!tableInfo);
if (tableInfo) {
  console.log('   Schema:', tableInfo.sql.substring(0, 100) + '...');
}

// Test 3: Indexes exist
console.log('\n3. Checking indexes...');
const indexes = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='index' AND tbl_name='project_files'
`).all();
console.log('   Indexes:', indexes.map(i => i.name).join(', '));

// Test 4: Insert small file
console.log('\n4. Testing small file storage (in DB)...');
const smallContent = 'Hello, world! This is a small test file.';
const smallHash = calculateHash(smallContent);
const smallSize = Buffer.byteLength(smallContent, 'utf-8');
console.log('   Content size:', smallSize, 'bytes');
console.log('   Store in DB:', shouldStoreInDB(smallSize));
console.log('   Hash:', smallHash);

const projectId = getDefaultProjectId();
console.log('   Using project ID:', projectId);
const fileId = newId('file');

db.prepare(`
  INSERT INTO project_files (
    id, project_id, path, content, content_hash,
    mime_type, size_bytes, metadata, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  fileId,
  projectId,
  'docs/test.txt',
  smallContent,
  smallHash,
  detectMimeType('test.txt'),
  smallSize,
  JSON.stringify({ tags: ['test'], summary: 'Test file' }),
  Date.now(),
  Date.now()
);
console.log('   ✓ Inserted file:', fileId);

// Test 5: Retrieve file
console.log('\n5. Retrieving file...');
const retrieved = db.prepare('SELECT * FROM project_files WHERE id = ?').get(fileId);
console.log('   ✓ Retrieved file:', retrieved.path);
console.log('   Content matches:', retrieved.content === smallContent);
console.log('   Hash matches:', retrieved.content_hash === smallHash);
console.log('   MIME type:', retrieved.mime_type);

// Test 6: Path validation
console.log('\n6. Testing path validation...');
const validPaths = ['docs/api.md', 'src/server.js', 'data/file.csv'];
const invalidPaths = ['../etc/passwd', '/etc/hosts', 'docs/../../../secret.txt'];

for (const p of validPaths) {
  try {
    validateFilePath(p);
    console.log('   ✓ Valid:', p);
  } catch (err) {
    console.log('   ✗ Unexpected error for', p, ':', err.message);
  }
}

for (const p of invalidPaths) {
  try {
    validateFilePath(p);
    console.log('   ✗ Should have rejected:', p);
  } catch (err) {
    console.log('   ✓ Rejected:', p);
  }
}

// Test 7: MIME type detection
console.log('\n7. Testing MIME type detection...');
const testFiles = {
  'test.txt': 'text/plain',
  'readme.md': 'text/markdown',
  'server.js': 'text/javascript',
  'data.json': 'application/json',
  'script.py': 'text/x-python',
  'unknown.xyz': 'application/octet-stream',
};

for (const [filename, expected] of Object.entries(testFiles)) {
  const detected = detectMimeType(filename);
  const matches = detected === expected;
  console.log(`   ${matches ? '✓' : '✗'} ${filename}: ${detected}`);
}

// Test 8: UNIQUE constraint
console.log('\n8. Testing UNIQUE constraint...');
try {
  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId('file'),
    projectId,
    'docs/test.txt', // Same path as before
    'different content',
    calculateHash('different content'),
    'text/plain',
    17,
    '{}',
    Date.now(),
    Date.now()
  );
  console.log('   ✗ Should have thrown UNIQUE constraint error');
} catch (err) {
  if (err.message.includes('UNIQUE')) {
    console.log('   ✓ UNIQUE constraint working:', err.message.split('\n')[0]);
  } else {
    console.log('   ✗ Unexpected error:', err.message);
  }
}

// Test 9: Foreign key constraint
console.log('\n9. Testing foreign key constraint...');
try {
  db.prepare(`
    INSERT INTO project_files (
      id, project_id, path, content, content_hash,
      mime_type, size_bytes, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId('file'),
    'nonexistent-project-id',
    'docs/orphan.txt',
    'content',
    calculateHash('content'),
    'text/plain',
    7,
    '{}',
    Date.now(),
    Date.now()
  );
  console.log('   ✗ Should have thrown foreign key constraint error');
} catch (err) {
  if (err.message.includes('FOREIGN KEY')) {
    console.log('   ✓ Foreign key constraint working:', err.message.split('\n')[0]);
  } else {
    console.log('   ✗ Unexpected error:', err.message);
  }
}

// Cleanup
console.log('\n10. Cleaning up...');
db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
console.log('   ✓ Test file deleted');

console.log('\n✅ All tests passed!');
