---
name: "Orcha Upgrade"
description: "Upgrade Orcha Agents fork to latest upstream Craft Agents version with conflict resolution and fork-specific fixes"
alwaysAllow: ["Bash"]
---

# Orcha Agents — Upstream Version Upgrade

You are performing a version upgrade of the Orcha Agents fork. Follow this procedure exactly to avoid the pitfalls discovered during previous upgrades (v0.8.3 → v0.8.6).

## Pre-Flight Checks

Before starting, gather context:

1. **Read FORK.md** at the repo root — it documents all fork-specific changes, conflict candidates, and update history.
2. **Check current version**: `grep '"version"' package.json` and compare with latest upstream tag.
3. **Fetch upstream**: `git fetch upstream --tags` (upstream = `https://github.com/lukilabs/craft-agents-oss.git`).
4. **List new versions**: `git tag -l 'v*' --sort=-version:refname | head -10` and identify which versions to upgrade through.

## Step 1: Rebase Fork Commits

```bash
# On main, rebase onto upstream/main
git rebase upstream/main
```

Resolve conflicts per-commit. Refer to FORK.md's "Konflikt-Kandidaten" section for expected conflicts.

**Conflict resolution rules (in priority order):**
1. **Keep both** for IPC handlers, route registrations, and export lists (our additions don't conflict with upstream's).
2. **Adopt upstream's i18n `t()` calls** but change locale VALUES to "Orcha Agents" (don't keep hardcoded Orcha strings).
3. **Keep Orcha branding** (icon imports, app name, update behavior) when upstream adds generic features.
4. **Keep i18n key names unchanged** (e.g., `menu.aboutCraftAgents`) — only change values in locale JSON files.

## Step 2: Run Verification Script

After the rebase completes, run the automated verification:

```bash
bash scripts/verify-orcha-build.sh
```

This checks **28 items** across 6 categories:
1. **Branding** — No "Craft Agent(s)" in locales, correct HTML title, app name, Orcha icons
2. **Sentry** — Disabled in main, no imports in renderer, AppErrorBoundary present
3. **Package Versions** — Single @radix-ui/react-context, Sentry overrides, Tiptap pinned
4. **Build Resources** — SDK path, pi-agent-server, session-mcp-server, Bun download
5. **Workspace Setup** — pnpm-workspace.yaml, .npmrc, symlink
6. **Installed App** — All critical files present (after build)

Fix every ❌ before proceeding to Step 3.

### Manual Checks (Script Cannot Verify)

These require manual verification after build:

### 2.1 TypeScript Compilation

## Step 3: Build & Test

### 3.1 Full Clean Build
```bash
# Full clean install (needed after version changes)
rm -rf node_modules apps/electron/node_modules packages/*/node_modules apps/*/node_modules
pnpm install
node node_modules/electron/install.js

# Ensure workspace symlink
mkdir -p packages/ui/node_modules/@craft-agent
ln -sf ../../../shared packages/ui/node_modules/@craft-agent/shared

# Build production app
bun run electron:dist:mac
```

### 3.2 Install & Smoke Test
```bash
# Install to /Applications
rm -rf /Applications/Orcha\ Agents.app
cp -R apps/electron/release/mac-arm64/Orcha\ Agents.app /Applications/

# Launch with debug port
/Applications/Orcha\ Agents.app/Contents/MacOS/Orcha\ Agents --remote-debugging-port=9555 &
sleep 5

# Verify title
curl -s http://localhost:9555/json | python3 -c "import sys,json; p=json.load(sys.stdin); print(p[0]['title'])"
# Expected: "Orcha Agents"
```

### 3.3 Verify Built App Contents
```bash
APP="/Applications/Orcha Agents.app/Contents/Resources/app"

echo "=== Critical Files Check ==="
for f in \
  "$APP/node_modules/@anthropic-ai/claude-agent-sdk/cli.js" \
  "$APP/vendor/bun/bun" \
  "$APP/dist/resources/pi-agent-server/index.js" \
  "$APP/dist/resources/session-mcp-server/index.js" \
  "$APP/dist/main.cjs" \
  "$APP/dist/interceptor.cjs"; do
  if [ -f "$f" ]; then echo "✅ $(basename $(dirname $f))/$(basename $f)"
  else echo "❌ MISSING: $f"; fi
done
```

### 3.4 Functional Tests (Manual)
The user must verify these manually:
1. **Send a message** — should NOT show "Claude Code SDK not found"
2. **GLM 5.1 model** — should respond, not hang at "thinking"
3. **Ledger panel** — should show sync history
4. **Sidebar shows "Orcha"** branding
5. **Window title shows "Orcha Agents"**
6. **No Sentry errors in console** (filter for "sentry" in DevTools)

## Step 4: Commit & Push

```bash
git add -A
git commit -m "chore: upgrade to upstream vN.N.N

- Rebase fork commits onto upstream/main
- Resolve conflicts in: <list files>
- Update Orcha branding in i18n locales
- Fix build resource paths for SDK, pi-agent-server, bundled Bun
- Verify @radix-ui/react-context single-version constraint

Co-Authored-By: Craft Agent <agents-noreply@craft.do>"

git push origin main --force-with-lease

# Update feature branch
git branch -f feature/precompact-hooks main
git push origin feature/precompact-hooks --force
```

## Step 5: Update FORK.md

Update the metadata table:
```markdown
| **Zuletzt gemerged** | vN.N.N |
| **Upstream-Stand** | vN.N.N (aktuell) |
```

Add any new conflict candidates or lessons learned.

## Known Pitfalls Reference

| Symptom | Cause | Fix |
|---------|-------|-----|
| `MenuPortal must be used within Menu` | Duplicate `@radix-ui/react-context` versions | Pin via `pnpm.overrides` |
| `Claude Code SDK not found` | SDK not copied to app bundle | Fix `extraResources` from-path in `electron-builder.yml` |
| `piServerPath not configured` | pi-agent-server not in `dist/resources/` | `copy-assets.ts` must copy it |
| GLM model hangs at "thinking" | No Bundled Bun binary | Download Bun in `copy-assets.ts` |
| `Could not resolve @craft-agent/shared/utils/toolNames` | Missing workspace symlink | `ln -sf ../../../shared packages/ui/node_modules/@craft-agent/shared` |
| Sentry errors in console | Sentry enabled in fork | `Sentry.init({ enabled: false })` in main, removed from renderer |
| Orcha icons overwritten | Rebase replaced branding files | Restore from commit `842b759` |
| `pnpm-workspace.yaml` missing | Not tracked by git | Create manually with workspace packages |
| Window title says "Craft Agents" | `index.html` `<title>` not updated | Change to "Orcha Agents" |
| Dev mode exits immediately | `CRAFT_CONFIG_DIR` empty in `electron-dev.ts` env | Set `CRAFT_CONFIG_DIR=~/.orcha-agents` or run with env var |
| "Craft Agent" (singular) in UI | Only "Craft Agents" (plural) was replaced in first pass | Grep for both forms, replace all |
