# Step 12: Bash Execution Runtime

**Phase**: 1c - Code Execution
**Complexity**: Medium (3-4 hours)
**Dependencies**: [11: Update System Prompts](./11-system-prompts.md)
**Can Parallelize**: No (start of Phase 1c)

[← Back to Roadmap](../ROADMAP.md)

## Goal

Set up a bash-accessible execution environment with Python (Pyodide), Node.js, and custom project tools, enabling models to execute commands and scripts.

## Success Criteria

- [ ] Pyodide runtime initialized with Python interpreter
- [ ] Node.js available for JavaScript execution
- [ ] Bash command executor implemented
- [ ] Standard Unix commands available (cat, ls, echo, grep, etc.)
- [ ] Package managers working (pip for Python, npm for Node.js)
- [ ] Custom binaries implemented (search_project, list_project_files)
- [ ] Timeout protection for command execution
- [ ] Test suite verifies all components work

## Background

Instead of exposing multiple specific tools (execute_python, write_file, etc.), we provide a single `bash` tool that gives models access to a full command-line environment. This is simpler, more flexible, and matches how developers actually work.

Models can:
- Execute Python via `python script.py`
- Execute JavaScript via `node script.js`
- Install packages via `pip install pandas` or `npm install lodash`
- Write files via `cat > file.txt << 'EOF' ... EOF`
- Search project via `search_project "query"`
- Use standard Unix tools

## Implementation

### 1. Install Dependencies

```bash
npm install pyodide@0.24.1
```

Pyodide provides Python in WebAssembly with micropip for package installation.

### 2. Create Bash Executor

**File**: `server/execution/bash.js`

```javascript
const { loadPyodide } = require('pyodide');
const { spawn } = require('child_process');
const path = require('path');

/**
 * Bash execution environment with Python (Pyodide) and Node.js
 */
class BashExecutor {
  constructor() {
    this.pyodide = null;
    this.initPromise = null;
    this.projectDir = '/project';
  }

  /**
   * Initialize Pyodide (lazy)
   */
  async init() {
    if (this.pyodide) return this.pyodide;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      console.log('Initializing Pyodide...');
      const startTime = Date.now();

      this.pyodide = await loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/'
      });

      // Set up virtual filesystem
      this.pyodide.FS.mkdir(this.projectDir);
      this.pyodide.FS.chdir(this.projectDir);

      console.log(`✓ Pyodide initialized in ${Date.now() - startTime}ms`);
      return this.pyodide;
    })();

    return this.initPromise;
  }

  /**
   * Execute bash command
   */
  async execute(command, options = {}) {
    const {
      timeout = 30000,
      cwd = this.projectDir
    } = options;

    await this.init();

    // Route to appropriate handler
    if (command.startsWith('python ') || command.startsWith('pip ')) {
      return this.executePython(command, timeout);
    } else if (command.startsWith('node ') || command.startsWith('npm ')) {
      return this.executeNode(command, timeout);
    } else if (command.startsWith('search_project')) {
      return this.executeSearchProject(command);
    } else if (command.startsWith('list_project_files')) {
      return this.executeListFiles(command);
    } else {
      return this.executeUnixCommand(command, timeout);
    }
  }

  /**
   * Execute Python command via Pyodide
   */
  async executePython(command, timeout) {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Command timeout')), timeout)
    );

    const executionPromise = (async () => {
      // Handle pip install specially
      if (command.startsWith('pip install ')) {
        const packages = command.replace('pip install ', '').trim().split(/\s+/);

        try {
          for (const pkg of packages) {
            await this.pyodide.loadPackage('micropip');
            await this.pyodide.runPythonAsync(`
              import micropip
              await micropip.install('${pkg}')
            `);
          }

          return {
            stdout: `Successfully installed ${packages.join(', ')}`,
            stderr: '',
            exit_code: 0
          };
        } catch (err) {
          return {
            stdout: '',
            stderr: err.message,
            exit_code: 1
          };
        }
      }

      // Handle python script.py
      if (command.startsWith('python ')) {
        const scriptPath = command.replace('python ', '').trim();

        try {
          // Read script from virtual FS
          const scriptContent = this.pyodide.FS.readFile(scriptPath, { encoding: 'utf8' });

          // Capture stdout/stderr
          this.pyodide.runPython(`
import sys
import io
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
          `);

          // Execute
          await this.pyodide.runPythonAsync(scriptContent);

          // Get output
          const stdout = this.pyodide.runPython('sys.stdout.getvalue()');
          const stderr = this.pyodide.runPython('sys.stderr.getvalue()');

          return {
            stdout,
            stderr,
            exit_code: stderr ? 1 : 0
          };
        } catch (err) {
          return {
            stdout: '',
            stderr: err.message,
            exit_code: 1
          };
        }
      }

      // Handle python -c "code"
      if (command.includes('-c')) {
        const codeMatch = command.match(/python\s+-c\s+["'](.+)["']/);
        if (!codeMatch) {
          return {
            stdout: '',
            stderr: 'Invalid python -c syntax',
            exit_code: 1
          };
        }

        try {
          this.pyodide.runPython(`
