---
name: "Swarm Testing"
description: "Core engineering and test discipline adapted from SwarmForge: testable/unsuitable module separation, TDD, fresh tooling procurement, verification gates before handoff. The umbrella skill — read this first, then the specific gate skills (mutation-hardening, crap-dry, acceptance-gherkin)."
alwaysAllow: ["Bash"]
icon: 🧪
---

# Swarm Testing — Engineering & Test Constitution

This skill is a faithful adaptation of SwarmForge's `engineering.prompt` constitution
article (github.com/unclebob/swarm-forge). It encodes the **test discipline**, not a
specific topology. The central conviction:

> Code correctness ("is it green?") and **test quality** ("would a test fail if the
> code broke?") are two different things. Coverage proves a line *ran*; only
> **mutation testing** proves a test would *catch a regression*.

Companion skills (invoke as separate quality gates):
- `swarm-mutation-hardening` — language + Gherkin mutation (the test-quality gate)
- `swarm-crap-dry` — CRAP (risk) + DRY (duplication) review
- `swarm-acceptance-gherkin` — Gherkin / Acceptance-Pipeline specs

## Startup: procure fresh tooling

On startup, procure the latest **CRAP, mutation, and DRY** tools for the project
language directly from the `github.com/unclebob/...` repositories and get them ready
to run. **Do not** rely on stale cached, vendored, or preinstalled copies when a fresh
GitHub install/build is possible.

| Language | Install | Mutation | CRAP | DRY |
|---|---|---|---|---|
| Go | `go install` | `github.com/unclebob/mutate4go` | `github.com/unclebob/crap4go` | `github.com/unclebob/dry4go` |
| Clojure | Clojure CLI / deps.edn | `github.com/unclebob/clj-mutate` | `github.com/unclebob/crap4clj` | `github.com/unclebob/dry4clj` |
| Java | Maven (`mvn`) | `github.com/unclebob/mutate4java` | `github.com/unclebob/crap4java` | `github.com/unclebob/dry4java` |

### TypeScript / JavaScript / other languages (Orcha addition)

Unclebob's `*4go` / `*4clj` / `*4java` tools **do not cover TS/JS** (orcha-agents and
kurzambau are TypeScript/Bun). When working in an unsupported language, map to
equivalents and state in the handoff which tool stood in for which gate:

| Gate | TS/JS equivalent | Notes |
|---|---|---|
| Mutation | **Stryker** (`@stryker-mutator/core`) | Real mutation testing for TS/JS |
| CRAP | derive from coverage × cyclomatic complexity | No drop-in; compute from `vitest`/`bun test` coverage + a complexity linter |
| DRY | `jscpd` (copy/paste detector) | Duplication scan |
| Coverage | `bun test --coverage` / `vitest --coverage` | Native |

If no equivalent exists for the gate in the current language, **say so explicitly** in
the handoff rather than silently skipping it.

## Language defaults

- Clojure projects: prefer **Babashka** where possible.
- Clojure projects: prefer **Speclj** for unit and behavior tests; validate spec syntax
  with `github.com/unclebob/speclj-structure-check`. If a Speclj spec file changed, run
  the structure check **before** executing the relevant test command.
- Java projects: **avoid Maven to run tests** — build dedicated test runners and run those.

## Design & testability

- Work in **small, reviewable increments**.
- Prefer the **simplest design** that supports the current behavior and leaves clear
  options for the next step.
- Keep tests **close to the behavior** being changed.
- **Separate testable modules from environmentally unsuitable modules** — those that
  open GUIs, depend on external devices, throw environment errors, emit system errors,
  or hang under automated tests. Maximize testable code; minimize the unsuitable boundary.
- **Only testable modules** participate in tools that run tests: unit tests, acceptance
  tests, coverage, mutation testing, CRAP analysis, DRY analysis that invokes tests, and
  property tests.
- Keep **property tests separate** from normal verification. Do not include property-test
  tags in normal unit coverage, Gherkin acceptance mutation, language mutation tools,
  CRAP, or coverage commands — unless the role owns property-test verification or the user
  explicitly asks for property tests. (This keeps the quality metrics honest.)

## TDD (the coder's discipline)

The inner red-green-refactor loop is **one test at a time**: write a failing test for a
single behavior, make it pass with the simplest code, then refactor — never write all
tests up front (that produces tests coupled to imagined behavior).

> **Use the `tdd` skill for the inner loop.** If a richer `tdd` skill is available in the
> environment (it ships globally at `~/.agents/skills/tdd/`), defer to it for the
> test-writing craft: vertical-slice tracer bullets, deep modules, mocking guidance, and
> interface design. **This skill does not restate that** — it sits *on top*, adding the
> outer quality gates (mutation, CRAP, DRY, acceptance) that prove the whole suite is
> actually good. The two are complementary layers, not alternatives.

In specification workflows, also generate the **acceptance tests** for the approved
behavior slice (see `swarm-acceptance-gherkin`).

### Terminology note — "CRAP"

The `tdd` skill uses "crap tests" colloquially for *bad tests* (tests that pass when
behavior breaks). In **this** skill family, **CRAP** is a formal metric — *Change Risk
Anti-Patterns* (cyclomatic complexity × coverage), see `swarm-crap-dry`. Same word, two
meanings: mutation hardening is what objectively kills the colloquial "crap tests".

## Verification (before every handoff)

- Before running language, build, or test commands, prefer **project-local
  cache/configuration paths inside the assigned worktree**. Avoid default cache locations
  that write outside the project and may trigger sandbox/permission restrictions.
- Run acceptance generation and acceptance tests **sequentially**.
- **Do not** run whole-suite language test commands concurrently with acceptance generation.
- Run the relevant **local verification command before handoff** whenever the project has one.

## Guardrails

- **Do not edit** mutation-testing or Gherkin acceptance-mutation manifests by hand — let
  the approved mutation tools update those manifests as part of their normal runs.
- **Do not commit** unrelated local changes or generated artifacts unless required for the task.
- Before relying on an unfamiliar command, **inspect local help or project documentation**.
