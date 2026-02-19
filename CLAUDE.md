# CLAUDE.md

Instructions for AI coding agents working on this codebase.

## Project Structure

- `server/` - Node.js backend (Express + Socket.io)
- `client/` - React frontend (Vite + Tailwind CSS)
- `client/dist/` - Pre-built client (served by Express)
- `e2e/` - Playwright end-to-end tests
- `docs/` - API reference and research docs

## Commands

- `npm start` or `npm run server` - Start server (serves API + built client on :38007)
- `npm run dev` - Start dev mode (server :38007 + Vite HMR :38008)
- `npm run build` - Rebuild client
- `npm test` - Run Playwright e2e tests

## Architecture

- Single port (38007): Express serves both REST API and static client build
- Workers run in tmux sessions named `thea-worker-{id}`
- Real-time updates via Socket.io
- Worker hierarchy: GENERAL > COLONEL > IMPL/TEST/RESEARCH/FIX/REVIEW
- Ralph protocol: workers signal progress (in_progress/done/blocked) with completion %

## Key Files

- `server/index.js` - Express server, startup, graceful shutdown
- `server/workerManager.js` - Core worker lifecycle
- `server/routes.js` - REST API routes
- `server/socketHandler.js` - Socket.io event handlers
- `server/validation.js` - Shared validation constants
- `server/workers/ralph.js` - Ralph signal handling, auto-promotion
- `client/src/App.jsx` - Main React app with tab navigation
- `client/src/context/OrchestratorContext.jsx` - Global state + socket connection

## Development Guidelines

- **Shared environment**: This manages live workers. Check `GET /api/workers` before running commands that affect workers.
- **Worker protection**: Never kill workers without explicit permission. Workers represent compute time and may have uncommitted work.
- **Server restart**: Use `pkill -f "node server/index.js"` to restart. Never use `fuser -k` or `lsof | xargs kill` (kills browser connections).
- **Client changes**: Run `npm run build` after modifying client code, then restart server.
- **Validation**: All user input is validated via shared constants in `server/validation.js`.
- **Security model**: Designed for local/trusted-network use. Not intended for public internet exposure.