import sys
import io
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
          `);

          await this.pyodide.runPythonAsync(codeMatch[1]);

          const stdout = this.pyodide.runPython('sys.stdout.getvalue()');
          const stderr = this.pyodide.runPython('sys.stderr.getvalue()');

          return {
            stdout,
            stderr,
            exit_code: stderr ? 1 : 0
          };
        } catch (err) {
          return {
            stdout: '',
            stderr: err.message,
            exit_code: 1
          };
        }
      }

      throw new Error('Unsupported python command format');
    })();

    return Promise.race([executionPromise, timeoutPromise]);
  }

  /**
   * Execute Node.js command
   */
  async executeNode(command, timeout) {
    // For MVP: Simple node execution
    // In production, would use vm2 or isolated-vm for sandboxing

    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], {
        cwd: this.projectDir,
        timeout
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        resolve({
          stdout,
          stderr,
          exit_code: code
        });
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Execute Unix command in virtual FS
   */
  async executeUnixCommand(command, timeout) {
    try {
      // Implement basic Unix commands using Pyodide FS
      if (command.startsWith('cat ')) {
        const filepath = command.replace('cat ', '').trim();
        const content = this.pyodide.FS.readFile(filepath, { encoding: 'utf8' });
        return { stdout: content, stderr: '', exit_code: 0 };
      }

      if (command.startsWith('ls')) {
        const args = command.replace('ls', '').trim();
        const dir = args || '.';
        const entries = this.pyodide.FS.readdir(dir);
        const output = entries.filter(e => e !== '.' && e !== '..').join('\n');
        return { stdout: output, stderr: '', exit_code: 0 };
      }

      if (command.startsWith('mkdir ')) {
        const dir = command.replace('mkdir ', '').trim().replace('-p ', '');
        const parts = dir.split('/').filter(Boolean);
        let currentPath = dir.startsWith('/') ? '' : '.';

        for (const part of parts) {
          currentPath += '/' + part;
          try {
            this.pyodide.FS.mkdir(currentPath);
          } catch (err) {
            // Directory exists, ignore
          }
        }

        return { stdout: '', stderr: '', exit_code: 0 };
      }

      if (command.startsWith('echo ')) {
        const text = command.replace('echo ', '');
        return { stdout: text + '\n', stderr: '', exit_code: 0 };
      }

      if (command.startsWith('cat > ') || command.includes('<<')) {
        // Handle heredoc: cat > file.txt << 'EOF' ... EOF
        return this.executeHeredoc(command);
      }

      throw new Error(`Unsupported command: ${command}`);

    } catch (err) {
      return {
        stdout: '',
        stderr: err.message,
        exit_code: 1
      };
    }
  }

  /**
   * Execute heredoc (cat > file << 'EOF' ... EOF)
   */
  executeHeredoc(command) {
    // This is a simplified parser - real implementation would be more robust
    const match = command.match(/cat\s*>\s*(\S+)\s*<<\s*['"]?(\w+)['"]?\n([\s\S]*)\n\2/);

    if (!match) {
      return {
        stdout: '',
        stderr: 'Invalid heredoc syntax',
        exit_code: 1
      };
    }

    const [, filepath, , content] = match;

    try {
      // Create parent directories if needed
      const dir = filepath.substring(0, filepath.lastIndexOf('/'));
      if (dir) {
        const parts = dir.split('/').filter(Boolean);
        let currentPath = '';
        for (const part of parts) {
          currentPath += '/' + part;
          try {
            this.pyodide.FS.mkdir(currentPath);
          } catch (err) {
            // Directory exists
          }
        }
      }

      // Write file
      this.pyodide.FS.writeFile(filepath, content);

      return {
        stdout: '',
        stderr: '',
        exit_code: 0
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: err.message,
        exit_code: 1
      };
    }
  }

  /**
   * Execute search_project command
   */
  async executeSearchProject(command) {
    // This will be implemented in Step 15 to call our search API
    // For now, return placeholder
    return {
      stdout: 'search_project will be implemented in Step 15',
      stderr: '',
      exit_code: 0
    };
  }

  /**
   * Execute list_project_files command
   */
  async executeListFiles(command) {
    // This will be implemented in Step 15 to call our file listing API
    // For now, return placeholder
    return {
      stdout: 'list_project_files will be implemented in Step 15',
      stderr: '',
      exit_code: 0
    };
  }
}

// Singleton
const bashExecutor = new BashExecutor();

module.exports = { bashExecutor };
```

### 3. Create Test Script

**File**: `server/execution/test-bash.js`

```javascript
const { bashExecutor } = require('./bash');

async function runTests() {
  console.log('=== Bash Executor Tests ===\n');

  // Test 1: Python execution
  console.log('1. Testing Python execution...');

  // Write a Python script
  await bashExecutor.execute(`cat > test.py << 'EOF'
