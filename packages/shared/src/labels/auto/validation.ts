/**
 * Auto-Label Rule Validation
 *
 * Validates auto-label rule patterns at config-save time to catch
 * invalid regex syntax and catastrophic backtracking patterns early.
 *
 * Called from the label config validator (validators.ts) when labels/config.json
 * is being written.
 */

export interface AutoLabelValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Known catastrophic backtracking patterns (nested quantifiers).
 * These can cause ReDoS (Regular Expression Denial of Service) by making
 * the regex engine take exponential time on non-matching inputs.
 *
 * Matches patterns like: (a+)+, (a*)+, (\w+)*, ([a-z]+)+
 */
const CATASTROPHIC_BACKTRACKING_PATTERNS = [
  /\([^)]*[+*][^)]*\)[+*]/, // (x+)+ or (x*)+ or (x+)* etc.
  /\([^)]*[+*][^)]*\)\{/,   // (x+){n} quantified groups with inner quantifier
]

/**
 * True when a pattern has a capturing group: `(…)` or `(?<name>…)` — not `(?:…)`, a lookaround, or a
 * paren that is escaped or inside a character class.
 */
export function hasCaptureGroup(pattern: string): boolean {
  const bare = pattern.replace(/\\./g, '').replace(/\[[^\]]*\]/g, '')
  return /\((?!\?)|\(\?<(?![=!])/.test(bare)
}

/** Shown when a rule sets a value on a label that cannot hold one. */
const PLAIN_LABEL_VALUE_IGNORED =
  'this label has no valueType, so the rule only applies the plain label. Give the label a valueType to store values.'

/**
 * Validate a single auto-label rule.
 * Checks regex syntax, flags, and known problematic patterns.
 *
 * @param pattern - The regex pattern string
 * @param flags - Optional flags (defaults to 'gi')
 * @param context - The label's valueType and the rule's valueTemplate, when known: a plain label
 *   (no valueType) is presence-only, so its rules store no value
 * @returns Validation result with errors/warnings
 */
export function validateAutoLabelRule(
  pattern: string,
  flags?: string,
  context?: { valueType?: string; valueTemplate?: string },
): AutoLabelValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // 1. Check regex compiles without errors
  try {
    const effectiveFlags = flags
      ? (flags.includes('g') ? flags : flags + 'g')
      : 'gi'
    new RegExp(pattern, effectiveFlags)
  } catch (e) {
    errors.push(`Invalid regex pattern: ${e instanceof Error ? e.message : 'Unknown error'}`)
    return { valid: false, errors, warnings }
  }

  // 2. Check for catastrophic backtracking patterns (nested quantifiers)
  for (const badPattern of CATASTROPHIC_BACKTRACKING_PATTERNS) {
    if (badPattern.test(pattern)) {
      errors.push(
        `Pattern contains nested quantifiers which can cause catastrophic backtracking (ReDoS). ` +
        `Simplify the pattern to avoid nested repetition like (a+)+.`
      )
      break
    }
  }

  // 3. How a match becomes a value: nothing on a plain label (a template is ignored there);
  //    on a valued label, a pattern without capture groups stores the whole match — unless a
  //    constant template (no $N) supplies the value.
  const constantTemplate = context?.valueTemplate !== undefined && !/\$\d/.test(context.valueTemplate)
  if (context && !context.valueType) {
    if (context.valueTemplate !== undefined) warnings.push(`valueTemplate is ignored: ${PLAIN_LABEL_VALUE_IGNORED}`)
  } else if (!hasCaptureGroup(pattern) && !constantTemplate) {
    warnings.push(
      'Pattern has no capture groups. The entire match will be used as the label value. ' +
      'Add capture groups (parentheses) to extract specific parts.'
    )
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/** Longest question a semantic rule may ask (the message itself is the state; the question is instructions). */
export const SEMANTIC_RULE_MAX_QUESTION_CHARS = 500

/**
 * Validate a semantic (decision-model) auto-label rule: a non-empty question,
 * a threshold in (0, 1] when given, and a string value when given. With `context`
 * (the label's valueType), a value on a plain label is flagged as ignored.
 */
export function validateSemanticAutoLabelRule(
  rule: { semantic?: unknown; threshold?: unknown; value?: unknown },
  context?: { valueType?: string },
): AutoLabelValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (typeof rule.semantic !== 'string' || !rule.semantic.trim()) {
    errors.push('Semantic rule needs a non-empty "semantic" question, e.g. "Is the user asking about billing?"')
  } else if (rule.semantic.length > SEMANTIC_RULE_MAX_QUESTION_CHARS) {
    errors.push(`Semantic question is too long (${rule.semantic.length} > ${SEMANTIC_RULE_MAX_QUESTION_CHARS} characters)`)
  } else if (!/\?\s*$/.test(rule.semantic.trim()) && !/^(is|are|does|do|did|has|have|was|were|should|can|could|will|would)\b/i.test(rule.semantic.trim())) {
    warnings.push('Semantic rules work best as a yes/no question ("Is the user asking about billing?")')
  }

  if (rule.threshold !== undefined) {
    if (typeof rule.threshold !== 'number' || !Number.isFinite(rule.threshold) || rule.threshold <= 0 || rule.threshold > 1) {
      errors.push('Semantic rule threshold must be a number greater than 0 and at most 1 (default 0.9)')
    } else if (rule.threshold < 0.5) {
      warnings.push('A threshold below 0.5 applies the label when the model leans "no" — probably not intended')
    }
  }

  if (rule.value !== undefined && typeof rule.value !== 'string') {
    errors.push('Semantic rule value must be a string')
  } else if (rule.value !== undefined && context && !context.valueType) {
    warnings.push(`value is ignored: ${PLAIN_LABEL_VALUE_IGNORED}`)
  }

  return { valid: errors.length === 0, errors, warnings }
}
