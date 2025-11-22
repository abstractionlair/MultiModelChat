const { escapeFTS5Query } = require('./search');

console.log('Testing FTS5 query escaping...\n');

const testCases = [
  // Normal queries
  ['simple query', '"simple query"'],
  ['hello world', '"hello world"'],

  // Queries with quotes
  ['"quoted text"', '"""quoted text"""'],
  ['text with "quotes" inside', '"text with ""quotes"" inside"'],

  // Potential injection attempts
  ['OR 1=1', '"OR 1=1"'],
  ['"; DROP TABLE users; --', '"""; DROP TABLE users; --"'],
  ['* OR *', '"* OR *"'],

  // Edge cases
  ['', '""'],
  [null, '""'],
  [undefined, '""'],
  ['   whitespace   ', '"whitespace"'],
];

console.log('Query Escaping Tests:');
let passedCount = 0;
let failedCount = 0;

testCases.forEach(([input, expected]) => {
  const result = escapeFTS5Query(input);
  const status = result === expected ? '✓' : '✗';
  if (result === expected) {
    passedCount++;
  } else {
    failedCount++;
  }
  console.log(`${status} Input: ${JSON.stringify(input)}`);
  console.log(`  Expected: ${expected}`);
  console.log(`  Got:      ${result}\n`);
});

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passedCount}/${testCases.length}`);
console.log(`Failed: ${failedCount}/${testCases.length}`);

if (failedCount === 0) {
  console.log('\n✓ All tests passed! FTS5 injection prevention is working.');
  process.exit(0);
} else {
  console.log('\n✗ Some tests failed!');
  process.exit(1);
}
