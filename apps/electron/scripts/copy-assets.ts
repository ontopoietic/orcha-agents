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

import { cpSync, copyFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

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

// Download Bun binary for Pi Agent Server subprocess (if not already present)
// The Pi Agent Server is built with --target bun and needs Bun to run.
const BUN_VERSION = 'bun-v1.3.9';
const vendorBunDir = join('vendor', 'bun');
const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun';
const vendorBunPath = join(vendorBunDir, bunBinary);

if (!existsSync(vendorBunPath)) {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const downloadName = `bun-${platform}-${arch}`;
  const zipUrl = `https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${downloadName}.zip`;

  console.log(`⬇ Downloading Bun ${BUN_VERSION} for ${platform}-${arch}...`);
  mkdirSync(vendorBunDir, { recursive: true });

  try {
    const tmpZip = join(vendorBunDir, 'bun.zip');
    execSync(`curl -fsSL --retry 3 -o "${tmpZip}" "${zipUrl}"`);
    execSync(`unzip -o -j "${tmpZip}" "${downloadName}/${bunBinary}" -d "${vendorBunDir}"`);
    execSync(`chmod +x "${vendorBunPath}"`);
    // Clean up zip
    try { unlinkSync(tmpZip); } catch {}
    console.log('✓ Downloaded Bun → vendor/bun/');
  } catch (err) {
    console.warn('⚠ Failed to download Bun. Pi Agent Server may not work:', (err as Error).message);
  }
} else {
  console.log('✓ Bun binary already present in vendor/bun/');
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
