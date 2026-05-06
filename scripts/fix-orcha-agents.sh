#!/bin/bash
# fix-orcha-agents.sh — nach jedem Build ausführen um Orcha Agents zu reparieren
set -e

APP="/Applications/Orcha Agents.app"
FORK="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Killing Orcha Agents..."
pkill -f "Orcha Agents" 2>/dev/null || true
rm -f /tmp/craft-agents-fork.lock
sleep 1

# 1. MacOS-Struktur: Wrapper-Script + Binary
MACOS="$APP/Contents/MacOS"
BINARY="$MACOS/Orcha Agents Bin"

# Falls Binary fehlt oder ist ein Script → Electron aus node_modules kopieren
if [ ! -f "$BINARY" ] || file "$BINARY" | grep -q "script"; then
  echo "→ Copying Electron binary..."
  cp "$FORK/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$BINARY"
  chmod +x "$BINARY"
fi

# Wrapper-Script schreiben (immer, um sicherzustellen dass es korrekt ist)
echo "→ Writing wrapper script..."
cat > "$MACOS/Orcha Agents" << 'EOF'
#!/bin/bash
export CRAFT_RPC_PORT=9203
export CRAFT_SERVER_LOCK_FILE="/tmp/craft-agents-fork.lock"
export CRAFT_BUN="$HOME/.bun/bin/bun"
rm -f "/tmp/craft-agents-fork.lock"
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/Orcha Agents Bin" --user-data-dir="/tmp/craft-agents-fork-v2" "$@"
EOF
chmod +x "$MACOS/Orcha Agents"

# 2. Resources/app — Abhängigkeiten
RESOURCES="$APP/Contents/Resources/app"

echo "→ Copying Claude Agent SDK..."
mkdir -p "$RESOURCES/node_modules/@anthropic-ai"
cp -r "$FORK/node_modules/@anthropic-ai/claude-agent-sdk" "$RESOURCES/node_modules/@anthropic-ai/"

echo "→ Copying shared packages..."
mkdir -p "$RESOURCES/packages/shared/src"
cp "$FORK/packages/shared/src/"*.ts "$RESOURCES/packages/shared/src/"

echo "→ Copying pi-agent-server..."
mkdir -p "$RESOURCES/resources/pi-agent-server"
if [ -d "/Applications/Craft Agents.app/Contents/Resources/app/resources/pi-agent-server" ]; then
  cp -r "/Applications/Craft Agents.app/Contents/Resources/app/resources/pi-agent-server/" "$RESOURCES/resources/pi-agent-server/"
else
  echo "  WARNING: Craft Agents nicht installiert, pi-agent-server nicht gefunden!"
fi

echo "→ Copying vendor/bun..."
mkdir -p "$RESOURCES/vendor"
if [ -d "/Applications/Craft Agents.app/Contents/Resources/app/vendor/bun" ]; then
  cp -r "/Applications/Craft Agents.app/Contents/Resources/app/vendor/bun" "$RESOURCES/vendor/"
else
  echo "  WARNING: Craft Agents nicht installiert, bun nicht gefunden!"
fi

# 3. Code-Signatur
echo "→ Re-signing..."
codesign --force --deep --sign - "$APP" 2>&1

echo "→ Launching Orcha Agents..."
open "$APP"

echo "✓ Done"
