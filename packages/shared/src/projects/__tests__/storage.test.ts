/**
 * Tests for Project Storage — MEMORY.md loading.
 *
 * Uses real temp directories to exercise actual filesystem operations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { estimateTokensDensityAware } from '../../utils/large-response.ts';
import {
  appendProjectMemoryEntry,
  createProject,
  getProjectMemoryPath,
  loadProjectMemory,
  sanitizeAssetFilename,
} from '../storage.ts';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'projects-test-'));
  workspaceRoot = join(tempDir, 'workspace');
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeProjectSlug(name = 'Memory Test'): string {
  return createProject(workspaceRoot, { name }).slug;
}

describe('sanitizeAssetFilename', () => {
  it('strips control chars and NUL bytes (the literal-NUL regex fix)', () => {
    // A NUL, newline, and tab are all removed — the source regex no longer carries a literal NUL.
    expect(sanitizeAssetFilename('re\x00port\n\t.pdf')).toBe('report.pdf');
  });

  it('strips path separators and leading dots so an upload stays in the assets dir', () => {
    expect(sanitizeAssetFilename('..\\..\\etc\\passwd')).toBe('etcpasswd');
  });

  it('falls back to a generated name when the input reduces to empty', () => {
    expect(sanitizeAssetFilename('\x00\n\t')).toMatch(/^asset_[0-9a-f]{8}$/);
  });
});

describe('loadProjectMemory', () => {
  it('returns null when MEMORY.md does not exist', () => {
    const slug = makeProjectSlug();
    expect(loadProjectMemory(workspaceRoot, slug)).toBeNull();
  });

  it('returns null when MEMORY.md is whitespace-only', () => {
    const slug = makeProjectSlug();
    writeFileSync(getProjectMemoryPath(workspaceRoot, slug), '   \n\t\n');
    expect(loadProjectMemory(workspaceRoot, slug)).toBeNull();
  });

  it('returns content verbatim when under the token cap', () => {
    const slug = makeProjectSlug();
    const content = '# Lessons\n\n- Always read the guide first.\n- Cache is king.';
    writeFileSync(getProjectMemoryPath(workspaceRoot, slug), content);
    expect(loadProjectMemory(workspaceRoot, slug)).toBe(content);
  });

  it('keeps the start and the end with a marker when over the cap, staying within budget', () => {
    const slug = makeProjectSlug();
    const maxTokens = 50;
    // ~2000 chars of plain text => ~500 tokens, well over the 50-token cap.
    const body = 'TOP-OF-MEMORY ' + 'lorem ipsum dolor sit amet '.repeat(74) + ' BOTTOM-OF-MEMORY';
    writeFileSync(getProjectMemoryPath(workspaceRoot, slug), body);

    const result = loadProjectMemory(workspaceRoot, slug, maxTokens);
    expect(result).not.toBeNull();
    const text = result as string;

    // Older files keep their newest notes at the top; appended notes land at the end.
    expect(text).toContain('TOP-OF-MEMORY');
    expect(text).toContain('BOTTOM-OF-MEMORY');

    // Marker present and budget respected (marker included).
    expect(text).toContain(`over the ${maxTokens}-token cap`);
    expect(estimateTokensDensityAware(text)).toBeLessThanOrEqual(maxTokens);
  });
});

describe('appendProjectMemoryEntry', () => {
  it('creates MEMORY.md and appends notes under dated headings without touching earlier content', () => {
    const slug = makeProjectSlug();
    const first = appendProjectMemoryEntry(workspaceRoot, slug, '2026-10-11T22:00:00Z — Explore', 'Login needs the staging account.');
    expect(first.path).toBe(getProjectMemoryPath(workspaceRoot, slug));
    appendProjectMemoryEntry(workspaceRoot, slug, '2026-10-11T23:00:00Z —\n Persona  tests', '- The consent page needs a JS click.');

    expect(readFileSync(first.path, 'utf-8')).toBe(
      '## 2026-10-11T22:00:00Z — Explore\n\nLogin needs the staging account.\n\n' +
      '## 2026-10-11T23:00:00Z — Persona tests\n\n- The consent page needs a JS click.\n',
    );
  });

  // Found 2026-10-11: a session rewrote MEMORY.md from its start-of-session snapshot and dropped
  // notes other sessions had added since.
  it('never rewrites the file, so notes added by others in between survive', () => {
    const slug = makeProjectSlug();
    const path = getProjectMemoryPath(workspaceRoot, slug);
    writeFileSync(path, '# Lessons\n');
    appendProjectMemoryEntry(workspaceRoot, slug, 'A', 'first note');
    appendFileSync(path, '\n## B\n\nadded by another session\n');
    appendProjectMemoryEntry(workspaceRoot, slug, 'A', 'second note');

    const content = readFileSync(path, 'utf-8');
    expect(content.startsWith('# Lessons\n')).toBe(true);
    const order = ['first note', 'added by another session', 'second note'].map(text => content.indexOf(text));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
