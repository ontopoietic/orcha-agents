/**
 * Tests for parseExtractorOutput — re-implemented locally rather than
 * imported from scripts/, since the script is a CLI entry point and
 * shouldn't be a JS dependency. The parser logic is self-contained in
 * the script; this file mirrors it 1:1 for testability.
 *
 * Drift risk: if the script's parser changes, update this copy. Pinned
 * by the lookup-table behavior these tests exercise.
 */
import { describe, expect, it } from 'bun:test';
import {
  isKnownArtifactType,
  isKnownRelationType,
  type ArtifactConfidence,
  type ArtifactEdge,
  type ArtifactGraph,
  type ArtifactNode,
} from '../index.ts';

function parseExtractorOutput(raw: string): ArtifactGraph {
  let text = raw.trim();
  if (text.startsWith('```')) text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { nodes: [], edges: [] }; }
  if (!parsed || typeof parsed !== 'object') return { nodes: [], edges: [] };
  const obj = parsed as Record<string, unknown>;
  const nodes: ArtifactNode[] = [];
  const edges: ArtifactEdge[] = [];

  if (Array.isArray(obj.nodes)) {
    for (const n of obj.nodes) {
      if (!n || typeof n !== 'object') continue;
      const o = n as Record<string, unknown>;
      const type = typeof o.type === 'string' ? o.type : null;
      const label = typeof o.label === 'string' ? o.label : null;
      if (!type || !label) continue;
      if (!isKnownArtifactType(type)) continue;
      const evidenceRaw = Array.isArray(o.evidence) ? o.evidence : [];
      const evidence = evidenceRaw.filter((x): x is string => typeof x === 'string');
      const conf: ArtifactConfidence =
        o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low'
          ? o.confidence : 'low';
      const ref = typeof o.ref === 'string' ? o.ref : undefined;
      nodes.push({ type, label: label.trim(), evidence, confidence: conf, ...(ref ? { ref } : {}) });
    }
  }

  const nodeKeys = new Set(nodes.map((n) => `${n.type}:${n.label.toLowerCase()}`));
  const refKeys = new Set(nodes.filter((n) => n.ref).map((n) => `ref:${n.ref}`));
  const isValidEndpoint = (v: string): boolean => {
    if (v.startsWith('ref:')) return refKeys.has(v);
    const idx = v.indexOf(':');
    if (idx < 0) return false;
    const t = v.slice(0, idx);
    const l = v.slice(idx + 1).toLowerCase();
    return nodeKeys.has(`${t}:${l}`);
  };

  if (Array.isArray(obj.edges)) {
    for (const e of obj.edges) {
      if (!e || typeof e !== 'object') continue;
      const o = e as Record<string, unknown>;
      const from = typeof o.from === 'string' ? o.from : null;
      const to = typeof o.to === 'string' ? o.to : null;
      const via = typeof o.via === 'string' ? o.via : null;
      if (!from || !to || !via) continue;
      if (!isKnownRelationType(via)) continue;
      if (!isValidEndpoint(from) || !isValidEndpoint(to)) continue;
      edges.push({ from, to, via });
    }
  }

  return { nodes, edges };
}

