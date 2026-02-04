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
// Session Management - Links Stilla sessions to FigJam plugins
// ============================================================================

const sessions = new Map(); // sessionCode -> { ws, createdAt, lastPing }
const pendingCommands = new Map(); // sessionCode -> [commands]
const sessionContext = new Map(); // sessionCode -> { transcript, client, project, etc. }

// MCP Session Management
const mcpSessions = new Map(); // mcpSessionId -> { transport, server, createdAt }

function generateSessionCode() {
  // 6-char alphanumeric code
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanupSessions() {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes
  
  for (const [code, session] of sessions.entries()) {
    if (now - session.lastPing > timeout) {
      console.log(`[Session] Cleaning up stale session: ${code}`);
      if (session.ws) session.ws.close();
      sessions.delete(code);
      pendingCommands.delete(code);
      sessionContext.delete(code);
    }
  }
  
  // Cleanup MCP sessions after 30 minutes of inactivity
  const mcpTimeout = 30 * 60 * 1000;
  for (const [sessionId, session] of mcpSessions.entries()) {
    if (now - session.lastActivity > mcpTimeout) {
      console.log(`[MCP] Cleaning up stale MCP session: ${sessionId}`);
      session.transport.close?.();
      mcpSessions.delete(sessionId);
    }
  }
}

setInterval(cleanupSessions, 60 * 1000);

// ============================================================================
// Diagram Generation (same logic as FigJam plugin)
// ============================================================================

function generateFlowchart(description, nodes = []) {
  const baseFlow = {
    sections: [
      { name: description.substring(0, 50), x: 0, y: 0, width: 800, height: 600 }
    ],
    shapes: [
      { id: 'start', x: 300, y: 30, type: 'ellipse', width: 120, height: 50, text: 'Start', fill: 'lightGreen', stroke: 'green' },
    ],
    connections: []
  };
  
  if (nodes.length > 0) {
    let y = 120;
    let prevId = 'start';
    
    nodes.forEach((node, i) => {
      const id = `step_${i}`;
      const isDecision = node.type === 'decision';
      
      baseFlow.shapes.push({
        id,
        x: isDecision ? 275 : 250,
        y,
        type: isDecision ? 'diamond' : 'rectangle',
        width: isDecision ? 170 : 200,
        height: isDecision ? 90 : 60,
        text: node.text || node.label || `Step ${i + 1}`,
        fill: isDecision ? 'lightOrange' : 'lightBlue',
        stroke: isDecision ? 'orange' : 'blue'
      });
      
      baseFlow.connections.push({
        from: prevId,
        to: id,
        fromMagnet: 'BOTTOM',
        toMagnet: 'TOP'
      });
      
      prevId = id;
      y += isDecision ? 130 : 100;
    });
    
    baseFlow.shapes.push({
      id: 'end',
      x: 300,
      y,
      type: 'ellipse',
      width: 120,
      height: 50,
      text: 'End',
      fill: 'lightPurple',
      stroke: 'purple'
    });
    
    baseFlow.connections.push({
      from: prevId,
      to: 'end',
      fromMagnet: 'BOTTOM',
      toMagnet: 'TOP'
    });
    
    baseFlow.sections[0].height = y + 100;
  }
  
  return baseFlow;
}

function generateMindmap(centralTopic, branches = []) {
  const mindmap = {
    sections: [
      { name: centralTopic, x: 0, y: 0, width: 800, height: 500 }
    ],
    shapes: [
      { 
        id: 'center', 
        x: 320, 
        y: 200, 
        type: 'ellipse', 
        width: 160, 
        height: 80, 
        text: centralTopic, 
        fill: 'blue', 
        stroke: 'blue',
        textFill: 'white'
      }
    ],
    connections: []
  };
  
  const positions = [
    { x: 80, y: 50 },
    { x: 560, y: 50 },
    { x: 80, y: 380 },
    { x: 560, y: 380 },
    { x: 80, y: 215 },
    { x: 560, y: 215 },
  ];
  
  const colors = [
    { fill: 'lightGreen', stroke: 'green' },
    { fill: 'lightOrange', stroke: 'orange' },
    { fill: 'lightPurple', stroke: 'purple' },
    { fill: 'lightBlue', stroke: 'blue' },
    { fill: 'lightGray', stroke: 'gray' },
  ];
  
  branches.forEach((branch, i) => {
    if (i >= positions.length) return;
    
    const pos = positions[i];
    const color = colors[i % colors.length];
    const id = `branch_${i}`;
    
    mindmap.shapes.push({
      id,
      x: pos.x,
      y: pos.y,
      width: 140,
      height: 50,
      text: branch,
      ...color
    });
    
    mindmap.connections.push({
      from: 'center',
      to: id
    });
  });
  
  return mindmap;
}

// ============================================================================
// Send command to connected FigJam plugin
// ============================================================================

function sendToPlugin(sessionCode, command) {
  const session = sessions.get(sessionCode);
  
  if (session && session.ws && session.ws.readyState === 1) {
    session.ws.send(JSON.stringify(command));
    console.log(`[Bridge] Sent command to session ${sessionCode}:`, command.type);
    return true;
  } else {
    if (!pendingCommands.has(sessionCode)) {
      pendingCommands.set(sessionCode, []);
    }
    pendingCommands.get(sessionCode).push(command);
    console.log(`[Bridge] Queued command for session ${sessionCode} (plugin not connected)`);
    return false;
  }
}

// ============================================================================
// MCP Server Factory - Creates a new server instance with all tools
// ============================================================================

function createMcpServer() {
  const mcpServer = new McpServer({
    name: 'creator',
    version: '1.1.0',
    description: 'Create diagrams and flowcharts in FigJam with Stilla context'
  });

  // Tool: Create flowchart
  mcpServer.tool(
    'create_flowchart',
    'Create a flowchart diagram in FigJam. The diagram will appear automatically if the plugin is connected.',
    {
      session_code: {
        type: 'string',
        description: 'The session code from the FigJam Creator plugin (6 characters)'
      },
      title: {
        type: 'string',
        description: 'Title for the flowchart'
      },
      description: {
        type: 'string',
        description: 'Description of the flow to create. Be detailed about steps, decisions, and branches.'
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Step label' },
            type: { type: 'string', enum: ['process', 'decision'], description: 'Step type' }
          }
        },
        description: 'Optional: explicit list of steps to include'
      }
    },
    async ({ session_code, title, description, steps }) => {
      const sessionCode = session_code?.toUpperCase();
      
      if (!sessionCode || !sessions.has(sessionCode)) {
        return {
          content: [{ 
            type: 'text', 
            text: `❌ Session "${sessionCode || 'none'}" not found. Ask the user to open the FigJam Creator plugin and share their session code.` 
          }]
        };
      }
      
      const diagram = generateFlowchart(title || description, steps || []);
      diagram.sections[0].name = title || 'Flowchart';
      
      const sent = sendToPlugin(sessionCode, {
        type: 'create-diagram',
        data: diagram,
        source: 'stilla',
        description: description
      });
      
      return {
        content: [{ 
          type: 'text', 
          text: sent 
            ? `✅ Flowchart "${title}" sent to FigJam! It should appear in the canvas now.`
            : `⏳ Flowchart "${title}" queued. It will appear when the FigJam plugin reconnects.`
        }]
      };
    }
  );

  // Tool: Create mindmap
  mcpServer.tool(
    'create_mindmap',
    'Create a mind map diagram in FigJam with a central topic and branches.',
    {
      session_code: {
        type: 'string',
        description: 'The session code from the FigJam Creator plugin'
      },
      central_topic: {
        type: 'string',
        description: 'The main topic in the center of the mind map'
      },
      branches: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of branch topics (up to 6)'
      }
    },
    async ({ session_code, central_topic, branches }) => {
      const sessionCode = session_code?.toUpperCase();
      
      if (!sessionCode || !sessions.has(sessionCode)) {
        return {
          content: [{ 
            type: 'text', 
            text: `❌ Session "${sessionCode || 'none'}" not found. Ask the user to open the FigJam Creator plugin and share their session code.` 
          }]
        };
      }
      
      const diagram = generateMindmap(central_topic, branches || []);
      
      const sent = sendToPlugin(sessionCode, {
        type: 'create-diagram',
        data: diagram,
        source: 'stilla'
      });
      
      return {
        content: [{ 
          type: 'text', 
          text: sent 
            ? `✅ Mind map "${central_topic}" sent to FigJam!`
            : `⏳ Mind map "${central_topic}" queued for when plugin reconnects.`
        }]
      };
    }
  );

  // Tool: Create custom diagram (raw JSON)
  mcpServer.tool(
    'create_diagram',
    'Create a custom diagram in FigJam with full control over shapes and connections.',
    {
      session_code: {
        type: 'string',
        description: 'The session code from the FigJam Creator plugin'
      },
      title: {
        type: 'string',
        description: 'Title for the diagram section'
      },
      shapes: {
        type: 'array',
        description: 'Array of shape objects with id, x, y, width, height, type, text, fill, stroke'
      },
      connections: {
        type: 'array',
        description: 'Array of connection objects with from, to, label, fromMagnet, toMagnet'
      }
    },
    async ({ session_code, title, shapes, connections }) => {
      const sessionCode = session_code?.toUpperCase();
      
      if (!sessionCode || !sessions.has(sessionCode)) {
        return {
          content: [{ 
            type: 'text', 
            text: `❌ Session not found. The user needs to open FigJam Creator plugin and share their session code.` 
          }]
        };
      }
      
      const diagram = {
        sections: [{ name: title || 'Diagram', x: 0, y: 0, width: 800, height: 600 }],
        shapes: shapes || [],
        connections: connections || []
      };
      
      const sent = sendToPlugin(sessionCode, {
        type: 'create-diagram',
        data: diagram,
        source: 'stilla'
      });
      
      return {
        content: [{ 
          type: 'text', 
          text: sent ? `✅ Diagram created in FigJam!` : `⏳ Diagram queued.`
        }]
      };
    }
  );

  // Tool: Check connection status
  mcpServer.tool(
    'check_figjam_status',
    'Check if a FigJam Creator plugin session is connected.',
    {
      session_code: {
        type: 'string',
        description: 'The session code to check'
      }
    },
    async ({ session_code }) => {
      const sessionCode = session_code?.toUpperCase();
      const session = sessions.get(sessionCode);
      
      if (!session) {
        return {
          content: [{ 
            type: 'text', 
            text: `❌ Session "${sessionCode}" not found. Ask the user to open the FigJam Creator plugin to get a session code.` 
          }]
        };
      }
      
      const connected = session.ws && session.ws.readyState === 1;
      const pending = pendingCommands.get(sessionCode)?.length || 0;
      
      return {
        content: [{ 
          type: 'text', 
          text: connected 
            ? `✅ Session "${sessionCode}" is connected and ready. ${pending > 0 ? `(${pending} commands pending)` : ''}`
            : `⚠️ Session "${sessionCode}" exists but plugin is not connected. ${pending > 0 ? `(${pending} commands queued)` : ''}`
        }]
      };
    }
  );

  // Tool: Set context for a session
  mcpServer.tool(
    'set_context',
    'Push context (transcript, client info, project details) to a FigJam session. The plugin can then use this context when generating diagrams.',
    {
      session_code: {
        type: 'string',
        description: 'The session code from the FigJam Creator plugin'
      },
      transcript: {
        type: 'string',
        description: 'Call transcript or meeting notes'
      },
      client_name: {
        type: 'string',
        description: 'Client or company name'
      },
      project_name: {
        type: 'string',
        description: 'Project or deal name'
      },
      summary: {
        type: 'string',
        description: 'Brief summary of the context'
      },
      metadata: {
        type: 'object',
        description: 'Any additional metadata (call date, participants, etc.)'
      }
    },
    async ({ session_code, transcript, client_name, project_name, summary, metadata }) => {
      const sessionCode = session_code?.toUpperCase();
      
      if (!sessionCode || !sessions.has(sessionCode)) {
        return {
          content: [{ 
            type: 'text', 
            text: `❌ Session "${sessionCode || 'none'}" not found. Ask the user to open the FigJam Creator plugin and share their session code.` 
          }]
        };
      }
      
      sessionContext.set(sessionCode, {
        transcript,
        clientName: client_name,
        projectName: project_name,
        summary,
        metadata,
        updatedAt: Date.now()
      });
      
      console.log(`[Context] Set context for session ${sessionCode}: ${client_name || 'unknown client'}`);
      
      sendToPlugin(sessionCode, {
        type: 'context-updated',
        hasContext: true,
        clientName: client_name,
        projectName: project_name,
        summary
      });
      
      return {
        content: [{ 
          type: 'text', 
          text: `✅ Context set for session "${sessionCode}"${client_name ? ` (${client_name})` : ''}. The FigJam plugin can now generate diagrams using this context.`
        }]
      };
    }
  );

  // Tool: Get context for a session
  mcpServer.tool(
    'get_context',
    'Get the current context for a FigJam session.',
    {
      session_code: {
        type: 'string',
        description: 'The session code to check'
      }
    },
    async ({ session_code }) => {
      const sessionCode = session_code?.toUpperCase();
      const context = sessionContext.get(sessionCode);
      
      if (!context) {
        return {
          content: [{ 
            type: 'text', 
            text: `No context set for session "${sessionCode}".`
          }]
        };
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify(context, null, 2)
        }]
      };
    }
  );

  return mcpServer;
}

