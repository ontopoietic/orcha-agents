---
name: "Swarm Mutation Hardening"
description: "The test-quality gate from SwarmForge: language-level mutation (mutates production code) and Gherkin-level mutation (mutates spec values). A surviving mutant means the tests are blind there — harden until mutants die. Coverage is not enough."
alwaysAllow: ["Bash"]
icon: 🧬
---

# Swarm Mutation Hardening

This is the **test-quality gate**. Its job is not to prove the code works — it is to
prove the **tests are good**. Read `swarm-testing` first for the testable/unsuitable
separation and tooling procurement rules.

> Coverage says "this line was executed." Mutation says "if this line broke, a test
> would fail." Only the second is evidence that your tests have value.

## Two mutation layers

SwarmForge hardens **both** test layers, because there are two kinds of tests:

### 1. Language mutation (mutates production code)
Tools: `mutate4go` (Go), `clj-mutate` (Clojure), `mutate4java` (Java),
**Stryker** (TS/JS). The tool flips operators and constants in the **production code**
(`>` → `>=`, `+` → `-`, `true` → `false`, removing statements, …) and re-runs the tests.

- **Killed mutant** = a test failed → the tests cover that behavior meaningfully. Good.
- **Surviving mutant** = all tests still green despite corrupted code → the tests are
  **blind** at that site. This is a test-quality defect, not a code defect.

The deliverable of hardening is: **drive surviving mutants to zero** (or to an
explicitly justified, documented residue) by adding/strengthening tests — not by
deleting the mutant.

### 2. Gherkin acceptance mutation (mutates spec example values)
Tool: `gherkin-mutator` from `github.com/unclebob/Acceptance-Pipeline-Specification`
(prefer the Babashka APS build; Go APS only if Babashka does not work in the
environment). It mutates the **example values in the Gherkin specs** and re-runs the
acceptance suite.

- If acceptance tests stay green after a spec value was falsified → the acceptance suite
  is not checking sharply enough. Strengthen the assertions/steps.

This is called **soft Gherkin mutation** in the hardener/architect roles.

## Procedure

1. Confirm only **testable modules** are in scope (per `swarm-testing`). Exclude
   environmentally unsuitable modules and keep property tests out of the mutation run.
2. Run language mutation on the changed modules. Long runs **must report periodic
   progress/status** so a normal long run is distinguishable from a hang.
3. For each surviving mutant: add or strengthen a test so it dies. Re-run.
4. Run Gherkin acceptance mutation on the relevant features; strengthen weak acceptance
   checks the same way.
5. Record the result in the handoff: mutants generated, killed, surviving (with
   justification for any residue).

## Guardrails

- **Never hand-edit** mutation manifests — let the tool maintain them.
- **Never** kill a mutant by deleting/weakening the mutation. Kill it by improving a test.
- Do not run whole-suite language mutation concurrently with acceptance generation.
- TS/JS: use **Stryker** for language mutation. There is no unclebob Gherkin-mutator for
  TS — if acceptance specs exist in another format, state in the handoff that Gherkin
  mutation was not applicable.
