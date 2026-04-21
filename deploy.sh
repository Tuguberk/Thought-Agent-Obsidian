#!/usr/bin/env bash
set -e

PLUGIN_DIR="$HOME/Documents/Obsidian Vault/.obsidian/plugins/obsidian-ai-agent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Build ---
echo "Building..."
node "$SCRIPT_DIR/esbuild.config.mjs" production
echo "Build done."

# --- Symlink plugin directory ---
if [ -L "$PLUGIN_DIR" ]; then
  echo "Symlink already exists: $PLUGIN_DIR"
elif [ -d "$PLUGIN_DIR" ]; then
  echo "Found existing plugin folder — replacing with symlink..."
  rm -rf "$PLUGIN_DIR"
  ln -s "$SCRIPT_DIR" "$PLUGIN_DIR"
  echo "Symlinked: $PLUGIN_DIR -> $SCRIPT_DIR"
else
  mkdir -p "$(dirname "$PLUGIN_DIR")"
  ln -s "$SCRIPT_DIR" "$PLUGIN_DIR"
  echo "Symlinked: $PLUGIN_DIR -> $SCRIPT_DIR"
fi

echo ""
echo "Done. Enable the plugin in Obsidian: Settings → Community plugins → AI Agent"
