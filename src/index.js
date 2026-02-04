import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import cors from 'cors';
import { randomUUID } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================================
// FigJam Session Management
// ============================================================================

const sessions = new Map(); // sessionCode -> { ws, createdAt, lastPing }
const pendingCommands = new Map(); // sessionCode -> [commands]
const sessionContext = new Map(); // sessionCode -> { transcript, client, project, etc. }

// MCP Transport sessions (per-client)
const transports = {};

function generateSessionCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanupSessions() {
  const now = Date.now();
  const timeout = 5 * 60 * 1000;
  
  for (const [code, session] of sessions.entries()) {
    if (now - session.lastPing > timeout) {
      console.log(`[Session] Cleaning up stale session: ${code}`);
      if (session.ws) session.ws.close();
      sessions.delete(code);
      pendingCommands.delete(code);
      sessionContext.delete(code);
    }
  }
}

setInterval(cleanupSessions, 60 * 1000);

// ============================================================================
// Diagram Generation
// ============================================================================

function generateFlowchart(description, nodes = []) {
  const baseFlow = {
    sections: [{ name: description.substring(0, 50), x: 0, y: 0, width: 800, height: 600 }],
    shapes: [{ id: 'start', x: 300, y: 30, type: 'ellipse', width: 120, height: 50, text: 'Start', fill: 'lightGreen', stroke: 'green' }],
    connections: []
  };
  
  if (nodes.length > 0) {
    let y = 120;
    let prevId = 'start';
    
    nodes.forEach((node, i) => {
      const id = `step_${i}`;
      const isDecision = node.type === 'decision';
      
      baseFlow.shapes.push({
        id, x: isDecision ? 275 : 250, y,
        type: isDecision ? 'diamond' : 'rectangle',
        width: isDecision ? 170 : 200,
        height: isDecision ? 90 : 60,
        text: node.text || node.label || `Step ${i + 1}`,
        fill: isDecision ? 'lightOrange' : 'lightBlue',
        stroke: isDecision ? 'orange' : 'blue'
      });
      
      baseFlow.connections.push({ from: prevId, to: id, fromMagnet: 'BOTTOM', toMagnet: 'TOP' });
      prevId = id;
      y += isDecision ? 130 : 100;
    });
    
    baseFlow.shapes.push({ id: 'end', x: 300, y, type: 'ellipse', width: 120, height: 50, text: 'End', fill: 'lightPurple', stroke: 'purple' });
    baseFlow.connections.push({ from: prevId, to: 'end', fromMagnet: 'BOTTOM', toMagnet: 'TOP' });
    baseFlow.sections[0].height = y + 100;
  }
  
  return baseFlow;
}

function generateMindmap(centralTopic, branches = []) {
  const mindmap = {
    sections: [{ name: centralTopic, x: 0, y: 0, width: 800, height: 500 }],
    shapes: [{ id: 'center', x: 320, y: 200, type: 'ellipse', width: 160, height: 80, text: centralTopic, fill: 'blue', stroke: 'blue', textFill: 'white' }],
    connections: []
  };
  
  const positions = [{ x: 80, y: 50 }, { x: 560, y: 50 }, { x: 80, y: 380 }, { x: 560, y: 380 }, { x: 80, y: 215 }, { x: 560, y: 215 }];
  const colors = [{ fill: 'lightGreen', stroke: 'green' }, { fill: 'lightOrange', stroke: 'orange' }, { fill: 'lightPurple', stroke: 'purple' }, { fill: 'lightBlue', stroke: 'blue' }, { fill: 'lightGray', stroke: 'gray' }];
  
  branches.forEach((branch, i) => {
    if (i >= positions.length) return;
    const pos = positions[i];
    const color = colors[i % colors.length];
    const id = `branch_${i}`;
    mindmap.shapes.push({ id, x: pos.x, y: pos.y, width: 140, height: 50, text: branch, ...color });
    mindmap.connections.push({ from: 'center', to: id });
  });
  
  return mindmap;
}

