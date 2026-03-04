#!/bin/bash

# Strategos startup script
# Runs on port 38007

cd "$(dirname "$0")/.."

# Check if client is built
if [ ! -d "client/dist" ]; then
    echo "Building client..."
    npm run build
fi

# Check if something is already running on 38007
if lsof -i:38007 -t >/dev/null 2>&1; then
    echo "Port 38007 is already in use. Strategos may already be running."
    echo "Run: lsof -i:38007 to see what's using it."
    exit 1
fi

echo "Starting Strategos on http://localhost:38007"
cd server && node index.js
