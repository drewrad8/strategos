#!/bin/bash
#
# Strategos Installation Script
#
# Interactive installer for Strategos - Multi-provider AI Orchestrator
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Defaults
DEFAULT_INSTALL_DIR="$HOME/.strategos"
DEFAULT_PROJECTS_DIR="$HOME/strategos-projects"
DEFAULT_PORT=38007

# Installation variables
INSTALL_DIR=""
PROJECTS_DIR=""
PORT=""
INSTALL_SERVICE=false

echo -e "${BOLD}${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                     Strategos Installer                       ║"
echo "║            Multi-provider AI Orchestrator                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ============================================
# PREFLIGHT CHECKS
# ============================================

echo -e "${CYAN}Checking prerequisites...${NC}"

# Check OS
OS="$(uname -s)"
case "$OS" in
    Linux*)     OS_TYPE="Linux";;
    Darwin*)    OS_TYPE="macOS";;
    *)          echo -e "${RED}Unsupported OS: $OS${NC}"; exit 1;;
esac
echo -e "  ${GREEN}✓${NC} Operating System: $OS_TYPE"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "  ${RED}✗${NC} Node.js not found"
    echo ""
    echo -e "${YELLOW}Node.js 18+ is required. Install from:${NC}"
    echo "  https://nodejs.org/"
    echo "  or via nvm: https://github.com/nvm-sh/nvm"
    exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "  ${RED}✗${NC} Node.js version $(node --version) is too old"
    echo -e "${YELLOW}Node.js 18+ is required${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node --version)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "  ${RED}✗${NC} npm not found"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} npm $(npm --version)"

# Check tmux
if ! command -v tmux &> /dev/null; then
    echo -e "  ${YELLOW}!${NC} tmux not found"
    echo ""

    read -p "tmux is required. Install it now? [Y/n] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        if [ "$OS_TYPE" = "Linux" ]; then
            if command -v apt-get &> /dev/null; then
                sudo apt-get update && sudo apt-get install -y tmux
            elif command -v yum &> /dev/null; then
                sudo yum install -y tmux
            elif command -v dnf &> /dev/null; then
                sudo dnf install -y tmux
            elif command -v pacman &> /dev/null; then
                sudo pacman -S --noconfirm tmux
            else
                echo -e "${RED}Could not detect package manager. Please install tmux manually.${NC}"
                exit 1
            fi
        elif [ "$OS_TYPE" = "macOS" ]; then
            if command -v brew &> /dev/null; then
                brew install tmux
            else
                echo -e "${RED}Homebrew not found. Please install tmux manually:${NC}"
                echo "  brew install tmux"
                exit 1
            fi
        fi
    else
        echo -e "${RED}tmux is required for worker management. Exiting.${NC}"
        exit 1
    fi
fi
echo -e "  ${GREEN}✓${NC} tmux $(tmux -V | cut -d' ' -f2)"

# Check Claude Code (optional but recommended)
if command -v claude &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Claude Code CLI found"
    HAS_CLAUDE=true
else
    echo -e "  ${YELLOW}!${NC} Claude Code CLI not found (optional)"
    echo -e "    Install from: ${CYAN}https://github.com/anthropics/claude-code${NC}"
    HAS_CLAUDE=false
fi

# Check port availability
if command -v lsof &> /dev/null; then
    if lsof -i:$DEFAULT_PORT &> /dev/null; then
        echo -e "  ${YELLOW}!${NC} Port $DEFAULT_PORT is in use"
    else
        echo -e "  ${GREEN}✓${NC} Port $DEFAULT_PORT is available"
    fi
fi

echo ""

# ============================================
# CONFIGURATION PROMPTS
# ============================================

echo -e "${CYAN}Configuration${NC}"
echo ""

# Installation directory
echo -e "${BOLD}Installation directory${NC}"
echo -e "  This is where Strategos code and data will be stored."
read -p "  [$DEFAULT_INSTALL_DIR]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"

# Expand ~
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"
echo ""

# Projects directory
echo -e "${BOLD}Projects directory${NC}"
echo -e "  This is where your AI workers will work on projects."
read -p "  [$DEFAULT_PROJECTS_DIR]: " PROJECTS_DIR
PROJECTS_DIR="${PROJECTS_DIR:-$DEFAULT_PROJECTS_DIR}"
PROJECTS_DIR="${PROJECTS_DIR/#\~/$HOME}"
echo ""

# Port
echo -e "${BOLD}Server port${NC}"
read -p "  [$DEFAULT_PORT]: " PORT
PORT="${PORT:-$DEFAULT_PORT}"
echo ""

# ============================================
# PROVIDER CONFIGURATION
# ============================================

echo -e "${CYAN}Provider Configuration${NC}"
echo ""

