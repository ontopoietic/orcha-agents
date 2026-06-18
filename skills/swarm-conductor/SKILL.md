---
name: "Swarm Conductor"
description: "Orchestrates a SwarmForge-style role swarm from your working session. Load this, then say 'starte den <rolle>-agent' (e.g. 'starte den refactor-agent') to spawn a background session that loads that role's skill and quality gates. Defines the role roster, the spawn recipe, worktree isolation, and the handoff convention."
alwaysAllow: ["Bash"]
icon: 🎼
---

# Swarm Conductor

You orchestrate a SwarmForge-style swarm of role agents (adapted from
github.com/unclebob/swarm-forge). The user drives you manually from their working
session. Each role runs as an **independent background session** (`spawn_session`,
fire-and-forget) that loads its own role skill, which in turn loads the relevant test
quality gates (`swarm-testing`, `swarm-crap-dry`, `swarm-mutation-hardening`,
`swarm-acceptance-gherkin`).

## Trigger phrases → spawn

When the user says **"starte den `<role>`-agent"** (or "start the `<role>` agent", "spawn
`<role>`"), spawn that role. Recognized roles (roster):

| Role phrase | Role slug | Role skill |
|---|---|---|
| specifier / spezifizierer | `specifier` | `swarm-role-specifier` |
| coder / coder-agent | `coder` | `swarm-role-coder` |
| cleaner | `cleaner` | `swarm-role-cleaner` |
| refactor / refactorer | `refactorer` | `swarm-role-refactorer` |
| architect / architekt | `architect` | `swarm-role-architect` |
| hardener / hardender | `hardener` | `swarm-role-hardener` |
| qa / qa-agent | `qa` | `swarm-role-qa` |

## Spawn recipe

For role `<role>` with role skill `<skill>`:

1. **(Optional but recommended) Create an isolated worktree** so parallel agents don't
   collide on commits:
   ```bash
   git worktree add ".worktrees/<role>" HEAD 2>/dev/null || echo "worktree exists, reusing"
   ```
   If you skip this, the agent works in the current checkout — fine for **one agent at a
   time**, risky for concurrent roles.

2. **Spawn the background session:**
   ```
   spawn_session({
     name: "<role>",
     prompt: "Read the file skills/<skill>/SKILL.md with the Read tool and follow it
              exactly for this run.\n\nConductor session id: <YOUR_SESSION_ID> — report
              your handoff back to it with send_agent_message.\n\nTarget of this run:
              <what the user wants done>.",
     workingDirectory: ".worktrees/<role>",   // omit to use current checkout
     labels: ["swarm", "role:<role>"],
     permissionMode: "allow-all"
   })
   ```
   Get `<YOUR_SESSION_ID>` from `get_session_info` if you don't already know it. Fill
   `<what the user wants done>` from the user's request; ask if it's unclear.

3. **Confirm to the user**: name the spawned session and tell them it appears in the
   session list and will report back when done.

## Handoff convention (orcha translation of SwarmForge's file-based handoff)

SwarmForge roles "notify the next role using the file-based handoff format". In orcha we
map that to messaging + status. Every role skill ends by doing this — you are the hub:

- A role reports back via `send_agent_message` to the **conductor session** with: role,
  what changed, commit SHA(s), pass/fail of its gates, and the **suggested next role**.
- A role sets its session **status to `done`** when its gate passes (or `needs-review`
  if it found blocking issues).
- **You** (conductor) relay to the user and, on their go, spawn the next role — passing
  the previous role's commit SHA / worktree in the new spawn prompt.

The normal six-pack flow is:
`specifier → coder → cleaner → architect → hardener → QA → completion`.
Four-pack: `specifier → coder → refactorer → architect`.
Two-pack: `coder → cleaner → coder`.
You do **not** auto-advance the chain — the user triggers each step (or explicitly tells
you to run a sequence).

## Honest limits

- `spawn_session` is fire-and-forget: you cannot synchronously "await" a role. Coordinate
  via the returned messages / `list_sessions` filtered by `label:swarm`.
- Worktree creation is a manual bash pre-step (above) — not automatic.
- Each role's actual mutation/CRAP/DRY execution only runs natively for Go/Clojure/Java;
  on TS/JS repos the gates fall back to Stryker/jscpd/coverage (see `swarm-testing`).
