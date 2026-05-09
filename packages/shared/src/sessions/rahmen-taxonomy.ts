/**
 * Rahmen-Taxonomie — definitions of orcha framework artifact types
 * and the relation vocabulary that connects them.
 *
 * Used by the artifact-extractor agent (Phase A.2 step B) to recognize
 * tradeoffs, options, constraints, etc. in conversation transcripts and
 * extract them as a typed subgraph for the episode record.
 *
 * Sourced from `~/Developer/orcha/packages/cli/src/commands/*.ts` —
 * the orcha-CLI command surface IS the canonical taxonomy. When new
 * types are added there, append here and bump SCHEMA_VERSION.
 *
 * Initial coverage prioritizes the artifacts the user flagged as
 * "interessant für semantisches Wissen": tradeoff, option, constraint,
 * decision, risk, chance, etc. Code/file/plan artifacts stay in the
 * deterministic Track A extractor.
 */

export const RAHMEN_TAXONOMY_VERSION = 1;

// ============================================================================
// Artifact type definitions
// ============================================================================

export interface ArtifactTypeDef {
  /** Canonical lowercase type, matches the orcha-CLI subcommand name. */
  type: string;
  /** One-sentence definition for the LLM prompt. */
  description: string;
  /** Key properties the LLM should look for to recognize this type. */
  signals: string[];
  /** 1-2 positive recognition examples. Concrete > abstract. */
  positiveExamples: string[];
  /** Optional anti-pattern — common false-positive to suppress. */
  antiPattern?: string;
}

/**
 * Initial curated set. Not exhaustive of orcha's ~40 commands, focused
 * on what the rahmen-graph actually carries (tradeoffs, options, risks,
 * etc.). File/plan/code artifacts are NOT in this list — they belong to
 * Track A (deterministic, no LLM needed).
 */
export const ARTIFACT_TYPES: ArtifactTypeDef[] = [
  {
    type: 'tradeoff',
    description: 'A tension between two or more pulls / options. Naming convention: "X ↔ Y". Always has a context (why the tension exists).',
    signals: ['"vs" / "vs."', '"oder" between paired alternatives', 'explicit poles', 'gradual or binary form'],
    positiveExamples: [
      '"Performance vs. Lesbarkeit beim Cache-Layer"',
      '"Sofort liefern oder nach Audit warten"',
    ],
    antiPattern: 'Pure comparison without tension ("Variant A is faster than B") — that is a benchmark, not a tradeoff.',
  },
  {
    type: 'option',
    description: 'A concrete pole / candidate within a tradeoff. Options live INSIDE tradeoffs and only make sense in that context.',
    signals: ['named alternative', 'pol of a tradeoff', 'has properties / consequences'],
    positiveExamples: [
      '"Pol A: animated glow spectrum"',
      '"Pol B: static gradient"',
    ],
    antiPattern: 'A standalone idea without a tradeoff context is a proposal, not an option.',
  },
  {
    type: 'constraint',
    description: 'A hard limit on what can be done. Non-negotiable, framing the solution space.',
    signals: ['"darf nicht" / "muss"', 'numeric limit', 'compliance / legal / SLA', 'outside-imposed'],
    positiveExamples: [
      '"Latenz darf 200ms nicht überschreiten"',
      '"Speicherung von Session-Tokens muss DSGVO-konform sein"',
    ],
  },
  {
    type: 'decision',
    description: 'A resolved choice — typically resolves a tradeoff. Has reasoning and date/context of resolution.',
    signals: ['"wir entscheiden für X"', '"chose A over B"', 'past-tense resolution'],
    positiveExamples: [
      '"User chose Rahmen-Graph over Conformance-Ansicht as the next work item"',
    ],
    antiPattern: 'A still-open option is not a decision.',
  },
  {
    type: 'risk',
    description: 'A negative possibility — what could go wrong. Has likelihood and impact.',
    signals: ['"Risiko" / "wenn X passiert"', 'concern about a future failure mode', 'operates on an option / decision'],
    positiveExamples: [
      '"Risiko: Performance bei vielen Nodes könnte einbrechen"',
    ],
  },
  {
    type: 'chance',
    description: 'A positive possibility — upside that may materialize from an option or decision.',
    signals: ['"Chance" / "Vorteil wäre"', 'future positive outcome'],
    positiveExamples: [
      '"Chance: einheitliches Animation-System für die ganze App"',
    ],
  },
  {
    type: 'assumption',
    description: 'A belief held without proof, on which subsequent reasoning depends. Should be marked so it can be tested later.',
    signals: ['"angenommen", "wenn wir davon ausgehen", "vermutlich"'],
    positiveExamples: [
      '"Wir nehmen an dass User die animation auf jedem Gerät glatt sehen wollen"',
    ],
  },
  {
    type: 'hypothesis',
    description: 'A testable claim with predicted outcome. Stronger than an assumption — has a falsification path.',
    signals: ['"wenn X dann Y"', 'predicted measurable outcome'],
    positiveExamples: [
      '"Wenn wir Memoization hinzufügen, sinkt der Re-Render-Count um >50%"',
    ],
  },
  {
    type: 'feature',
    description: 'A unit of user-facing functionality the project commits to. Has scope, is anchorable.',
    signals: ['concrete user-visible capability', 'has a name'],
    positiveExamples: ['"Entscheidungsrahmen"', '"Echtzeit-Suche"'],
  },
  {
    type: 'befund',
    description: 'A discovered fact about the existing system / codebase / behavior, often diagnostic. Anchorable.',
    signals: ['"observed", "wir haben festgestellt"', 'concrete present-tense state'],
    positiveExamples: [
      '"Befund: alte Sessions zeigen Anker eines anderen Features"',
    ],
  },
  {
    type: 'anliegen',
    description: 'A user-stated need / wish / goal. Soft, often negotiable. Anchorable.',
    signals: ['"ich möchte / brauche / wünsche mir"', 'subjective user need'],
    positiveExamples: [
      '"Anliegen: schnelleres Onboarding für neue Teammitglieder"',
    ],
  },
  {
    type: 'pattern',
    description: 'A recurring shape — across tradeoffs, decisions, behaviors. Reusable. Discovered, not invented.',
    signals: ['"das passiert immer wenn"', '"jedes Mal"', 'cross-instance abstraction'],
    positiveExamples: [
      '"Pattern: Refactor-Sessions enden meist mit Test-Schulden wenn sie unter Zeitdruck stehen"',
    ],
  },
  {
    type: 'policy',
    description: 'A standing rule for how decisions are made in a class of situations. Not a hard constraint, but a default.',
    signals: ['"wir machen das immer so"', 'codified default'],
    positiveExamples: [
      '"Policy: jeder DB-Migration läuft erst auf staging mindestens 24h"',
    ],
  },
  {
    type: 'wert',
    description: 'A first-principle value the project aligns by. Steers tradeoff weighting.',
    signals: ['abstract noun', 'used to justify decisions'],
    positiveExamples: [
      '"Wert: Wartbarkeit über Geschwindigkeit"',
    ],
  },
  {
    type: 'task',
    description: 'A concrete unit of work to be done. Has owner, status, and deadline if scheduled.',
    signals: ['imperative form', '"machen" / "to-do"'],
    positiveExamples: [
      '"Task: Migration 0082 schreiben für Episode-Graph-Schema"',
    ],
  },
];