// ============================================================================
// HTTP Routes
// ============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    sessions: sessions.size,
    mcpSessions: mcpSessions.size,
    version: '1.2.0'
  });
});

// Create new session (called by FigJam plugin)
app.post('/session', (req, res) => {
  const code = generateSessionCode();
  sessions.set(code, {
    createdAt: Date.now(),
    lastPing: Date.now(),
    ws: null
  });
  
  console.log(`[Session] Created new session: ${code}`);
  res.json({ code });
});

// Get session info
app.get('/session/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const session = sessions.get(code);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({
    code,
    connected: session.ws?.readyState === 1,
    pendingCommands: pendingCommands.get(code)?.length || 0,
    createdAt: session.createdAt
  });
});

// Get context for a session (called by FigJam plugin)
app.get('/context/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const context = sessionContext.get(code);
  
  if (!context) {
    return res.json({ hasContext: false });
  }
  
  res.json({
    hasContext: true,
    ...context
  });
});

// Set context via HTTP (alternative to MCP tool)
app.post('/context/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const session = sessions.get(code);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const { transcript, clientName, projectName, summary, metadata } = req.body;
  
  sessionContext.set(code, {
    transcript,
    clientName,
    projectName,
    summary,
    metadata,
    updatedAt: Date.now()
  });
  
  console.log(`[Context] Set context via HTTP for session ${code}`);
  
  sendToPlugin(code, {
    type: 'context-updated',
    hasContext: true,
    clientName,
    projectName,
    summary
  });
  
  res.json({ success: true });
});