function sendToPlugin(sessionCode, command) {
  const session = sessions.get(sessionCode);
  if (session && session.ws && session.ws.readyState === 1) {
    session.ws.send(JSON.stringify(command));
    console.log(`[Bridge] Sent command to session ${sessionCode}:`, command.type);
    return true;
  } else {
    if (!pendingCommands.has(sessionCode)) pendingCommands.set(sessionCode, []);
    pendingCommands.get(sessionCode).push(command);
    console.log(`[Bridge] Queued command for session ${sessionCode}`);
    return false;
  }
}

// ============================================================================
// Singleton MCP Server - All tools defined here
// ============================================================================

function createMcpServer() {
  const mcpServer = new McpServer({
    name: 'creator',
    version: '1.3.0',
    description: 'Create diagrams and flowcharts in FigJam with Stilla context'
  });

  mcpServer.tool(
    'create_flowchart',
    'Create a flowchart diagram in FigJam.',
    {
      session_code: { type: 'string', description: 'The session code from the FigJam Creator plugin (6 characters)' },
      title: { type: 'string', description: 'Title for the flowchart' },
      description: { type: 'string', description: 'Description of the flow to create.' },
      steps: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, type: { type: 'string', enum: ['process', 'decision'] } } }, description: 'Optional: explicit list of steps' }
    },
    async ({ session_code, title, description, steps }) => {
      const sessionCode = session_code?.toUpperCase();
      if (!sessionCode || !sessions.has(sessionCode)) {
        return { content: [{ type: 'text', text: `❌ Session "${sessionCode || 'none'}" not found. Ask the user to open the FigJam Creator plugin and share their session code.` }] };
      }
      const diagram = generateFlowchart(title || description, steps || []);
      diagram.sections[0].name = title || 'Flowchart';
      const sent = sendToPlugin(sessionCode, { type: 'create-diagram', data: diagram, source: 'stilla', description });
      return { content: [{ type: 'text', text: sent ? `✅ Flowchart "${title}" sent to FigJam!` : `⏳ Flowchart "${title}" queued.` }] };
    }
  );

  mcpServer.tool(
    'create_mindmap',
    'Create a mind map diagram in FigJam.',
    {
      session_code: { type: 'string', description: 'The session code from the FigJam Creator plugin' },
      central_topic: { type: 'string', description: 'The main topic in the center' },
      branches: { type: 'array', items: { type: 'string' }, description: 'List of branch topics (up to 6)' }
    },
    async ({ session_code, central_topic, branches }) => {
      const sessionCode = session_code?.toUpperCase();
      if (!sessionCode || !sessions.has(sessionCode)) {
        return { content: [{ type: 'text', text: `❌ Session "${sessionCode || 'none'}" not found.` }] };
      }
      const diagram = generateMindmap(central_topic, branches || []);
      const sent = sendToPlugin(sessionCode, { type: 'create-diagram', data: diagram, source: 'stilla' });
      return { content: [{ type: 'text', text: sent ? `✅ Mind map "${central_topic}" sent to FigJam!` : `⏳ Mind map queued.` }] };
    }
  );

  mcpServer.tool(
    'create_diagram',
    'Create a custom diagram in FigJam.',
    {
      session_code: { type: 'string', description: 'The session code from the FigJam Creator plugin' },
      title: { type: 'string', description: 'Title for the diagram section' },
      shapes: { type: 'array', description: 'Array of shape objects' },
      connections: { type: 'array', description: 'Array of connection objects' }
    },
    async ({ session_code, title, shapes, connections }) => {
      const sessionCode = session_code?.toUpperCase();
      if (!sessionCode || !sessions.has(sessionCode)) {
        return { content: [{ type: 'text', text: `❌ Session not found.` }] };
      }
      const diagram = { sections: [{ name: title || 'Diagram', x: 0, y: 0, width: 800, height: 600 }], shapes: shapes || [], connections: connections || [] };
      const sent = sendToPlugin(sessionCode, { type: 'create-diagram', data: diagram, source: 'stilla' });
      return { content: [{ type: 'text', text: sent ? `✅ Diagram created!` : `⏳ Diagram queued.` }] };
    }
  );

  mcpServer.tool(
    'check_figjam_status',
    'Check if a FigJam Creator plugin session is connected.',
    { session_code: { type: 'string', description: 'The session code to check' } },
    async ({ session_code }) => {
      const sessionCode = session_code?.toUpperCase();
      const session = sessions.get(sessionCode);
      if (!session) return { content: [{ type: 'text', text: `❌ Session "${sessionCode}" not found.` }] };
      const connected = session.ws && session.ws.readyState === 1;
      const pending = pendingCommands.get(sessionCode)?.length || 0;
      return { content: [{ type: 'text', text: connected ? `✅ Session "${sessionCode}" is connected.${pending > 0 ? ` (${pending} pending)` : ''}` : `⚠️ Session exists but plugin not connected.${pending > 0 ? ` (${pending} queued)` : ''}` }] };
    }
  );

  mcpServer.tool(
    'set_context',
    'Push context to a FigJam session.',
    {
      session_code: { type: 'string', description: 'The session code' },
      transcript: { type: 'string', description: 'Call transcript or meeting notes' },
      client_name: { type: 'string', description: 'Client or company name' },
      project_name: { type: 'string', description: 'Project or deal name' },
      summary: { type: 'string', description: 'Brief summary' },
      metadata: { type: 'object', description: 'Additional metadata' }
    },
    async ({ session_code, transcript, client_name, project_name, summary, metadata }) => {
      const sessionCode = session_code?.toUpperCase();
      if (!sessionCode || !sessions.has(sessionCode)) {
        return { content: [{ type: 'text', text: `❌ Session "${sessionCode || 'none'}" not found.` }] };
      }
      sessionContext.set(sessionCode, { transcript, clientName: client_name, projectName: project_name, summary, metadata, updatedAt: Date.now() });
      sendToPlugin(sessionCode, { type: 'context-updated', hasContext: true, clientName: client_name, projectName: project_name, summary });
      return { content: [{ type: 'text', text: `✅ Context set for session "${sessionCode}"${client_name ? ` (${client_name})` : ''}.` }] };
    }
  );

  mcpServer.tool(
    'get_context',
    'Get the current context for a FigJam session.',
    { session_code: { type: 'string', description: 'The session code to check' } },
    async ({ session_code }) => {
      const sessionCode = session_code?.toUpperCase();
      const context = sessionContext.get(sessionCode);
      if (!context) return { content: [{ type: 'text', text: `No context set for session "${sessionCode}".` }] };
      return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
    }
  );

  return mcpServer;
}

