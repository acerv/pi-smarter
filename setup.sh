#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing pi-smarter package..."
pi install "${SCRIPT_DIR}"

PACKAGES="
npm:pi-web-access
npm:pi-manage-todo-list
npm:pi-subagents
npm:pi-mcp-adapter
npm:@narumitw/pi-plan-mode
"

echo "Installing companion packages..."
for pkg in $PACKAGES; do
	echo "Installing $pkg..."
	pi install "$pkg"
done

echo "Setup complete!"
