/**
 * Canonical Session Labels
 *
 * The stored form of a session's label entries for a label tree, whoever wrote them: older
 * auto-labelling (`bug::bug`, `bug::Bug`, `trip::`), an automation that put `bug::x` on a plain label,
 * an agent that sent `["Bug", "bug"]`. Browser-safe.
 */

import type { LabelConfig } from './types.ts';
import { flattenLabels } from './tree.ts';
import { LabelEntrySet, extractLabelId } from './values.ts';

/** Ids of the labels whose values fold case: `string` values (issue keys, emails, names). */
function stringValuedIds(flat: readonly LabelConfig[]): Set<string> {
  return new Set(flat.filter(label => label.valueType === 'string').map(label => label.id));
}

/**
 * The value-case rule of a label tree, for LabelEntrySet: `string` values fold case (`CRA-1` is
 * `cra-1`); links, numbers and dates compare exactly (a YouTube id or a short link is case-sensitive).
 */
export function foldsValueCase(labels: LabelConfig[]): (labelId: string) => boolean {
  const folding = stringValuedIds(flattenLabels(labels));
  return labelId => folding.has(labelId);
}

/**
 * Session label entries in canonical form, first occurrence first:
 * - a plain label (no `valueType`) is its bare id: values stored on one are dropped;
 * - an empty value (`priority::`) is the bare id, and a bare valued label is dropped when the same
 *   label also carries a value;
 * - an entry the list already has by meaning (LabelEntrySet) is dropped.
 * Entries of labels the tree doesn't know are kept as they are (read paths filter them).
 */
export function canonicalizeSessionLabels(entries: readonly string[], labels: LabelConfig[]): string[] {
  const flat = flattenLabels(labels);
  const byId = new Map(flat.map(label => [label.id, label]));
  const folding = stringValuedIds(flat);

  const canonical = entries.map((entry) => {
    const id = extractLabelId(entry);
    const label = byId.get(id);
    return label && (!label.valueType || entry === `${id}::`) ? id : entry;
  });
  const valuedIds = new Set(canonical.filter(entry => entry !== extractLabelId(entry)).map(extractLabelId));

  const seen = new LabelEntrySet([], labelId => folding.has(labelId));
  const out: string[] = [];
  for (const entry of canonical) {
    if (byId.get(entry)?.valueType && valuedIds.has(entry)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}
