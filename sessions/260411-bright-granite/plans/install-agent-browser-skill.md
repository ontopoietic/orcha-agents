# Install Vercel Agent Browser Skill (Global)

## Goal
Install the [agent-browser skill](https://github.com/vercel-labs/agent-browser/tree/main/skills/agent-browser) from `vercel-labs/agent-browser` globally so it's available in **all workspaces** on both **Craft Agents** and **Orcha Agents**.

## Steps

### 1. Create skill directory
```bash
mkdir -p ~/.agents/skills/agent-browser
```

### 2. Download SKILL.md from GitHub
```bash
curl -sL https://raw.githubusercontent.com/vercel-labs/agent-browser/main/skills/agent-browser/SKILL.md \
  -o ~/.agents/skills/agent-browser/SKILL.md
```

### 3. Verify the file was downloaded correctly
```bash
head -20 ~/.agents/skills/agent-browser/SKILL.md
wc -l ~/.agents/skills/agent-browser/SKILL.md
```

### 4. Validate the skill
Run `skill_validate` to confirm the skill is properly structured.

## Result
The skill will be available as a global skill at:
```
~/.agents/skills/agent-browser/SKILL.md
```

This is picked up by both apps across all workspaces:
- **Craft Agents**: `lukas-auer-coaching`, `my-workspace`
- **Orcha Agents**: `orcha`
