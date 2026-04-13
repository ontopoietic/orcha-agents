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

## Step 2: Post-Rebase Verification Checklist

After the rebase completes, run through these checks IN ORDER. Each item was a real failure discovered in previous upgrades:

### 2.1 TypeScript Compilation
```bash
cd packages/shared && bun run tsc --noEmit
```
Fix any TS errors. Common issues:
- New exports missing from `package.json` exports map
- Type mismatches from API changes

### 2.2 Orcha Branding Audit
```bash
# Check for any remaining "Craft Agents" in user-facing strings
grep -rn "Craft Agents" packages/shared/src/i18n/locales/ apps/electron/src/renderer/ --include='*.json' --include='*.tsx' --include='*.ts' | grep -v node_modules | grep -v '.test.'
```
Replace all with "Orcha Agents". Also check:
- `apps/electron/src/renderer/index.html` — `<title>` tag
- `apps/electron/src/main/index.ts` — `app.setName()`
- `apps/electron/src/main/menu.ts` — menu labels

### 2.3 Sentry — Disable for Fork
The Orcha fork does NOT report errors to upstream Sentry. Verify:

**Main process** (`apps/electron/src/main/index.ts`):
- `Sentry.init({ enabled: false })` — must be set
- All `Sentry.captureException()` / `Sentry.setTag()` calls become no-ops

**Renderer process** (`apps/electron/src/renderer/main.tsx`):
- NO Sentry imports at all (removed entirely)
- Custom `AppErrorBoundary` class component wraps the app
- `CrashFallback` shows actual error + stack for debugging

### 2.4 Package Version Alignment
Check for duplicate versions of critical packages:

```bash
# Check for duplicate @radix-ui/react-context (caused MenuPortal crash in v0.8.6)
find node_modules/.pnpm -path '*radix-ui+react-context*/node_modules/@radix-ui/react-context/package.json' -exec grep '"version"' {} \; | grep -v yarn | sort | uniq -c
```

If multiple versions exist, add to `pnpm.overrides` in root `package.json`:
```json
"@radix-ui/react-context": "1.1.2"
```

Also verify Sentry alignment:
```json
"@sentry/core": "10.48.0",
"@sentry/react": "10.48.0",
"@sentry/node": "10.48.0",
"@sentry/electron": "7.11.0",
"@sentry/utils": "10.48.0"
```

### 2.5 Build Resources — Critical Path
The following resources must be present in the built app. Each was a missing-file crash:

**pi-agent-server** (Pi SDK sessions — GLM models, etc.):
```bash
ls packages/pi-agent-server/dist/index.js  # Must exist after build:main
```
Copied by `copy-assets.ts` → `dist/resources/pi-agent-server/index.js`

**session-mcp-server** (SubmitPlan, config_validate, etc.):
```bash
ls packages/session-mcp-server/dist/index.js  # Must exist after build:main
```
Copied by `copy-assets.ts` → `dist/resources/session-mcp-server/index.js`

**Bundled Bun** (Pi Agent Server needs Bun to run):
- `copy-assets.ts` downloads it automatically to `vendor/bun/bun`
- Verify `apps/electron/vendor/bun/bun` exists after build

**Claude Code SDK** (`@anthropic-ai/claude-agent-sdk`):
- Lives in root `node_modules/`, NOT `apps/electron/node_modules/`
- `electron-builder.yml` uses `extraResources` with path `../../node_modules/@anthropic-ai/claude-agent-sdk`
- If the `from:` path is wrong, SDK won't be included → "Claude Code SDK not found" error

**Orcha Icons** (rebase may overwrite them):
```bash
# Restore from branding commit if overwritten
git checkout 842b759 -- apps/electron/resources/icon.icns apps/electron/resources/icon.png apps/electron/resources/icon.ico apps/electron/resources/icon.svg apps/electron/resources/source.png
```

### 2.6 Workspace Symlink Fix
After `rm -rf node_modules`, `packages/ui` loses its symlink to `@craft-agent/shared`:

```bash
mkdir -p packages/ui/node_modules/@craft-agent
ln -sf ../../../shared packages/ui/node_modules/@craft-agent/shared
```

Without this, Vite/Rollup fails with `Could not resolve "@craft-agent/shared/utils/toolNames"`.

Also verify `pnpm-workspace.yaml` exists (not tracked by git):
```yaml
packages:
  - "packages/*"
  - "apps/*"
  - "!apps/online-docs"
```

And `.npmrc`:
```
shamefully-hoist=true
node-linker=hoisted
public-hoist-pattern[]=*
```

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
