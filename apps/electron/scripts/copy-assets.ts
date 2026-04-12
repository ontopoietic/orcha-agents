/**
 * Cross-platform asset copy script.
 *
 * Copies the resources/ directory to dist/resources/.
 * All bundled assets (docs, themes, permissions, tool-icons) now live in resources/
 * which electron-builder handles natively via directories.buildResources.
 *
 * At Electron startup, setBundledAssetsRoot(__dirname) is called, and then
 * getBundledAssetsDir('docs') resolves to <__dirname>/resources/docs/, etc.
 *
 * Run: bun scripts/copy-assets.ts
 */

import { cpSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

const ROOT_DIR = join(import.meta.dir, '..', '..', '..');

// Copy all resources (icons, themes, docs, permissions, tool-icons, etc.)
cpSync('resources', 'dist/resources', { recursive: true });

console.log('✓ Copied resources/ → dist/resources/');

// Copy session-mcp-server from packages/ build output
const sessionServerSrc = join(ROOT_DIR, 'packages', 'session-mcp-server', 'dist', 'index.js');
const sessionServerDest = join('dist', 'resources', 'session-mcp-server', 'index.js');
if (existsSync(sessionServerSrc)) {
  mkdirSync(dirname(sessionServerDest), { recursive: true });
  copyFileSync(sessionServerSrc, sessionServerDest);
  console.log('✓ Copied session-mcp-server → dist/resources/session-mcp-server/');
} else {
  console.warn('⚠ session-mcp-server not found at', sessionServerSrc);
}

// Copy pi-agent-server from packages/ build output
const piServerSrc = join(ROOT_DIR, 'packages', 'pi-agent-server', 'dist', 'index.js');
const piServerDest = join('dist', 'resources', 'pi-agent-server', 'index.js');
if (existsSync(piServerSrc)) {
  mkdirSync(dirname(piServerDest), { recursive: true });
  copyFileSync(piServerSrc, piServerDest);
  console.log('✓ Copied pi-agent-server → dist/resources/pi-agent-server/');
} else {
  console.warn('⚠ pi-agent-server not found at', piServerSrc);
}

// Copy PowerShell parser script (for Windows command validation in Explore mode)
// Source: packages/shared/src/agent/powershell-parser.ps1
// Destination: dist/resources/powershell-parser.ps1
const psParserSrc = join('..', '..', 'packages', 'shared', 'src', 'agent', 'powershell-parser.ps1');
const psParserDest = join('dist', 'resources', 'powershell-parser.ps1');
try {
  copyFileSync(psParserSrc, psParserDest);
  console.log('✓ Copied powershell-parser.ps1 → dist/resources/');
} catch (err) {
  // Only warn - PowerShell validation is optional on non-Windows platforms
  console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)');
}
