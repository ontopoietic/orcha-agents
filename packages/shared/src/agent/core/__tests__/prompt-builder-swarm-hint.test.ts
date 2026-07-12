/**
 * Unit tests for PromptBuilder.getSwarmSkillHint() (ORCHA §bg-child-sessions
 * p7). Field incident: a plain-text "run this with the swarm" request never
 * loads the swarm skill (no `[skill:...]` mention to trip the prerequisite
 * gate), so the agent improvised orchestration via the background-by-design
 * `Workflow` tool and the work silently died at turn end. This hint nudges
 * the agent to read `skills/swarm/SKILL.md` first whenever the request text
 * looks like swarm/role-team orchestration — but only when that skill
 * actually exists in the workspace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptBuilder } from '../prompt-builder.ts';

function makeBuilder(workspaceRootPath: string): PromptBuilder {
  return new PromptBuilder({
    workspace: {
      id: 'test-workspace-id',
      name: 'Test Workspace',
      slug: 'workspace',
      rootPath: workspaceRootPath,
      createdAt: Date.now(),
    },
  });
}

describe('PromptBuilder.getSwarmSkillHint', () => {
  let workspaceRootPath: string;

  beforeEach(() => {
    workspaceRootPath = mkdtempSync(join(tmpdir(), 'swarm-hint-test-'));
  });

  afterEach(() => {
    rmSync(workspaceRootPath, { recursive: true, force: true });
  });

  function writeSwarmSkill(): void {
    const skillDir = join(workspaceRootPath, 'skills', 'swarm');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# swarm skill\n');
  }

  it('returns the hint when the message mentions "swarm" and the skill exists', () => {
    writeSwarmSkill();
    const builder = makeBuilder(workspaceRootPath);
    const hint = builder.getSwarmSkillHint('Can you run this with the swarm?');
    expect(hint).toContain('skills/swarm/SKILL.md');
    expect(hint).toContain('swarm_skill_hint');
  });

  it('returns null when the message mentions "swarm" but the skill does NOT exist', () => {
    // No writeSwarmSkill() call — workspace has no skills/swarm/SKILL.md
    const builder = makeBuilder(workspaceRootPath);
    const hint = builder.getSwarmSkillHint('Can you run this with the swarm?');
    expect(hint).toBeNull();
  });

  it('returns the hint for "role team" phrasing when the skill exists', () => {
    writeSwarmSkill();
    const builder = makeBuilder(workspaceRootPath);
    const hint = builder.getSwarmSkillHint('Spin up the role team for this feature.');
    expect(hint).not.toBeNull();
  });

  it('returns the hint for a role name paired with an orchestration verb', () => {
    writeSwarmSkill();
    const builder = makeBuilder(workspaceRootPath);
    const hint = builder.getSwarmSkillHint('Please spawn a coder to implement this.');
    expect(hint).not.toBeNull();
  });

  it('returns null for a bare role-name mention with no orchestration verb', () => {
    writeSwarmSkill();
    const builder = makeBuilder(workspaceRootPath);
    const hint = builder.getSwarmSkillHint('I think the qa on this feature was thorough.');
    expect(hint).toBeNull();
  });

  it('returns null for ordinary requests even when the skill exists', () => {
    writeSwarmSkill();
    const builder = makeBuilder(workspaceRootPath);
    const hint = builder.getSwarmSkillHint('Fix the off-by-one bug in the paginator.');
    expect(hint).toBeNull();
  });

  it('returns null for an empty message', () => {
    writeSwarmSkill();
    const builder = makeBuilder(workspaceRootPath);
    const hint = builder.getSwarmSkillHint('');
    expect(hint).toBeNull();
  });
});
