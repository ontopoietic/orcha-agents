#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# verify-orcha-build.sh — Post-rebase verification for Orcha Agents
#
# Run: bash scripts/verify-orcha-build.sh
#
# This script checks that all known failure modes from previous
# upgrades are not present. Fix every ❌ before building.
# ═══════════════════════════════════════════════════════════════════

set -uo pipefail

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "ok" ]; then
    echo "  ✅ $label"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label"
    echo "     → $result"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "🔍 Orcha Agents — Post-Rebase Verification"
echo "════════════════════════════════════════════"
echo ""

# ─── 1. BRANDING ────────────────────────────────────────────────────
echo "📝 1. Branding"

# 1a. "Craft Agents" (plural) in i18n locales
COUNT=$(grep -rw "Craft Agents" packages/shared/src/i18n/locales/ --include='*.json' 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -eq 0 ]; then
  check 'No "Craft Agents" in i18n locales' "ok"
else
  check "No \"Craft Agents\" in i18n locales" "\"Craft Agents\" found in $COUNT locale entries"
fi

# 1b. "Craft Agent" (singular) in i18n locales
COUNT=$(grep -rw "Craft Agent" packages/shared/src/i18n/locales/ --include='*.json' 2>/dev/null | grep -v "Craft Agents" | wc -l | tr -d ' ')
if [ "$COUNT" -eq 0 ]; then
  check 'No "Craft Agent" (singular) in i18n locales' "ok"
else
  check "No \"Craft Agent\" (singular) in i18n locales" "\"Craft Agent\" found in $COUNT locale entries"
fi

# 1c. HTML title
TITLE=$(grep '<title>' apps/electron/src/renderer/index.html 2>/dev/null | sed 's/.*<title>//;s/<\/title>.*//' | xargs)
if [ "$TITLE" = "Orcha Agents" ]; then
  check "HTML title is \"Orcha Agents\"" "ok"
else
  check "HTML title is \"Orcha Agents\"" "Got: \"$TITLE\""
fi

# 1d. app.setName in main/index.ts
if grep -q "app.setName.*Orcha Agents" apps/electron/src/main/index.ts 2>/dev/null; then
  check "app.setName('Orcha Agents')" "ok"
else
  check "app.setName('Orcha Agents')" "Not found in apps/electron/src/main/index.ts"
fi

# 1e. Orcha icons exist
if [ -f "apps/electron/resources/icon.icns" ] && [ -f "apps/electron/resources/icon.png" ]; then
  check "Orcha icons present (icon.icns, icon.png)" "ok"
else
  check "Orcha icons present" "Missing — restore: git checkout 842b759 -- apps/electron/resources/icon.icns icon.png icon.ico icon.svg source.png"
fi

echo ""

# ─── 2. SENTRY ──────────────────────────────────────────────────────
echo "🛡️  2. Sentry Disabled"

# 2a. Main process: Sentry.init({ enabled: false })
if grep -q "Sentry.init({ enabled: false })" apps/electron/src/main/index.ts 2>/dev/null; then
  check "Sentry disabled in main process" "ok"
else
  check "Sentry disabled in main process" "Set Sentry.init({ enabled: false }) in apps/electron/src/main/index.ts"
fi

# 2b. Renderer: no Sentry imports
# Check for uncommented Sentry imports (line does NOT start with // or have a // Sentry comment on the previous line)
SENTRY_IMPORTS=$(grep -rn "^import.*from '@sentry\|^import.*from \"@sentry" apps/electron/src/renderer/ --include='*.tsx' --include='*.ts' 2>/dev/null | grep -v node_modules | grep -v '.test.' | wc -l | tr -d ' ')
if [ "$SENTRY_IMPORTS" -eq 0 ]; then
  check "No Sentry imports in renderer" "ok"
else
  check "No Sentry imports in renderer" "$SENTRY_IMPORTS Sentry imports found in renderer — remove them"
fi

# 2c. Renderer: AppErrorBoundary exists
if grep -q "class AppErrorBoundary" apps/electron/src/renderer/main.tsx 2>/dev/null; then
  check "AppErrorBoundary in renderer" "ok"
else
  check "AppErrorBoundary in renderer" "Custom ErrorBoundary class missing in main.tsx"
fi

echo ""

# ─── 3. PACKAGE VERSIONS ────────────────────────────────────────────
echo "📦 3. Package Versions"

# 3a. @radix-ui/react-context — single version
RADIX_VERSIONS=$(find node_modules/.pnpm -path '*radix-ui+react-context*/node_modules/@radix-ui/react-context/package.json' 2>/dev/null | while read f; do grep '"version"' "$f" | grep -v yarn | awk '{print $1}' | tr -d '"'; done | sort -u | wc -l | tr -d ' ')
if [ "$RADIX_VERSIONS" -le 1 ] 2>/dev/null; then
  check "@radix-ui/react-context single version" "ok"
else
  check "@radix-ui/react-context single version" "Multiple versions found — add to pnpm.overrides: \"@radix-ui/react-context\": \"1.1.2\""
fi

# 3b. @radix-ui/react-context override exists in package.json
if grep -q '"@radix-ui/react-context"' package.json 2>/dev/null; then
  check "@radix-ui/react-context override in package.json" "ok"
else
  check "@radix-ui/react-context override in package.json" "Add to pnpm.overrides: \"@radix-ui/react-context\": \"1.1.2\""
fi

# 3c. Sentry overrides present
if grep -q '"@sentry/core".*10.48.0' package.json 2>/dev/null; then
  check "Sentry overrides in package.json" "ok"
else
  check "Sentry overrides in package.json" "Add all @sentry/* overrides to pnpm.overrides"
fi

