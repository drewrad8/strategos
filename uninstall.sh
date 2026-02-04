#!/bin/bash
#
# Strategos Uninstaller
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

DEFAULT_INSTALL_DIR="$HOME/.strategos"

echo -e "${BLUE}Strategos Uninstaller${NC}"
echo ""

# Determine installation directory
read -p "Installation directory [$DEFAULT_INSTALL_DIR]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}Strategos not found at $INSTALL_DIR${NC}"
    exit 0
fi

echo ""
echo "This will remove:"
echo "  - $INSTALL_DIR (installation files)"
echo "  - System service (if installed)"
echo ""
echo -e "${YELLOW}Warning: This will NOT remove your projects directory.${NC}"
echo ""

read -p "Are you sure you want to uninstall Strategos? [y/N]: " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Uninstall cancelled."
    exit 0
fi

echo ""
echo -e "${BLUE}Uninstalling...${NC}"

# Stop service if running
OS="$(uname -s)"
case "$OS" in
    Linux*)
        if [ -f "$HOME/.config/systemd/user/strategos.service" ]; then
            echo "  Stopping and removing systemd service..."
            systemctl --user stop strategos.service 2>/dev/null || true
            systemctl --user disable strategos.service 2>/dev/null || true
            rm -f "$HOME/.config/systemd/user/strategos.service"
            systemctl --user daemon-reload
        fi
        ;;
    Darwin*)
        if [ -f "$HOME/Library/LaunchAgents/com.strategos.plist" ]; then
            echo "  Stopping and removing launchd service..."
            launchctl unload "$HOME/Library/LaunchAgents/com.strategos.plist" 2>/dev/null || true
            rm -f "$HOME/Library/LaunchAgents/com.strategos.plist"
        fi
        ;;
esac

# Stop any running server
PID_FILE="$INSTALL_DIR/data/strategos.pid"
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "  Stopping Strategos server..."
        kill "$PID" 2>/dev/null || true
        sleep 2
    fi
fi

# Remove installation directory
echo "  Removing installation files..."
rm -rf "$INSTALL_DIR"

echo ""
echo -e "${GREEN}Strategos has been uninstalled.${NC}"
echo ""
echo "Note: Your projects directory was not removed."
echo "If you want to remove PATH modifications, edit your shell profile."
