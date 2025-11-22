const { db } = require('../db/index');

/**
 * Format file size in human-readable format
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Group files by top-level directory
 */
function groupFilesByDirectory(files) {
  const groups = {};

  for (const file of files) {
    const parts = file.path.split('/');
    const topDir = parts.length > 1 ? parts[0] : '.';

    if (!groups[topDir]) {
      groups[topDir] = [];
    }

    groups[topDir].push(file);
  }

  return groups;
}

/**
 * Build file listing section for system prompt
 */
function buildFilesSection(projectId) {
  // Get all files
  const files = db.prepare(`
    SELECT path, mime_type, size_bytes
    FROM project_files
    WHERE project_id = ?
    ORDER BY path ASC
  `).all(projectId);

  if (files.length === 0) {
    return null; // No files, skip section
  }

  // Calculate total size and tokens
  const totalSize = files.reduce((sum, f) => sum + f.size_bytes, 0);
  const totalTokens = Math.ceil(totalSize / 4); // ~4 chars per token

  // Build section header
  let section = `PROJECT FILES (${files.length} total, ~${formatSize(totalTokens * 4)} content):\n\n`;

  // Simple format for small projects
  if (files.length <= 20) {
    const groups = groupFilesByDirectory(files);

    for (const [dir, dirFiles] of Object.entries(groups).sort()) {
      const dirName = dir === '.' ? 'Root' : dir;
      section += `${dirName}:\n`;

      for (const file of dirFiles) {
        const size = formatSize(file.size_bytes);
        section += `  - ${file.path} (${size}, ${file.mime_type})\n`;
      }

      section += '\n';
    }
  }
  // Grouped format for medium projects
  else if (files.length <= 50) {
    const groups = groupFilesByDirectory(files);

    for (const [dir, dirFiles] of Object.entries(groups).sort()) {
      const dirSize = dirFiles.reduce((sum, f) => sum + f.size_bytes, 0);
      section += `${dir}/ — ${dirFiles.length} files, ${formatSize(dirSize)}\n`;

      // Show first 3 files
      dirFiles.slice(0, 3).forEach(file => {
        section += `  - ${file.path} (${formatSize(file.size_bytes)})\n`;
      });

      if (dirFiles.length > 3) {
        section += `  ... and ${dirFiles.length - 3} more\n`;
      }

      section += '\n';
    }
  }
  // Summary format for large projects
  else {
    const groups = groupFilesByDirectory(files);
    const dirSummaries = Object.entries(groups)
      .map(([dir, dirFiles]) => {
        const size = dirFiles.reduce((sum, f) => sum + f.size_bytes, 0);
        return { dir, count: dirFiles.length, size };
      })
      .sort((a, b) => b.size - a.size);

    section += 'File organization:\n';
    dirSummaries.forEach(({ dir, count, size }) => {
      section += `  - ${dir}/ — ${count} files, ${formatSize(size)}\n`;
    });
    section += '\n';

    // File type summary
    const typeGroups = {};
    files.forEach(f => {
      const type = f.mime_type || 'unknown';
      if (!typeGroups[type]) typeGroups[type] = 0;
      typeGroups[type]++;
    });

    section += 'File types:\n';
    Object.entries(typeGroups)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        section += `  - ${type}: ${count} files\n`;
      });
    section += '\n';
  }

  // Add usage instructions
  section += 'Use the search endpoint to find specific content, or request files during conversation.\n';

  return section;
}

module.exports = { buildFilesSection, formatSize };
