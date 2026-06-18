---
name: "Swarm CRAP & DRY"
description: "Risk and duplication review from SwarmForge. CRAP (Change Risk Anti-Patterns) flags code that is complex AND under-tested — exactly where mutation hardening is most urgent. DRY flags duplication. Use to prioritize where to harden."
alwaysAllow: ["Bash"]
icon: 📊
---

# Swarm CRAP & DRY Review

Two diagnostic gates that tell you **where** quality work is most needed. Read
`swarm-testing` first for tooling procurement.

## CRAP — Change Risk Anti-Patterns

Tools: `crap4go` (Go), `crap4clj` (Clojure), `crap4java` (Java). For TS/JS there is no
drop-in — derive the CRAP signal from **coverage × cyclomatic complexity** (e.g. `bun
test --coverage` / `vitest --coverage` combined with a complexity linter).

CRAP combines **cyclomatic complexity** with **test coverage**: a method that is both
complex and under-tested scores high. A high CRAP score marks code that is *risky to
change* — and it is precisely the place where surviving mutants are most likely.

**Use CRAP to prioritize:** run it before/with mutation hardening to target the riskiest
code first, rather than mutating everything blindly. High CRAP → harden here next
(hand off to `swarm-mutation-hardening`).

## DRY — duplication analysis

Tools: `dry4go` (Go), `dry4clj` (Clojure), `dry4java` (Java). TS/JS equivalent: `jscpd`.

DRY analysis detects duplicated logic. Some DRY tools invoke tests — when they do, they
are subject to the same **testable-modules-only** rule (per `swarm-testing`): keep
unsuitable modules and property tests out of the run.

Resolve duplication with **behavior-preserving** refactoring; the existing test/mutation
results must still hold after the change.

## Procedure

1. Procure fresh CRAP + DRY tools for the language (or the documented TS/JS equivalents).
2. Run CRAP on the changed modules; rank by score.
3. Run DRY; identify duplication clusters.
4. Report rankings in the handoff. The high-CRAP and high-duplication items become the
   work-list for cleanup and mutation hardening.

## Guardrails

- Behavior-preserving only — do not change observable behavior during CRAP/DRY cleanup.
- Keep property tests and environmentally unsuitable modules out of any test-invoking run.
- Do not commit unrelated changes or generated artifacts.