// Create the singleton MCP server instance
const sharedMcpServer = createMcpServer();
console.log('[MCP] Shared Creator MCP Server instance created.');

// ============================================================================
// HTTP Routes
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size, mcpSessions: Object.keys(transports).length, version: '1.3.0' });
});

app.post('/session', (req, res) => {
  const code = generateSessionCode();
  sessions.set(code, { createdAt: Date.now(), lastPing: Date.now(), ws: null });
  console.log(`[Session] Created new session: ${code}`);
  res.json({ code });
});

app.get('/session/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ code, connected: session.ws?.readyState === 1, pendingCommands: pendingCommands.get(code)?.length || 0, createdAt: session.createdAt });
});

app.get('/context/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const context = sessionContext.get(code);
  if (!context) return res.json({ hasContext: false });
  res.json({ hasContext: true, ...context });
});

app.post('/context/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { transcript, clientName, projectName, summary, metadata } = req.body;
  sessionContext.set(code, { transcript, clientName, projectName, summary, metadata, updatedAt: Date.now() });
  sendToPlugin(code, { type: 'context-updated', hasContext: true, clientName, projectName, summary });
  res.json({ success: true });
});

// ============================================================================
// MCP Streamable HTTP Endpoint - Unified /sse handler
// ============================================================================

