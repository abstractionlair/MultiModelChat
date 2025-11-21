# Step 03: Projects Schema

**Phase**: 1a - Foundations
**Complexity**: Low (1-2 hours)
**Dependencies**: [01: SQLite Setup](./01-sqlite-setup.md)
**Can Parallelize**: Yes - can do alongside [02: Conversations Schema](./02-conversations-schema.md)

[← Back to Roadmap](../ROADMAP.md)

## Goal

Create the `projects` table to organize conversations and files. Start with a "default" project that all existing conversations belong to.

## Success Criteria

- [ ] `projects` table created
- [ ] Default project auto-created on startup
- [ ] Foreign key from conversations to projects works
- [ ] Migration tested

## Schema Design

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  settings TEXT,           -- JSON: {
                           --   default_models: [...],
                           --   context_strategy: 'smart'|'balanced'|'minimal',
                           --   max_context_tokens: number,
                           --   retrieval_config: {...}
                           -- }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Simple for now**: Settings can be expanded later. Start with minimal structure.

## Implementation

### 1. Add to Schema File

**File**: `server/db/schema.sql`

Add the projects table definition above.

### 2. Create Migration

**File**: `server/db/migrations/002-projects.js`

```javascript
const { db, newId } = require('../index');

function up() {
  console.log('Running migration: 002-projects');

  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      settings TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Create default project
  const defaultProjectId = newId('proj');
  const now = Date.now();

  db.prepare(`
    INSERT INTO projects (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    defaultProjectId,
    'Default Project',
    'Auto-created default project',
    now,
    now
  );

  console.log('✓ Projects table created');
  console.log('✓ Default project created:', defaultProjectId);

  // Store default project ID in config for easy access
  db.prepare(`
    INSERT OR REPLACE INTO config (key, value, updated_at)
    VALUES (?, ?, ?)
  `).run('default_project_id', defaultProjectId, now);
}

function down() {
  console.log('Rolling back migration: 002-projects');
  db.exec('DROP TABLE IF EXISTS projects;');
  db.prepare('DELETE FROM config WHERE key = ?').run('default_project_id');
  console.log('✓ Projects table dropped');
}

module.exports = { up, down };
```

### 3. Helper Function for Default Project

**File**: `server/db/index.js`

Add helper function:

```javascript
// ... existing code ...

/**
 * Get the default project ID from config
 */
function getDefaultProjectId() {
  const result = db.prepare('SELECT value FROM config WHERE key = ?')
    .get('default_project_id');

  if (!result) {
    throw new Error('Default project not found - run migrations');
  }

  return result.value;
}

module.exports = { db, newId, getDefaultProjectId };
```

### 4. Test

**File**: `server/db/test-projects.js`

```javascript
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
```

Run:
```bash
node server/db/test-projects.js
```

## Files Changed

- `server/db/schema.sql` - Add projects table
- `server/db/migrations/002-projects.js` - New migration
- `server/db/index.js` - Add getDefaultProjectId helper
- `server/db/test-projects.js` - New test

## Testing Checklist

- [ ] Run migrations: `node server/db/migrate.js`
- [ ] Verify default project created: `sqlite3 data.db "SELECT * FROM projects;"`
- [ ] Run test: `node server/db/test-projects.js`
- [ ] Check config table: `sqlite3 data.db "SELECT * FROM config WHERE key='default_project_id';"`

## Notes

### Why a Default Project?

During Phase 1a, we need somewhere to put existing conversations. The default project serves as a catch-all until we add UI for project management.

### Settings Structure

The settings JSON is flexible for future needs:
- `default_models`: Which models to use by default in this project
- `context_strategy`: How aggressively to manage context
- `retrieval_config`: Custom retrieval parameters

For now, these are optional - we use global defaults from env vars.

## Next Step

[04: Migrate Conversations](./04-migrate-conversations.md) - Update conversations to reference projects