// ============================================================================
// MCP Streamable HTTP Endpoint - FIXED with proper session management
// ============================================================================

app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  // Handle DELETE - session termination
  if (req.method === 'DELETE') {
    if (sessionId && mcpSessions.has(sessionId)) {
      const session = mcpSessions.get(sessionId);
      await session.transport.close?.();
      mcpSessions.delete(sessionId);
      console.log(`[MCP] Session terminated: ${sessionId}`);
      return res.status(200).end();
    }
    return res.status(404).json({ error: 'Session not found' });
  }
  
  // Handle GET - SSE stream for server-initiated messages
  if (req.method === 'GET') {
    if (!sessionId || !mcpSessions.has(sessionId)) {
      // No session yet, or unknown session - 400 per spec
      return res.status(400).json({ 
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Session ID required. Initialize first via POST.' }
      });
    }
    
    const session = mcpSessions.get(sessionId);
    session.lastActivity = Date.now();
    
    // Return SSE stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Mcp-Session-Id', sessionId);
    res.flushHeaders();
    
    // Keep connection alive
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30000);
    
    req.on('close', () => {
      clearInterval(keepAlive);
    });
    
    return; // Keep stream open
  }
  
  // Handle POST - JSON-RPC messages
  if (req.method === 'POST') {
    // Check Accept header
    const accept = req.headers['accept'] || '';
    if (!accept.includes('application/json') && !accept.includes('text/event-stream') && !accept.includes('*/*')) {
      return res.status(406).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Accept header must include application/json or text/event-stream' }
      });
    }
    
    const body = req.body;
    
    // Check if this is an initialization request (no session ID expected)
    const isInitialize = body?.method === 'initialize' || 
                         (Array.isArray(body) && body.some(m => m.method === 'initialize'));
    
    if (isInitialize) {
      // Create new session
      const newSessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });
      const server = createMcpServer();
      
      await server.connect(transport);
      
      mcpSessions.set(newSessionId, {
        transport,
        server,
        createdAt: Date.now(),
        lastActivity: Date.now()
      });
      
      console.log(`[MCP] New session created: ${newSessionId}`);
      
      // Set session ID header in response
      res.setHeader('Mcp-Session-Id', newSessionId);
      
      // Handle the request
      return transport.handleRequest(req, res);
    }
    
    // Not initialization - session ID required
    if (!sessionId) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Mcp-Session-Id header required' }
      });
    }
    
    const session = mcpSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Session not found. Please reinitialize.' }
      });
    }
    
    session.lastActivity = Date.now();
    res.setHeader('Mcp-Session-Id', sessionId);
    
    return session.transport.handleRequest(req, res);
  }
  
  // Method not allowed
  res.status(405).json({ error: 'Method not allowed' });
});