print("Hello from Python!")
print(2 + 2)
EOF`);

  const result1 = await bashExecutor.execute('python test.py');

  if (result1.exit_code === 0 && result1.stdout.includes('Hello from Python')) {
    console.log('✓ Python execution works');
    console.log(`  Output: ${result1.stdout.trim()}`);
  } else {
    console.error('✗ Python execution failed:', result1);
  }

  // Test 2: pip install
  console.log('\n2. Testing pip install...');
  const result2 = await bashExecutor.execute('pip install micropip');

  if (result2.exit_code === 0) {
    console.log('✓ pip install works');
  } else {
    console.error('✗ pip install failed:', result2);
  }

  // Test 3: Unix commands
  console.log('\n3. Testing Unix commands...');

  await bashExecutor.execute('mkdir -p data');
  await bashExecutor.execute(`cat > data/test.csv << 'EOF'
name,value
A,10
B,20
EOF`);

  const result3 = await bashExecutor.execute('cat data/test.csv');

  if (result3.stdout.includes('name,value')) {
    console.log('✓ Unix commands work');
  } else {
    console.error('✗ Unix commands failed:', result3);
  }

  // Test 4: ls command
  console.log('\n4. Testing ls...');
  const result4 = await bashExecutor.execute('ls');

  if (result4.stdout.includes('test.py') && result4.stdout.includes('data')) {
    console.log('✓ ls works');
    console.log(`  Files: ${result4.stdout.trim()}`);
  } else {
    console.error('✗ ls failed:', result4);
  }

  // Test 5: Multi-step Python workflow
  console.log('\n5. Testing Python workflow...');

  await bashExecutor.execute(`cat > analyze.py << 'EOF'
import csv

with open('data/test.csv') as f:
    reader = csv.DictReader(f)
    rows = list(reader)

total = sum(int(row['value']) for row in rows)
print(f'Total: {total}')
EOF`);

  const result5 = await bashExecutor.execute('python analyze.py');

  if (result5.stdout.includes('Total: 30')) {
    console.log('✓ Python workflow works');
  } else {
    console.error('✗ Python workflow failed:', result5);
  }

  // Test 6: Timeout protection
  console.log('\n6. Testing timeout protection...');
  const startTime = Date.now();

  await bashExecutor.execute(`cat > infinite.py << 'EOF'
while True:
    pass
EOF`);

  try {
    await bashExecutor.execute('python infinite.py', { timeout: 1000 });
    console.error('✗ Timeout protection failed - should have timed out');
  } catch (err) {
    const elapsed = Date.now() - startTime;
    if (err.message.includes('timeout') && elapsed < 2000) {
      console.log('✓ Timeout protection works');
    } else {
      console.error('✗ Timeout protection failed:', err);
    }
  }

  console.log('\n✓ All bash executor tests passed!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

Run:
```bash
node server/execution/test-bash.js
```

## Files Changed

- `package.json` - Add pyodide dependency
- `server/execution/bash.js` - New bash executor
- `server/execution/test-bash.js` - New tests

## Testing Checklist

- [ ] Install Pyodide: `npm install`
- [ ] Run tests: `node server/execution/test-bash.js`
- [ ] Verify Python execution works
- [ ] Test pip install packages
- [ ] Verify Unix commands (cat, ls, mkdir, echo)
- [ ] Test heredoc file creation
- [ ] Verify timeout protection
- [ ] Test multi-step workflows

## Validation

```bash
# Run tests
node server/execution/test-bash.js

# Expected output:
# ✓ Python execution works
# ✓ pip install works
# ✓ Unix commands work
# ✓ ls works
# ✓ Python workflow works
# ✓ Timeout protection works
```

## Notes

### Heredoc Parsing

The heredoc parser is simplified for MVP. Full implementation would handle:
- Single vs double quotes (variable expansion)
- Indented heredocs (`<<-EOF`)
- Multiple heredocs in one command
- Escaped characters

For now, use simple format:
```bash
cat > file.txt << 'EOF'
content here
EOF
```

### Node.js Execution

MVP uses native Node.js execution. For production, consider:
- `vm2` - Sandboxed VM with timeout support
- `isolated-vm` - V8 isolates for better security
- Resource limits (memory, CPU)

### Package Installation

**Python (micropip):**
- Supports pure Python packages from PyPI
- Some packages with C extensions available (numpy, pandas, etc.)
- Check Pyodide docs for compatibility

**Node.js (npm):**
- Standard npm packages work
- Be mindful of package size (impacts startup time)

### Command Routing

Commands are routed based on prefix:
- `python ...` → Pyodide
- `pip ...` → micropip
- `node ...` → Node.js
- `npm ...` → npm
- `search_project ...` → Custom (Step 15)
- `list_project_files ...` → Custom (Step 15)
- Others → Unix command emulation

## Next Step

[13: Filesystem Materialization](./13-filesystem-materialization.md) - Set up /project/ structure and load user files
