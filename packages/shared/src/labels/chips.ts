/**
 * Session Label Chips
 *
 * How a session's label entries display — the one resolver behind the session row's and the
 * chat header's chips. Browser-safe.
 */

import type { LabelConfig } from './types.ts';
import { parseLabelEntry } from './values.ts';

export interface SessionLabelChip {
  /** Stable key: the label id for a plain chip, `id:position` for a valued one */
  key: string;
  label: LabelConfig;
  /** Valued labels only: the entry's raw value */
  rawValue?: string;
  /**
   * Valued labels: the entry's position in the session's labels, so an edit or removal touches
   * only that entry (`customer::acme` + `customer::globex` stay distinct). Plain labels: undefined —
   * the chip stands for every entry of its label, so removing it clears them all.
   */
  entryIndex?: number;
}

/**
 * The chips for a session's label entries, in entry order: one per plain label and one per entry
 * of a valued label. A plain label (no `valueType`) is presence-only, so values stored on one —
 * older auto-labelling wrote `bug::bug` next to `bug::Bug` — are not shown and its entries collapse
 * into one chip. Entries whose label is not configured are skipped.
 */
export function sessionLabelChips(entries: readonly string[], flatLabels: readonly LabelConfig[]): SessionLabelChip[] {
  const byId = new Map(flatLabels.map(label => [label.id, label]));
  const plainShown = new Set<string>();
  const chips: SessionLabelChip[] = [];
  entries.forEach((entry, entryIndex) => {
    const { id, rawValue } = parseLabelEntry(entry);
    const label = byId.get(id);
    if (!label) return;
    if (label.valueType) {
      chips.push({ key: `${id}:${entryIndex}`, label, rawValue, entryIndex });
    } else if (!plainShown.has(id)) {
      plainShown.add(id);
      chips.push({ key: id, label });
    }
  });
  return chips;
}
