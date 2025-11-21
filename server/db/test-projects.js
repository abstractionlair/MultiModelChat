const { db, newId, getDefaultProjectId } = require('./index');
const { runMigrations } = require('./migrate');

// Run migrations
runMigrations();

// Test default project
const defaultId = getDefaultProjectId();
console.log('Default project ID:', defaultId);

const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(defaultId);
console.log('Default project:', project);

// Test creating a new project
const newProjectId = newId('proj');
const now = Date.now();

db.prepare(`
  INSERT INTO projects (id, name, description, settings, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(
  newProjectId,
  'Test Project',
  'A test project',
  JSON.stringify({ default_models: ['gpt-4', 'claude-opus-4'] }),
  now,
  now
);

const newProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(newProjectId);
console.log('New project:', newProject);
console.log('Settings:', JSON.parse(newProject.settings));

// Test querying all projects
const allProjects = db.prepare('SELECT id, name FROM projects').all();
console.log('All projects:', allProjects);

console.log('\n✓ Projects schema test passed!');
