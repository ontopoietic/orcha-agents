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

import { cpSync, copyFileSync, mkdirSync, existsSync, unlinkSync, realpathSync, writeFileSync, readdirSync, rmSync } from 'fs';
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

// ---------------------------------------------------------------------------
// Stage the local embedder runtime for semantic recall (macOS only).
//
// The agent loads `@huggingface/transformers` at runtime via a non-literal
// dynamic import (so esbuild never inlines the native ONNX binaries). For the
// packaged app that package — plus its native dep onnxruntime-node — must be
// resolvable as `node_modules` from dist/main.cjs, which electron-builder
// places at <Resources>/app/. We therefore stage a minimal, self-contained
// node_modules under vendor/embedder/ and ship it to app/node_modules via
// mac.extraResources (see electron-builder.yml).
//
// Minimal set (text feature-extraction only): transformers, @huggingface/jinja
// (tokenizer templates), onnxruntime-node (inference), onnxruntime-common.
// sharp (images) is replaced by a stub — transformers statically imports it but
// only invokes it for image models, which Orcha never uses. onnxruntime-web
// (browser WASM) and source maps are pruned. ONNX native binaries are trimmed
// to darwin only. Result ≈ 70 MB vs. 490 MB unpruned.
//
// On non-macOS the stage is skipped; recall degrades to word-overlap scoring.
function stageEmbedderRuntime(): void {
  if (process.platform !== 'darwin') {
    console.log('⚠ embedder runtime staging skipped (non-macOS; recall falls back to text scoring)');
    return;
  }
  const stageRoot = join('vendor', 'embedder', 'node_modules');
  rmSync(stageRoot, { recursive: true, force: true });

  const realPkgPath = (name: string): string => {
    // Resolve the real (dereferenced) package dir from the hoisted root store.
    const link = join(ROOT_DIR, 'node_modules', name);
    return realpathSync(link);
  };

  const copyPkg = (name: string): void => {
    const dest = join(stageRoot, name);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(realPkgPath(name), dest, { recursive: true, dereference: true });
  };

  try {
    copyPkg('@huggingface/transformers');
    copyPkg('@huggingface/jinja');
    copyPkg('onnxruntime-node');
    copyPkg('onnxruntime-common');

    // Drop any `.cache/` the dev tree accumulated (transformers downloads models
    // into node_modules/.../.cache by default). Models ship via the user cache
    // (~/.orcha-agents/models), never inside the bundle.
    rmSync(join(stageRoot, '@huggingface', 'transformers', '.cache'), {
      recursive: true,
      force: true,
    });

    // Prune transformers/dist: drop browser WASM + source maps (Node uses the
    // onnxruntime-node binding and never the .wasm). Keep all JS entries so the
    // package "exports" map still resolves.
    const tDist = join(stageRoot, '@huggingface', 'transformers', 'dist');
    for (const f of readdirSync(tDist)) {
      if (f.endsWith('.wasm') || f.endsWith('.map')) {
        rmSync(join(tDist, f), { force: true });
      }
    }

    // Trim onnxruntime-node native binaries to darwin (both arches, so each mac
    // DMG works); drop win32/linux.
    const onnxPlatRoot = join(stageRoot, 'onnxruntime-node', 'bin', 'napi-v3');
    if (existsSync(onnxPlatRoot)) {
      for (const plat of readdirSync(onnxPlatRoot)) {
        if (plat !== 'darwin') rmSync(join(onnxPlatRoot, plat), { recursive: true, force: true });
      }
    }

    // sharp stub: transformers reads `sharp.default` at load (to pick the image
    // loader) but only *calls* it for image models. A truthy stub satisfies the
    // static import without shipping native libvips; it throws if ever invoked.
    const sharpDir = join(stageRoot, 'sharp');
    mkdirSync(sharpDir, { recursive: true });
    writeFileSync(
      join(sharpDir, 'package.json'),
      JSON.stringify({ name: 'sharp', version: '0.0.0-orcha-stub', main: 'index.js' }, null, 2),
    );
    writeFileSync(
      join(sharpDir, 'index.js'),
      [
        '// Stub: Orcha bundles @huggingface/transformers for TEXT embeddings only.',
        '// Image processing (the sole consumer of sharp) is never invoked, so this',
        '// satisfies the static import without shipping native libvips.',
        'module.exports = function sharpStub() {',
        "  throw new Error('sharp is stubbed in Orcha: bundled embedder is text-only');",
        '};',
        'module.exports.default = module.exports;',
        '',
      ].join('\n'),
    );

    const total = execSync(`du -sh "${stageRoot}" | cut -f1`).toString().trim();
    console.log(`✓ Staged embedder runtime → ${stageRoot}/ (${total})`);
  } catch (err) {
    console.warn('⚠ Failed to stage embedder runtime:', (err as Error).message);
  }
}

stageEmbedderRuntime();

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