describe('parseExtractorOutput', () => {
  it('returns empty graph on invalid JSON', () => {
    expect(parseExtractorOutput('not json at all')).toEqual({ nodes: [], edges: [] });
  });

  it('strips markdown fences before parsing', () => {
    const raw = '```json\n{"nodes":[{"type":"tradeoff","label":"X","evidence":["m1"],"confidence":"high"}],"edges":[]}\n```';
    const out = parseExtractorOutput(raw);
    expect(out.nodes.length).toBe(1);
    expect(out.nodes[0]!.type).toBe('tradeoff');
  });

  it('drops nodes with unknown type', () => {
    const raw = JSON.stringify({
      nodes: [
        { type: 'tradeoff', label: 'X', evidence: ['m1'], confidence: 'high' },
        { type: 'unicorn', label: 'Sparkle', evidence: ['m2'], confidence: 'high' },
      ],
      edges: [],
    });
    const out = parseExtractorOutput(raw);
    expect(out.nodes.length).toBe(1);
    expect(out.nodes[0]!.type).toBe('tradeoff');
  });

  it('defaults confidence to "low" when invalid or missing', () => {
    const raw = JSON.stringify({
      nodes: [
        { type: 'tradeoff', label: 'X', evidence: ['m1'] },
        { type: 'option', label: 'A', evidence: ['m1'], confidence: 'super-high' },
      ],
      edges: [],
    });
    const out = parseExtractorOutput(raw);
    expect(out.nodes[0]!.confidence).toBe('low');
    expect(out.nodes[1]!.confidence).toBe('low');
  });

  it('drops edges with unknown via', () => {
    const raw = JSON.stringify({
      nodes: [
        { type: 'tradeoff', label: 'X', evidence: ['m1'], confidence: 'high' },
        { type: 'option', label: 'A', evidence: ['m1'], confidence: 'high' },
      ],
      edges: [
        { from: 'tradeoff:X', to: 'option:A', via: 'has_option' },
        { from: 'tradeoff:X', to: 'option:A', via: 'made-up-relation' },
      ],
    });
    const out = parseExtractorOutput(raw);
    expect(out.edges.length).toBe(1);
    expect(out.edges[0]!.via).toBe('has_option');
  });

  it('drops edges that reference nodes not in the graph', () => {
    const raw = JSON.stringify({
      nodes: [{ type: 'tradeoff', label: 'X', evidence: ['m1'], confidence: 'high' }],
      edges: [
        { from: 'tradeoff:X', to: 'option:Phantom', via: 'has_option' },
      ],
    });
    const out = parseExtractorOutput(raw);
    expect(out.edges.length).toBe(0);
  });

  it('matches edge endpoints case-insensitively on label', () => {
    const raw = JSON.stringify({
      nodes: [
        { type: 'tradeoff', label: 'Performance ↔ Lesbarkeit', evidence: ['m1'], confidence: 'high' },
        { type: 'option', label: 'Cache-Layer', evidence: ['m1'], confidence: 'high' },
      ],
      edges: [
        { from: 'tradeoff:Performance ↔ Lesbarkeit', to: 'option:cache-layer', via: 'has_option' },
      ],
    });
    const out = parseExtractorOutput(raw);
    expect(out.edges.length).toBe(1);
  });

  it('honors ref-based endpoints when ref is set on the node', () => {
    const raw = JSON.stringify({
      nodes: [
        { type: 'feature', label: 'Entscheidungsrahmen', evidence: ['m1'], confidence: 'high', ref: '66c67c77' },
        { type: 'tradeoff', label: 'Pol A ↔ Pol B', evidence: ['m2'], confidence: 'medium' },
      ],
      edges: [
        { from: 'tradeoff:Pol A ↔ Pol B', to: 'ref:66c67c77', via: 'konkretisiert' },
      ],
    });
    const out = parseExtractorOutput(raw);
    expect(out.edges.length).toBe(1);
  });

  it('handles malformed nested objects gracefully', () => {
    const raw = JSON.stringify({
      nodes: [null, 'string-not-object', { type: 'tradeoff', label: 'OK', evidence: ['m1'], confidence: 'high' }],
      edges: [42, { from: 'tradeoff:OK', to: 'tradeoff:OK', via: 'reinforces' }],
    });
    const out = parseExtractorOutput(raw);
    expect(out.nodes.length).toBe(1);
    expect(out.edges.length).toBe(1);
  });

  it('returns empty for empty top-level', () => {
    expect(parseExtractorOutput('{}')).toEqual({ nodes: [], edges: [] });
    expect(parseExtractorOutput('{"nodes":[],"edges":[]}')).toEqual({ nodes: [], edges: [] });
  });
});