// ============================================================================
// WebSocket Server (for FigJam plugin connection)
// ============================================================================

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
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
          pending.forEach(cmd => {
            ws.send(JSON.stringify(cmd));
          });
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
        if (session) {
          session.lastPing = Date.now();
        }
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      
      if (msg.type === 'ack') {
        console.log(`[WebSocket] Command acknowledged: ${msg.commandId}`);
      }
      
    } catch (e) {
      console.error('[WebSocket] Error parsing message:', e);
    }
  });
  
  ws.on('close', () => {
    console.log(`[WebSocket] Connection closed for session: ${sessionCode}`);
    const session = sessions.get(sessionCode);
    if (session) {
      session.ws = null;
    }
  });
  
  ws.on('error', (err) => {
    console.error('[WebSocket] Error:', err);
  });
});

// ============================================================================
// Start Server
// ============================================================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║           Creator MCP Server v1.2.0                    ║
╠════════════════════════════════════════════════════════╣
║  HTTP:      http://localhost:${PORT}                      ║
║  MCP:       http://localhost:${PORT}/mcp                  ║
║  WebSocket: ws://localhost:${PORT}/ws                     ║
║                                                        ║
║  Streamable HTTP transport with session management     ║
╚════════════════════════════════════════════════════════╝
  `);
});