function isInitializeRequest(body) {
  if (body?.method === 'initialize') return true;
  if (Array.isArray(body) && body.some(m => m.method === 'initialize')) return true;
  return false;
}

// Support both /mcp and /sse endpoints
app.all(['/mcp', '/sse'], async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  console.log(`[MCP] ${req.method} /sse - Session: ${sessionId || 'none'}`);
  
  // Handle DELETE - terminate session
  if (req.method === 'DELETE') {
    if (sessionId && transports[sessionId]) {
      try {
        await transports[sessionId].close();
      } catch (e) {}
      delete transports[sessionId];
      console.log(`[MCP] Session terminated: ${sessionId}`);
      return res.status(200).end();
    }
    return res.status(404).json({ error: 'Session not found' });
  }
  
  // Existing session - reuse transport
  if (sessionId && transports[sessionId]) {
    const transport = transports[sessionId];
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error(`[MCP] Error handling request:`, e);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error' });
      }
    }
    return;
  }
  
  // New session - must be initialize request (POST)
  if (req.method === 'POST' && isInitializeRequest(req.body)) {
    const newSessionId = randomUUID();
    console.log(`[MCP] Creating new session: ${newSessionId}`);
    
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sid) => {
        console.log(`[MCP] Session initialized: ${sid}`);
      }
    });
    
    transports[newSessionId] = transport;
    
    // Connect to the shared MCP server
    await sharedMcpServer.connect(transport);
    
    // Clean up on close
    transport.onclose = () => {
      console.log(`[MCP] Transport closed for session: ${newSessionId}`);
      delete transports[newSessionId];
    };
    
    // Handle the initialize request
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error(`[MCP] Error during initialization:`, e);
      delete transports[newSessionId];
      if (!res.headersSent) {
        res.status(500).json({ error: 'Initialization failed' });
      }
    }
    return;
  }
  
  // GET without session or non-initialize POST without session
  if (req.method === 'GET') {
    return res.status(400).json({ 
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Session required. Send initialize request via POST first.' }
    });
  }
  
  return res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32600, message: 'Invalid request. Missing session ID or not an initialize request.' }
  });
});

// ============================================================================
// WebSocket Server (for FigJam plugin)
// ============================================================================

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('[WebSocket] New connection');
  let sessionCode = null;
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'join') {
        sessionCode = msg.code?.toUpperCase();
        const session = sessions.get(sessionCode);
        if (session) {
          session.ws = ws;
          session.lastPing = Date.now();
          console.log(`[WebSocket] Plugin joined session: ${sessionCode}`);
          ws.send(JSON.stringify({ type: 'joined', code: sessionCode }));
          const pending = pendingCommands.get(sessionCode) || [];
          pending.forEach(cmd => ws.send(JSON.stringify(cmd)));
          if (pending.length > 0) {
            console.log(`[WebSocket] Sent ${pending.length} pending commands`);
            pendingCommands.set(sessionCode, []);
          }
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
        }
      }
      
      if (msg.type === 'ping') {
        const session = sessions.get(sessionCode);
        if (session) session.lastPing = Date.now();
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.error('[WebSocket] Error parsing message:', e);
    }
  });
  
  ws.on('close', () => {
    console.log(`[WebSocket] Connection closed: ${sessionCode}`);
    const session = sessions.get(sessionCode);
    if (session) session.ws = null;
  });
});

// ============================================================================
// Start Server
// ============================================================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     Creator MCP Server v1.3.0 (Streamable HTTP)        ║
╠════════════════════════════════════════════════════════╣
║  HTTP:      http://localhost:${PORT}                      ║
║  MCP:       http://localhost:${PORT}/sse                  ║
║  WebSocket: ws://localhost:${PORT}/ws                     ║
║                                                        ║
║  Singleton pattern with per-session transports         ║
╚════════════════════════════════════════════════════════╝
  `);
});