# Check for existing API keys in environment
OPENAI_KEY="${OPENAI_API_KEY:-}"
GEMINI_KEY="${GEMINI_API_KEY:-}"
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"

# OpenAI
echo -e "${BOLD}OpenAI API Key${NC} (for OpenAI workers and API calls)"
if [ -n "$OPENAI_KEY" ]; then
    echo -e "  Found in environment: ${GREEN}sk-...${OPENAI_KEY: -4}${NC}"
    read -p "  Use this key? [Y/n]: " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        read -p "  Enter new key (or leave blank to skip): " OPENAI_KEY
    fi
else
    read -p "  Enter key (or leave blank to skip): " OPENAI_KEY
fi
echo ""

# Gemini
echo -e "${BOLD}Google Gemini API Key${NC} (for Gemini workers and API calls)"
if [ -n "$GEMINI_KEY" ]; then
    echo -e "  Found in environment: ${GREEN}AIza...${GEMINI_KEY: -4}${NC}"
    read -p "  Use this key? [Y/n]: " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        read -p "  Enter new key (or leave blank to skip): " GEMINI_KEY
    fi
else
    read -p "  Enter key (or leave blank to skip): " GEMINI_KEY
fi
echo ""

# Anthropic (optional - Claude CLI doesn't need it)
echo -e "${BOLD}Anthropic API Key${NC} (optional - for direct API calls)"
if [ -n "$ANTHROPIC_KEY" ]; then
    echo -e "  Found in environment: ${GREEN}sk-ant-...${ANTHROPIC_KEY: -4}${NC}"
    read -p "  Use this key? [Y/n]: " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        read -p "  Enter new key (or leave blank to skip): " ANTHROPIC_KEY
    fi
else
    read -p "  Enter key (or leave blank to skip): " ANTHROPIC_KEY
fi
echo ""

# ============================================
# SUMMARY PROVIDER (OLLAMA)
# ============================================

echo -e "${CYAN}Summary Provider${NC}"
echo ""
echo "Strategos can use a local LLM (via Ollama) for summaries and quick"
echo "analysis. This is optional but recommended for a better experience."
echo ""

ENABLE_SUMMARIES=false
OLLAMA_URL="http://localhost:11434"
SUMMARY_MODEL="qwen3:8b"

if command -v ollama &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Ollama found"

    read -p "  Enable Ollama summaries? [Y/n]: " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        ENABLE_SUMMARIES=true
        read -p "  Ollama URL [$OLLAMA_URL]: " tmp
        OLLAMA_URL="${tmp:-$OLLAMA_URL}"
        read -p "  Summary model [$SUMMARY_MODEL]: " tmp
        SUMMARY_MODEL="${tmp:-$SUMMARY_MODEL}"
    fi
else
    echo -e "  ${YELLOW}!${NC} Ollama not found"
    echo "    Install from: https://ollama.ai"
    echo "    Summaries will be disabled."
fi
echo ""

# ============================================
# SERVICE INSTALLATION
# ============================================

echo -e "${CYAN}System Service${NC}"
echo ""
echo "Install as a system service to auto-start on boot?"

if [ "$OS_TYPE" = "Linux" ]; then
    echo "(Will create a systemd user service)"
elif [ "$OS_TYPE" = "macOS" ]; then
    echo "(Will create a launchd plist)"
fi

read -p "  Install service? [y/N]: " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    INSTALL_SERVICE=true
fi
echo ""

# ============================================
# CONFIRMATION
# ============================================

echo -e "${CYAN}Installation Summary${NC}"
echo "===================="
echo ""
echo "  Install directory:  $INSTALL_DIR"
echo "  Projects directory: $PROJECTS_DIR"
echo "  Port:               $PORT"
echo ""
echo "  Providers:"
[ -n "$OPENAI_KEY" ] && echo "    - OpenAI: Configured"
[ -n "$GEMINI_KEY" ] && echo "    - Gemini: Configured"
[ -n "$ANTHROPIC_KEY" ] && echo "    - Anthropic: Configured"
[ "$HAS_CLAUDE" = true ] && echo "    - Claude Code: Available"
echo ""
echo "  Summaries: $([ "$ENABLE_SUMMARIES" = true ] && echo "Enabled ($SUMMARY_MODEL)" || echo "Disabled")"
echo "  Service:   $([ "$INSTALL_SERVICE" = true ] && echo "Yes" || echo "No")"
echo ""

read -p "Proceed with installation? [Y/n]: " -n 1 -r
echo
if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo "Installation cancelled."
    exit 0
fi

# ============================================
# INSTALLATION
# ============================================

echo ""
echo -e "${CYAN}Installing Strategos...${NC}"
echo ""