# 3d. Tiptap pinned
if grep -q '"@tiptap/react": "3.22' package.json 2>/dev/null || grep -q '"@tiptap/react": "3.22' apps/electron/package.json 2>/dev/null; then
  check "Tiptap pinned to 3.22.x" "ok"
else
  check "Tiptap pinned to 3.22.x" "Pin @tiptap/react to exact version (no ^) to avoid duplicate versions"
fi

echo ""

# ─── 4. BUILD RESOURCES ────────────────────────────────────────────
echo "🏗️  4. Build Resources"

# 4a. electron-builder.yml SDK path
if grep -q 'from: ../../node_modules/@anthropic-ai/claude-agent-sdk' apps/electron/electron-builder.yml 2>/dev/null; then
  check "SDK extraResources path (../../node_modules/...)" "ok"
else
  check "SDK extraResources path" "Fix in electron-builder.yml: from: ../../node_modules/@anthropic-ai/claude-agent-sdk"
fi

# 4b. copy-assets.ts copies pi-agent-server
if grep -q "pi-agent-server" apps/electron/scripts/copy-assets.ts 2>/dev/null; then
  check "copy-assets.ts includes pi-agent-server" "ok"
else
  check "copy-assets.ts includes pi-agent-server" "Add pi-agent-server copy to apps/electron/scripts/copy-assets.ts"
fi

# 4c. copy-assets.ts copies session-mcp-server
if grep -q "session-mcp-server" apps/electron/scripts/copy-assets.ts 2>/dev/null; then
  check "copy-assets.ts includes session-mcp-server" "ok"
else
  check "copy-assets.ts includes session-mcp-server" "Add session-mcp-server copy to apps/electron/scripts/copy-assets.ts"
fi

# 4d. copy-assets.ts downloads Bun
if grep -q "BUN_VERSION\|oven-sh/bun" apps/electron/scripts/copy-assets.ts 2>/dev/null; then
  check "copy-assets.ts includes Bun download" "ok"
else
  check "copy-assets.ts includes Bun download" "Add Bun binary download to apps/electron/scripts/copy-assets.ts"
fi

# 4e. pi-agent-server built
if [ -f "packages/pi-agent-server/dist/index.js" ]; then
  check "pi-agent-server/dist/index.js exists" "ok"
else
  check "pi-agent-server/dist/index.js exists" "Run: bun run electron:build:main to build it"
fi

# 4f. session-mcp-server built
if [ -f "packages/session-mcp-server/dist/index.js" ]; then
  check "session-mcp-server/dist/index.js exists" "ok"
else
  check "session-mcp-server/dist/index.js exists" "Run: bun run electron:build:main to build it"
fi

echo ""

# ─── 5. WORKSPACE SETUP ────────────────────────────────────────────
echo "⚙️  5. Workspace Setup"

# 5a. pnpm-workspace.yaml
if [ -f "pnpm-workspace.yaml" ]; then
  check "pnpm-workspace.yaml exists" "ok"
else
  check "pnpm-workspace.yaml exists" "Create it — not tracked by git"
fi

# 5b. .npmrc
if [ -f ".npmrc" ] && grep -q "shamefully-hoist" .npmrc 2>/dev/null; then
  check ".npmrc with shamefully-hoist" "ok"
else
  check ".npmrc with shamefully-hoist" "Create .npmrc with: shamefully-hoist=true, node-linker=hoisted"
fi

# 5c. packages/ui symlink to @craft-agent/shared
if [ -L "packages/ui/node_modules/@craft-agent/shared" ] || [ -d "packages/ui/node_modules/@craft-agent/shared" ]; then
  check "packages/ui → @craft-agent/shared symlink" "ok"
else
  check "packages/ui → @craft-agent/shared symlink" "Create: mkdir -p packages/ui/node_modules/@craft-agent && ln -sf ../../../shared packages/ui/node_modules/@craft-agent/shared"
fi

# 5d. CRAFT_CONFIG_DIR in main process banner
if grep -q "orcha-agents" apps/electron/src/main/index.ts 2>/dev/null && grep -q "CRAFT_CONFIG_DIR" apps/electron/scripts/../dist/main.cjs 2>/dev/null; then
  check "CRAFT_CONFIG_DIR points to .orcha-agents" "ok"
elif grep -q "orcha-agents" apps/electron/src/main/index.ts 2>/dev/null; then
  check "CRAFT_CONFIG_DIR points to .orcha-agents" "ok"
else
  check "CRAFT_CONFIG_DIR points to .orcha-agents" "Check esbuild banner in scripts/electron-build-main.ts sets .orcha-agents"
fi

echo ""

# ─── 6. POST-BUILD VERIFICATION (run after electron:dist:mac) ──────
APP="/Applications/Orcha Agents.app/Contents/Resources/app"
if [ -d "$APP" ]; then
  echo "🔎 6. Installed App Verification"
  
  for f in \
    "$APP/node_modules/@anthropic-ai/claude-agent-sdk/cli.js" \
    "$APP/vendor/bun/bun" \
    "$APP/dist/resources/pi-agent-server/index.js" \
    "$APP/dist/resources/session-mcp-server/index.js" \
    "$APP/dist/main.cjs" \
    "$APP/dist/interceptor.cjs"; do
    BASENAME=$(echo "$f" | sed "s|$APP/||")
    if [ -f "$f" ]; then
      check "$BASENAME" "ok"
    else
      check "$BASENAME" "MISSING from installed app"
    fi
  done
  echo ""
fi

# ─── RESULT ─────────────────────────────────────────────────────────
echo "════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo "✅ All $TOTAL checks passed"
else
  echo "❌ $FAIL of $TOTAL checks failed — fix before building"
  exit 1
fi