// ============================================================================
// Relation vocabulary
// ============================================================================

export interface RelationTypeDef {
  type: string;
  /** Which sub-graph this relation lives in. */
  scope: 'artefakt' | 'tradeoff';
  description: string;
}

/**
 * Combined vocabulary from `artefakt-relation.ts` (German) and
 * `tradeoff-relation.ts` (English). Both stay since the orcha CLI keeps
 * them separate. Extractor must use these literal strings as edge.via.
 */
export const RELATION_TYPES: RelationTypeDef[] = [
  // tradeoff-relation (§6)
  { type: 'concretizes', scope: 'tradeoff', description: 'Sub-tradeoff makes a parent tradeoff concrete.' },
  { type: 'reinforces', scope: 'tradeoff', description: 'One tradeoff strengthens another\'s direction.' },
  { type: 'compensates', scope: 'tradeoff', description: 'One tradeoff offsets another\'s pull.' },
  { type: 'constrains', scope: 'tradeoff', description: 'One tradeoff limits the resolution space of another.' },

  // artefakt-relation (§10)
  { type: 'begründet', scope: 'artefakt', description: 'Source justifies / grounds the target.' },
  { type: 'abhängt_von', scope: 'artefakt', description: 'Source depends on target.' },
  { type: 'spannt_auf', scope: 'artefakt', description: 'Source spans / opens up the space the target lives in.' },
  { type: 'verträgt_sich_nicht', scope: 'artefakt', description: 'Source and target are mutually incompatible.' },
  { type: 'triggert', scope: 'artefakt', description: 'Source triggers / causes the target.' },
  { type: 'konkretisiert', scope: 'artefakt', description: 'Source makes target concrete.' },
  { type: 'verstärkt', scope: 'artefakt', description: 'Source amplifies the target.' },
  { type: 'kompensiert', scope: 'artefakt', description: 'Source compensates for the target.' },
  { type: 'beschränkt', scope: 'artefakt', description: 'Source limits the target.' },

  // Convenience cross-cuts the extractor will use even though orcha-CLI
  // doesn't ship explicit subcommands for them — they're modeled via
  // artefakt-relation with appropriate from/to types.
  { type: 'has_option', scope: 'artefakt', description: 'Tradeoff has option as one of its poles.' },
  { type: 'has_risk', scope: 'artefakt', description: 'Option / decision has risk attached.' },
  { type: 'has_chance', scope: 'artefakt', description: 'Option / decision has chance / upside attached.' },
  { type: 'resolves', scope: 'artefakt', description: 'Decision resolves a tradeoff (chooses an option).' },
];

// ============================================================================
// Render helpers
// ============================================================================

/**
 * Render the taxonomy as a markdown block suitable for injection into
 * an LLM system prompt. Compact — just enough to recognize and label.
 */
export function renderTaxonomyForPrompt(): string {
  const out: string[] = [];
  out.push('# Rahmen-Taxonomy');
  out.push('');
  out.push('## Artifact types');
  out.push('');
  for (const a of ARTIFACT_TYPES) {
    out.push(`### ${a.type}`);
    out.push(a.description);
    out.push('');
    out.push(`**Signals:** ${a.signals.join('; ')}`);
    out.push('');
    out.push('**Positive examples:**');
    for (const ex of a.positiveExamples) out.push(`- ${ex}`);
    if (a.antiPattern) {
      out.push('');
      out.push(`**Not this:** ${a.antiPattern}`);
    }
    out.push('');
  }
  out.push('## Relation types');
  out.push('');
  out.push('Use these literal strings as `edge.via`. Mix freely across scope unless the extractor prompt restricts.');
  out.push('');
  for (const r of RELATION_TYPES) {
    out.push(`- **${r.type}** (${r.scope}) — ${r.description}`);
  }
  return out.join('\n');
}

/** Quick lookup helpers used by the extractor + UI. */
export function isKnownArtifactType(type: string): boolean {
  return ARTIFACT_TYPES.some((a) => a.type === type);
}

export function isKnownRelationType(type: string): boolean {
  return RELATION_TYPES.some((r) => r.type === type);
}
