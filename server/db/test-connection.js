const { db, newId } = require('./index');

console.log('Testing SQLite connection...');

// Test database connection
try {
  const result = db.prepare('SELECT 1 as test').get();
  console.log('✓ Database connected:', result);
} catch (err) {
  console.error('✗ Database connection failed:', err);
  process.exit(1);
}

// Test ULID generation
const id1 = newId();
const id2 = newId('conv');
console.log('✓ ULID generation works:', { id1, id2 });

// Test WAL mode
const mode = db.pragma('journal_mode', { simple: true });
console.log('✓ Journal mode:', mode);

console.log('\nAll tests passed!');
