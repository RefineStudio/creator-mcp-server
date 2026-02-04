# Creator MCP Server

MCP server that connects Stilla to FigJam Creator plugin for real-time diagram creation.

## Architecture

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Stilla    │────▶│  Creator MCP Server  │────▶│   WebSocket     │
│  (MCP CLI)  │     │                      │     │   Bridge        │
└─────────────┘     │  Tools:              │     └────────┬────────┘
                    │  • create_flowchart  │              │
                    │  • create_mindmap    │              ▼
                    │  • create_diagram    │     ┌─────────────────┐
                    │  • check_status      │     │  FigJam Plugin  │
                    └──────────────────────┘     │  (auto-executes)│
                                                 └─────────────────┘
```

## Setup

### 1. Deploy the MCP Server

```bash
cd creator-mcp-server
npm install
npm start
```

Or deploy to Render:
- Connect this repo to Render
- It will auto-deploy using `render.yaml`

### 2. Add to Stilla

In Stilla app → Settings → Connections → Add Custom MCP Server:

- **Server Name:** Creator
- **Server URL:** `https://creator-mcp-server.onrender.com/mcp`
- **Description:** Create diagrams and flowcharts in FigJam

### 3. Use in FigJam

1. Open FigJam board
2. Run the Creator plugin
3. Note the **session code** (top right, e.g., `ABC123`)
4. Tell Stilla: "Connect to FigJam session ABC123"

## MCP Tools

### `create_flowchart`
Create a flowchart with steps and decisions.

**Parameters:**
- `session_code` (required): The 6-character session code from FigJam
- `title`: Title for the flowchart
- `description`: Detailed description of the flow
- `steps`: Array of `{text, type}` objects (type: "process" | "decision")

### `create_mindmap`
Create a mind map with central topic and branches.

**Parameters:**
- `session_code` (required)
- `central_topic`: The main topic
- `branches`: Array of branch labels (max 6)

### `create_diagram`
Create a custom diagram with full control.

**Parameters:**
- `session_code` (required)
- `title`: Section title
- `shapes`: Array of shape objects
- `connections`: Array of connection objects

### `check_figjam_status`
Check if a FigJam session is connected.

**Parameters:**
- `session_code`: The session code to check

## Local Development

```bash
npm run dev  # Runs with --watch for auto-reload
```

Test endpoints:
- Health: `GET /health`
- Create session: `POST /session`
- MCP: `POST /mcp`
- WebSocket: `ws://localhost:3001/ws`

## Environment Variables

- `PORT` - Server port (default: 3001)
