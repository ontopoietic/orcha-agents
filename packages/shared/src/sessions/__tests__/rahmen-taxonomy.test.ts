import { describe, expect, it } from 'bun:test';
import {
  ARTIFACT_TYPES,
  RELATION_TYPES,
  isKnownArtifactType,
  isKnownRelationType,
  renderTaxonomyForPrompt,
} from '../rahmen-taxonomy.ts';

describe('Rahmen-Taxonomie', () => {
  it('has all core artifact types the user flagged', () => {
    const required = ['tradeoff', 'option', 'constraint', 'decision', 'risk', 'chance', 'feature', 'befund', 'anliegen'];
    const present = new Set(ARTIFACT_TYPES.map((a) => a.type));
    for (const t of required) {
      expect(present.has(t)).toBe(true);
    }
  });

  it('every artifact type has at least one positive example', () => {
    for (const a of ARTIFACT_TYPES) {
      expect(a.positiveExamples.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(20);
    }
  });

  it('contains both German artefakt-relation and English tradeoff-relation vocabularies', () => {
    const present = new Set(RELATION_TYPES.map((r) => r.type));
    // Sample from each vocabulary
    expect(present.has('begründet')).toBe(true);
    expect(present.has('konkretisiert')).toBe(true);
    expect(present.has('concretizes')).toBe(true);
    expect(present.has('reinforces')).toBe(true);
  });

  it('relation type scope is either "artefakt" or "tradeoff"', () => {
    for (const r of RELATION_TYPES) {
      expect(['artefakt', 'tradeoff']).toContain(r.scope);
    }
  });

  it('isKnownArtifactType / isKnownRelationType reject unknown values', () => {
    expect(isKnownArtifactType('tradeoff')).toBe(true);
    expect(isKnownArtifactType('totally-not-a-type')).toBe(false);
    expect(isKnownRelationType('begründet')).toBe(true);
    expect(isKnownRelationType('does-not-exist')).toBe(false);
  });

  it('renderTaxonomyForPrompt produces non-empty markdown including all types', () => {
    const md = renderTaxonomyForPrompt();
    expect(md.length).toBeGreaterThan(500);
    for (const a of ARTIFACT_TYPES) {
      expect(md).toContain(`### ${a.type}`);
    }
    for (const r of RELATION_TYPES) {
      expect(md).toContain(`**${r.type}**`);
    }
  });
});
