---
name: "Swarm Acceptance (Gherkin)"
description: "Acceptance-test discipline from SwarmForge using the Acceptance-Pipeline-Specification (APS): write precise Gherkin specs from user intent, generate acceptance tests, run generation and tests sequentially. Pairs with Gherkin mutation in swarm-mutation-hardening."
alwaysAllow: ["Bash"]
icon: 📋
---

# Swarm Acceptance — Gherkin / Acceptance Pipeline

The acceptance layer turns **user intent into executable, checkable specifications**.
Read `swarm-testing` first. The sharpness of these specs is later verified by Gherkin
mutation in `swarm-mutation-hardening`.

## Tooling — Acceptance Pipeline Specification (APS)

Use `github.com/unclebob/Acceptance-Pipeline-Specification` for Gherkin acceptance tests.
APS supplies the `gherkin-parser` and `gherkin-mutator` commands — **install or build
them from that repo; do not reimplement them in the project.**

- Prefer the **Babashka APS tools** for `gherkin-parser`, `gherkin-mutator`, and related
  support commands.
- Use the **Go-based APS tools only if** the Babashka APS tools do not work in the
  current environment.

**Project-specific** APS components you provide (not from the APS repo): the acceptance
entrypoint generator, acceptance runtime, project step handlers, runner adapter, and
convenience scripts.

## Workflow

1. **Specify** (specifier role): turn user intent into **precise Gherkin acceptance
   specifications**. Ask for approval before handoff — specs are the contract.
2. **Implement** (coder role): implement the approved behavior slice with TDD, then
   generate the acceptance tests for that slice.
3. **Verify**: run acceptance generation and acceptance tests **sequentially** — never
   run whole-suite language tests concurrently with acceptance generation.
4. **Harden**: Gherkin acceptance mutation (`gherkin-mutator` mutates the example values)
   confirms the acceptance suite actually catches spec violations — see
   `swarm-mutation-hardening`.

## Progress & hang detection

Gherkin acceptance mutation runs can be long. They **must report periodic
progress/status** so agents can distinguish normal long-running work from a hang.

## Guardrails

- Do not hand-edit Gherkin acceptance-mutation manifests — let `gherkin-mutator` maintain them.
- Run acceptance generation and acceptance tests sequentially, with project-local caches
  inside the assigned worktree.
- TS/JS note: there is no unclebob APS for TypeScript. If you use another BDD/acceptance
  framework, state in the handoff that APS Gherkin mutation was not applicable and which
  acceptance tooling stood in.