# Create directories
echo -e "  Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/config"
mkdir -p "$INSTALL_DIR/data/logs"
mkdir -p "$PROJECTS_DIR"

# Copy files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo -e "  Copying files..."
cp -r "$SCRIPT_DIR/server" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/bin" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/client" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"

# Install dependencies
echo -e "  Installing Node.js dependencies..."
cd "$INSTALL_DIR"
npm install --production 2>&1 | grep -E "(added|removed|audited)" || true

# Create config file
echo -e "  Creating configuration..."
cat > "$INSTALL_DIR/config/strategos.json" << EOF
{
  "version": "1.0.0",
  "port": $PORT,
  "projectsRoot": "$PROJECTS_DIR",
  "dataDir": "$INSTALL_DIR/data",

  "providers": {
    "workers": {
      "default": "claude",
      "available": ["claude"$([ -n "$OPENAI_KEY" ] && echo ', "openai"')$([ -n "$GEMINI_KEY" ] && echo ', "gemini"')],
      "openai": { "model": "gpt-4o" },
      "gemini": { "model": "gemini-2.0-flash" }
    },
    "api": {
      "default": "$([ "$ENABLE_SUMMARIES" = true ] && echo "ollama" || echo "none")",
      "ollama": {
        "url": "$OLLAMA_URL",
        "model": "$SUMMARY_MODEL"
      },
      "openai": { "model": "gpt-4o-mini" },
      "gemini": { "model": "gemini-1.5-flash" }
    }
  },

  "features": {
    "summaries": $ENABLE_SUMMARIES
  }
}
EOF

# Create .env file for secrets
echo -e "  Creating secrets file..."
cat > "$INSTALL_DIR/.env" << EOF
# Strategos API Keys
# Keep this file secure - do not commit to version control

$([ -n "$OPENAI_KEY" ] && echo "OPENAI_API_KEY=$OPENAI_KEY")
$([ -n "$GEMINI_KEY" ] && echo "GEMINI_API_KEY=$GEMINI_KEY")
$([ -n "$ANTHROPIC_KEY" ] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_KEY")
EOF
chmod 600 "$INSTALL_DIR/.env"

# Install service if requested
if [ "$INSTALL_SERVICE" = true ]; then
    echo -e "  Installing system service..."

    if [ "$OS_TYPE" = "Linux" ]; then
        # systemd user service
        mkdir -p "$HOME/.config/systemd/user"
        cat > "$HOME/.config/systemd/user/strategos.service" << EOF
[Unit]
Description=Strategos AI Orchestrator
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=STRATEGOS_CONFIG=$INSTALL_DIR/config/strategos.json

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable strategos.service
        echo -e "    ${GREEN}✓${NC} Systemd service installed"
        echo "    Start with: systemctl --user start strategos"

    elif [ "$OS_TYPE" = "macOS" ]; then
        # launchd plist
        mkdir -p "$HOME/Library/LaunchAgents"
        cat > "$HOME/Library/LaunchAgents/com.strategos.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.strategos</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>$INSTALL_DIR/server/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>STRATEGOS_CONFIG</key>
        <string>$INSTALL_DIR/config/strategos.json</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/data/logs/strategos.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/data/logs/strategos.log</string>
</dict>
</plist>
EOF
        launchctl load "$HOME/Library/LaunchAgents/com.strategos.plist"
        echo -e "    ${GREEN}✓${NC} LaunchAgent installed"
        echo "    Start with: launchctl start com.strategos"
    fi
fi

# Add to PATH suggestion
echo ""
echo -e "${CYAN}Add to PATH${NC}"
echo ""
echo "To use the 'strategos' and 'strategos-worker' commands from anywhere,"
echo "add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
echo ""
echo -e "  ${BOLD}export PATH=\"\$PATH:$INSTALL_DIR/bin\"${NC}"
echo ""

# ============================================
# COMPLETION
# ============================================

echo -e "${GREEN}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                Installation Complete!                         ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo "Next steps:"
echo ""
echo "  1. Add Strategos to your PATH (see above)"
echo ""
echo "  2. Start the server:"
if [ "$INSTALL_SERVICE" = true ]; then
    if [ "$OS_TYPE" = "Linux" ]; then
        echo "     systemctl --user start strategos"
    else
        echo "     launchctl start com.strategos"
    fi
else
    echo "     $INSTALL_DIR/bin/strategos start"
fi
echo ""
echo "  3. Open the web UI:"
echo "     http://localhost:$PORT"
echo ""
echo "  4. Or use the CLI:"
echo "     strategos-worker list"
echo "     strategos-worker spawn ~/my-project \"IMPL: My Task\""
echo ""
echo "Documentation: https://github.com/YOUR_USERNAME/strategos"
echo ""
