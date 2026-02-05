import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocketServer, WebSocket } from 'ws';
import * as z from 'zod/v4';

// ============================================================================
// FigJam Plugin Session Management
// ============================================================================

interface PluginSession {
  ws: WebSocket | null;
  createdAt: number;
  lastPing: number;
}

interface SessionContext {
  transcript?: string;
  clientName?: string;
  projectName?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  updatedAt: number;
}

const pluginSessions = new Map<string, PluginSession>();
const pendingCommands = new Map<string, unknown[]>();
const sessionContext = new Map<string, SessionContext>();

function generateSessionCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanupSessions(): void {
  const now = Date.now();
  const timeout = 5 * 60 * 1000;

  for (const [code, session] of pluginSessions.entries()) {
    if (now - session.lastPing > timeout) {
      console.error(`[Session] Cleaning up stale session: ${code}`);
      if (session.ws) session.ws.close();
      pluginSessions.delete(code);
      pendingCommands.delete(code);
      sessionContext.delete(code);
    }
  }
}

setInterval(cleanupSessions, 60 * 1000);

// ============================================================================
// Diagram Generation
// ============================================================================

interface DiagramShape {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type?: string;
  text: string;
  fill?: string;
  stroke?: string;
  textFill?: string;
}

interface DiagramConnection {
  from: string;
  to: string;
  fromMagnet?: string;
  toMagnet?: string;
  label?: string;
}

interface DiagramSection {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Diagram {
  sections: DiagramSection[];
  shapes: DiagramShape[];
  connections: DiagramConnection[];
}

interface FlowStep {
  text?: string;
  label?: string;
  type?: 'process' | 'decision';
}

// ============================================================================
// Diagram Validator - ENFORCES RULES regardless of input
// ============================================================================

const MIN_GAP = 60; // Minimum gap between shapes (increased for arrow routing)
const ARROW_LANE_WIDTH = 30; // Space needed for arrow lanes
const PADDING = 100; // Padding around diagram for section

function calculateShapeSize(text: string, type: string = 'rectangle'): { width: number, height: number } {
  // Compact sizing - truncation is OK, keep diagrams small
  const CHAR_WIDTH = 8;
  const H_PADDING = 30;
  const V_PADDING = 20;
  
  // Cap text length for sizing calculation (truncation is fine)
  const effectiveLength = Math.min(text.length, 20);
  const textWidth = effectiveLength * CHAR_WIDTH;
  
  if (type === 'diamond') {
    // Diamonds: compact but readable
    const width = Math.max(140, textWidth + H_PADDING);
    const height = Math.max(80, 60);
    return { width, height };
  } else if (type === 'ellipse') {
    // Ellipses: start/end nodes
    const width = Math.max(120, textWidth + H_PADDING);
    const height = Math.max(50, 45);
    return { width, height };
  } else {
    // Rectangles: compact
    const width = Math.max(140, textWidth + H_PADDING);
    const height = Math.max(50, 45);
    return { width, height };
  }
}

function shapesOverlap(a: DiagramShape, b: DiagramShape, gap: number = MIN_GAP): boolean {
  return !(
    a.x + a.width + gap < b.x ||
    b.x + b.width + gap < a.x ||
    a.y + a.height + gap < b.y ||
    b.y + b.height + gap < a.y
  );
}

function validateAndFixDiagram(diagram: Diagram): Diagram {
  const fixed = JSON.parse(JSON.stringify(diagram)) as Diagram; // Deep clone
  
  // Store section name for later (we'll rebuild sections from scratch)
  const sectionName = fixed.sections[0]?.name || 'Diagram';
  
  // Clear sections - we'll add it LAST after all shapes are finalized
  fixed.sections = [];
  
  // 1. Fix shape sizes to fit text (NEVER truncate)
  for (const shape of fixed.shapes) {
    const requiredSize = calculateShapeSize(shape.text, shape.type);
    shape.width = Math.max(shape.width || 0, requiredSize.width);
    shape.height = Math.max(shape.height || 0, requiredSize.height);
  }
  
  // 2. Fix overlapping shapes - push them apart
  let iterations = 0;
  let hasOverlap = true;
  while (hasOverlap && iterations < 100) {
    hasOverlap = false;
    iterations++;
    
    for (let i = 0; i < fixed.shapes.length; i++) {
      for (let j = i + 1; j < fixed.shapes.length; j++) {
        const a = fixed.shapes[i];
        const b = fixed.shapes[j];
        
        if (shapesOverlap(a, b)) {
          hasOverlap = true;
          
          // Calculate centers
          const aCenterX = a.x + a.width / 2;
          const aCenterY = a.y + a.height / 2;
          const bCenterX = b.x + b.width / 2;
          const bCenterY = b.y + b.height / 2;
          
          // Push apart in the direction of least overlap
          const overlapX = (a.width / 2 + b.width / 2 + MIN_GAP) - Math.abs(aCenterX - bCenterX);
          const overlapY = (a.height / 2 + b.height / 2 + MIN_GAP) - Math.abs(aCenterY - bCenterY);
          
          if (overlapX < overlapY) {
            // Push horizontally
            const pushX = (overlapX / 2) + 10;
            if (aCenterX < bCenterX) {
              a.x -= pushX;
              b.x += pushX;
            } else {
              a.x += pushX;
              b.x -= pushX;
            }
          } else {
            // Push vertically
            const pushY = (overlapY / 2) + 10;
            if (aCenterY < bCenterY) {
              a.y -= pushY;
              b.y += pushY;
            } else {
              a.y += pushY;
              b.y -= pushY;
            }
          }
        }
      }
    }
  }
  
  // 3. Smart magnet assignment to reduce arrow overlap
  // Count connections per shape and per side
  const incomingBySide: Map<string, Map<string, number>> = new Map(); // shapeId -> { side -> count }
  const outgoingBySide: Map<string, Map<string, number>> = new Map();
  
  // Initialize counters
  for (const shape of fixed.shapes) {
    incomingBySide.set(shape.id, new Map([['TOP', 0], ['BOTTOM', 0], ['LEFT', 0], ['RIGHT', 0]]));
    outgoingBySide.set(shape.id, new Map([['TOP', 0], ['BOTTOM', 0], ['LEFT', 0], ['RIGHT', 0]]));
  }
  
  // Build shape lookup for position-based magnet selection
  const shapeById = new Map(fixed.shapes.map(s => [s.id, s]));
  
  // Process connections with smart magnet selection
  for (const conn of fixed.connections) {
    const fromShape = shapeById.get(conn.from);
    const toShape = shapeById.get(conn.to);
    
    if (!fromShape || !toShape) continue;
    
    // Calculate relative positions
    const fromCenterX = fromShape.x + fromShape.width / 2;
    const fromCenterY = fromShape.y + fromShape.height / 2;
    const toCenterX = toShape.x + toShape.width / 2;
    const toCenterY = toShape.y + toShape.height / 2;
    
    const dx = toCenterX - fromCenterX;
    const dy = toCenterY - fromCenterY;
    
    // Determine best magnets based on relative position
    let idealFromMagnet: string;
    let idealToMagnet: string;
    
    if (Math.abs(dy) > Math.abs(dx)) {
      // Primarily vertical relationship
      if (dy > 0) {
        idealFromMagnet = 'BOTTOM';
        idealToMagnet = 'TOP';
      } else {
        idealFromMagnet = 'TOP';
        idealToMagnet = 'BOTTOM';
      }
    } else {
      // Primarily horizontal relationship
      if (dx > 0) {
        idealFromMagnet = 'RIGHT';
        idealToMagnet = 'LEFT';
      } else {
        idealFromMagnet = 'LEFT';
        idealToMagnet = 'RIGHT';
      }
    }
    
    // Use provided magnets if valid, otherwise use ideal
    const fromMagnet = (conn.fromMagnet && conn.fromMagnet !== 'AUTO') ? conn.fromMagnet : idealFromMagnet;
    const toMagnet = (conn.toMagnet && conn.toMagnet !== 'AUTO') ? conn.toMagnet : idealToMagnet;
    
    conn.fromMagnet = fromMagnet;
    conn.toMagnet = toMagnet;
    
    // Track usage for potential offset calculation
    const fromSideCount = outgoingBySide.get(conn.from);
    const toSideCount = incomingBySide.get(conn.to);
    if (fromSideCount) fromSideCount.set(fromMagnet, (fromSideCount.get(fromMagnet) || 0) + 1);
    if (toSideCount) toSideCount.set(toMagnet, (toSideCount.get(toMagnet) || 0) + 1);
  }
  
  // Add extra spacing for shapes with many connections on same side
  for (const shape of fixed.shapes) {
    const incoming = incomingBySide.get(shape.id);
    const outgoing = outgoingBySide.get(shape.id);
    if (!incoming || !outgoing) continue;
    
    // Check if any side has multiple connections (potential overlap)
    for (const side of ['TOP', 'BOTTOM', 'LEFT', 'RIGHT']) {
      const totalOnSide = (incoming.get(side) || 0) + (outgoing.get(side) || 0);
      if (totalOnSide > 2) {
        // Multiple arrows on same side - ensure shape has extra margin
        // Increase shape size slightly to spread connection points
        if (side === 'TOP' || side === 'BOTTOM') {
          shape.width = Math.max(shape.width, shape.width + (totalOnSide - 2) * ARROW_LANE_WIDTH);
        } else {
          shape.height = Math.max(shape.height, shape.height + (totalOnSide - 2) * ARROW_LANE_WIDTH);
        }
      }
    }
  }
  
  // 4. Calculate section bounds LAST - must cover ALL shapes with padding
  // Section is added AFTER all shapes are finalized so it fully covers everything
  if (fixed.shapes.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    for (const shape of fixed.shapes) {
      minX = Math.min(minX, shape.x);
      minY = Math.min(minY, shape.y);
      maxX = Math.max(maxX, shape.x + shape.width);
      maxY = Math.max(maxY, shape.y + shape.height);
    }
    
    // Create section to cover all shapes with padding
    const sectionX = minX - PADDING;
    const sectionY = minY - PADDING;
    const sectionWidth = (maxX - minX) + (PADDING * 2);
    const sectionHeight = (maxY - minY) + (PADDING * 2);
    
    fixed.sections.push({
      name: sectionName,
      x: sectionX,
      y: sectionY,
      width: Math.max(sectionWidth, 400),
      height: Math.max(sectionHeight, 300)
    });
  }
  
  console.error(`[Validator] Fixed diagram: ${fixed.shapes.length} shapes, ${iterations} overlap iterations, section added LAST`);
  
  // 5. Return with explicit property order: shapes first, connections, then sections LAST
  // This ensures the plugin processes sections after all shapes exist
  return {
    shapes: fixed.shapes,
    connections: fixed.connections,
    sections: fixed.sections
  };
}

function generateFlowchart(description: string, nodes: FlowStep[] = []): Diagram {
  const baseFlow: Diagram = {
    sections: [{ name: description.substring(0, 50), x: 0, y: 0, width: 800, height: 600 }],
    shapes: [{ id: 'start', x: 300, y: 30, type: 'ellipse', width: 120, height: 50, text: 'Start', fill: 'lightGreen', stroke: 'green' }],
    connections: [],
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
        stroke: isDecision ? 'orange' : 'blue',
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

function generateMindmap(centralTopic: string, branches: string[] = []): Diagram {
  const mindmap: Diagram = {
    sections: [{ name: centralTopic, x: 0, y: 0, width: 800, height: 500 }],
    shapes: [{ id: 'center', x: 320, y: 200, type: 'ellipse', width: 160, height: 80, text: centralTopic, fill: 'blue', stroke: 'blue', textFill: 'white' }],
    connections: [],
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

function sendToPlugin(sessionCode: string, command: unknown): boolean {
  // Validate and fix diagrams before sending
  let processedCommand = command;
  if (typeof command === 'object' && command !== null) {
    const cmd = command as Record<string, unknown>;
    if (cmd.type === 'create-diagram' && cmd.data) {
      console.error(`[Bridge] Validating diagram before sending...`);
      const fixedDiagram = validateAndFixDiagram(cmd.data as Diagram);
      processedCommand = { ...cmd, data: fixedDiagram };
    }
  }
  
  const session = pluginSessions.get(sessionCode);
  if (session?.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(processedCommand));
    console.error(`[Bridge] Sent command to session ${sessionCode}`);
    return true;
  } else {
    if (!pendingCommands.has(sessionCode)) pendingCommands.set(sessionCode, []);
    pendingCommands.get(sessionCode)!.push(processedCommand);
    console.error(`[Bridge] Queued command for session ${sessionCode}`);
    return false;
  }
}

// ============================================================================
// MCP Server Factory
// ============================================================================

const flowStepSchema = z.object({
  text: z.string().optional(),
  label: z.string().optional(),
  type: z.enum(['process', 'decision']).optional(),
});

const diagramShapeSchema = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  type: z.string().optional(),
  text: z.string(),
  fill: z.string().optional(),
  stroke: z.string().optional(),
});

const diagramConnectionSchema = z.object({
  from: z.string(),
  to: z.string(),
  fromMagnet: z.string().optional(),
  toMagnet: z.string().optional(),
  label: z.string().optional(),
});

const createServer = (): McpServer => {
  const server = new McpServer({
    name: 'creator-mcp',
    version: '2.0.0',
  });

  server.registerTool(
    'create_flowchart',
    {
      title: 'Create Flowchart',
      description: 'Create a flowchart diagram in FigJam. IMPORTANT: Call get_diagram_rules first to learn the required formatting rules for sizing, spacing, and arrow routing.',
      inputSchema: {
        session_code: z.string().describe('The session code from the FigJam Creator plugin (6 characters)'),
        title: z.string().optional().describe('Title for the flowchart'),
        description: z.string().optional().describe('Description of the flow to create'),
        steps: z.array(flowStepSchema).optional().describe('Optional: explicit list of steps'),
      },
    },
    async (params) => {
      const sessionCode = params.session_code?.toUpperCase();
      if (!sessionCode || !pluginSessions.has(sessionCode)) {
        return {
          content: [{ type: 'text', text: `❌ Session "${sessionCode || 'none'}" not found. Ask the user to open the FigJam Creator plugin and share their session code.` }],
        };
      }
      const diagram = generateFlowchart(params.title || params.description || 'Flowchart', params.steps || []);
      diagram.sections[0].name = params.title || 'Flowchart';
      const sent = sendToPlugin(sessionCode, { type: 'create-diagram', data: diagram, source: 'stilla', description: params.description });
      return {
        content: [{ type: 'text', text: sent ? `✅ Flowchart "${params.title}" sent to FigJam!` : `⏳ Flowchart "${params.title}" queued.` }],
      };
    },
  );

  server.registerTool(
    'create_mindmap',
    {
      title: 'Create Mind Map',
      description: 'Create a mind map diagram in FigJam. Call get_diagram_rules first for formatting requirements.',
      inputSchema: {
        session_code: z.string().describe('The session code from the FigJam Creator plugin'),
        central_topic: z.string().describe('The main topic in the center'),
        branches: z.array(z.string()).optional().describe('List of branch topics (up to 6)'),
      },
    },
    async (params) => {
      const sessionCode = params.session_code?.toUpperCase();
      if (!sessionCode || !pluginSessions.has(sessionCode)) {
        return {
          content: [{ type: 'text', text: `❌ Session "${sessionCode || 'none'}" not found.` }],
        };
      }
      const diagram = generateMindmap(params.central_topic, params.branches || []);
      const sent = sendToPlugin(sessionCode, { type: 'create-diagram', data: diagram, source: 'stilla' });
      return {
        content: [{ type: 'text', text: sent ? `✅ Mind map "${params.central_topic}" sent to FigJam!` : `⏳ Mind map queued.` }],
      };
    },
  );

  server.registerTool(
    'create_diagram',
    {
      title: 'Create Custom Diagram',
      description: 'Create a custom diagram in FigJam. IMPORTANT: Call get_diagram_rules first - shapes must be sized to fit text (never truncate), arrows must use explicit magnets, minimum 50px gaps between shapes.',
      inputSchema: {
        session_code: z.string().describe('The session code from the FigJam Creator plugin'),
        title: z.string().optional().describe('Title for the diagram section'),
        shapes: z.array(diagramShapeSchema).optional().describe('Array of shape objects'),
        connections: z.array(diagramConnectionSchema).optional().describe('Array of connection objects'),
      },
    },
    async (params) => {
      const sessionCode = params.session_code?.toUpperCase();
      if (!sessionCode || !pluginSessions.has(sessionCode)) {
        return {
          content: [{ type: 'text', text: `❌ Session not found.` }],
        };
      }
      const diagram: Diagram = {
        sections: [{ name: params.title || 'Diagram', x: 0, y: 0, width: 800, height: 600 }],
        shapes: (params.shapes || []) as DiagramShape[],
        connections: (params.connections || []) as DiagramConnection[],
      };
      const sent = sendToPlugin(sessionCode, { type: 'create-diagram', data: diagram, source: 'stilla' });
      return {
        content: [{ type: 'text', text: sent ? `✅ Diagram created!` : `⏳ Diagram queued.` }],
      };
    },
  );

  server.registerTool(
    'check_figjam_status',
    {
      title: 'Check FigJam Status',
      description: 'Check if a FigJam Creator plugin session is connected.',
      inputSchema: {
        session_code: z.string().describe('The session code to check'),
      },
    },
    async (params) => {
      const sessionCode = params.session_code?.toUpperCase();
      const session = pluginSessions.get(sessionCode);
      if (!session) {
        return {
          content: [{ type: 'text', text: `❌ Session "${sessionCode}" not found.` }],
        };
      }
      const connected = session.ws && session.ws.readyState === WebSocket.OPEN;
      const pending = pendingCommands.get(sessionCode)?.length || 0;
      return {
        content: [{ type: 'text', text: connected ? `✅ Session "${sessionCode}" is connected.${pending > 0 ? ` (${pending} pending)` : ''}` : `⚠️ Session exists but plugin not connected.${pending > 0 ? ` (${pending} queued)` : ''}` }],
      };
    },
  );

  server.registerTool(
    'set_context',
    {
      title: 'Set Context',
      description: 'Push context (transcript, client info, project details) to a FigJam session.',
      inputSchema: {
        session_code: z.string().describe('The session code'),
        transcript: z.string().optional().describe('Call transcript or meeting notes'),
        client_name: z.string().optional().describe('Client or company name'),
        project_name: z.string().optional().describe('Project or deal name'),
        summary: z.string().optional().describe('Brief summary'),
        metadata: z.record(z.string(), z.any()).optional().describe('Additional metadata'),
      },
    },
    async (params) => {
      const sessionCode = params.session_code?.toUpperCase();
      if (!sessionCode || !pluginSessions.has(sessionCode)) {
        return {
          content: [{ type: 'text', text: `❌ Session "${sessionCode || 'none'}" not found.` }],
        };
      }
      sessionContext.set(sessionCode, {
        transcript: params.transcript,
        clientName: params.client_name,
        projectName: params.project_name,
        summary: params.summary,
        metadata: params.metadata as Record<string, unknown>,
        updatedAt: Date.now(),
      });
      sendToPlugin(sessionCode, { type: 'context-updated', hasContext: true, clientName: params.client_name, projectName: params.project_name, summary: params.summary });
      return {
        content: [{ type: 'text', text: `✅ Context set for session "${sessionCode}"${params.client_name ? ` (${params.client_name})` : ''}.` }],
      };
    },
  );

  // Tool to get diagram formatting rules
  server.registerTool(
    'get_diagram_rules',
    {
      title: 'Get Diagram Rules',
      description: 'Get the FigJam diagram formatting rules. ALWAYS call this before creating diagrams to ensure proper formatting.',
      inputSchema: {},
    },
    async () => {
      const rules = `# FigJam Flowchart Rules - MUST FOLLOW

## Core Principles (NEVER VIOLATE)
1. Text must NEVER be truncated - no "..." allowed, size shapes to fit ALL text
2. Shapes must NEVER overlap - maintain 50px gap minimum
3. Arrows must NEVER intersect other arrows
4. Arrows must NEVER pass through shapes/bubbles

## Shape Sizing (STRICT)

### Width Calculation
- Formula: (character_count × 10) + 40 pixels
- Minimum width: 140px
- Diamonds need ~1.5x width (text area is smaller)

### Height
- 1 line: 50px, 2 lines: 70px, each additional: +20px

### Diamonds (Decisions) - CRITICAL
- Formula: width = (chars × 12) + 80px, minimum 180px
- Height: width × 0.6
- KEEP TEXT SHORT (under 15 chars) or diamond must be HUGE

## Spacing
- Minimum gap between shapes: 50px
- Parallel paths horizontal separation: 200px+
- Vertical spacing between steps: 100-120px

## Connection Magnets
Use fromMagnet/toMagnet with: "TOP", "BOTTOM", "LEFT", "RIGHT"
NEVER use AUTO - always specify explicit magnets.

## Arrow Routing
- Vertical Flow: exit BOTTOM, enter TOP
- Branch Left: exit LEFT, enter TOP
- Branch Right: exit RIGHT, enter TOP
- Merging: enter from opposite sides (LEFT/RIGHT)
- Loop Back: position retry nodes OUTSIDE main flow, route arrows around perimeter

## Colors
- Start/End: fill "lightGreen"/"lightPurple", stroke "green"/"purple"
- Process: fill "lightBlue", stroke "blue"
- Decision: fill "lightOrange", stroke "orange"
- Error: fill "lightRed", stroke "red"

## Required Shape Properties
{
  id: string (unique),
  x: number,
  y: number,
  width: number (calculated from text),
  height: number,
  type: "rectangle" | "diamond" | "ellipse",
  text: string (full text, never truncated),
  fill: string,
  stroke: string
}

## Required Connection Properties
{
  from: string (shape id),
  to: string (shape id),
  fromMagnet: "TOP" | "BOTTOM" | "LEFT" | "RIGHT",
  toMagnet: "TOP" | "BOTTOM" | "LEFT" | "RIGHT",
  label?: string (optional, for Yes/No on decisions)
}`;

      return {
        content: [{ type: 'text', text: rules }],
      };
    },
  );

  return server;
};

// ============================================================================
// HTTP + WebSocket Server
// ============================================================================

const startHttp = async (): Promise<void> => {
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3001);
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const servers: Record<string, McpServer> = {};
  const serverInfo = { name: 'creator-mcp', version: '2.0.0' };

  const httpServer = createHttpServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

    // Handle OPTIONS preflight for ALL routes
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Well-known MCP discovery
    if (url.pathname === '/.well-known/mcp' || url.pathname === '/.well-known/mcp.json') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: serverInfo.name, version: serverInfo.version, transport: 'streamable_http', endpoint: '/mcp' }));
      return;
    }

    // Health check
    if (url.pathname === '/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', sessions: pluginSessions.size, mcpSessions: Object.keys(transports).length, version: serverInfo.version }));
      return;
    }

    // Plugin session management
    if (url.pathname === '/session') {
      if (req.method === 'POST') {
        const code = generateSessionCode();
        pluginSessions.set(code, { ws: null, createdAt: Date.now(), lastPing: Date.now() });
        console.error(`[Session] Created new session: ${code}`);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code }));
        return;
      }
    }

    if (url.pathname.startsWith('/session/')) {
      const code = url.pathname.split('/')[2]?.toUpperCase();
      const session = pluginSessions.get(code);
      if (!session) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code, connected: session.ws?.readyState === WebSocket.OPEN, pendingCommands: pendingCommands.get(code)?.length || 0 }));
      return;
    }

    // Redirect root to /mcp
    if (url.pathname === '/') {
      url.pathname = '/mcp';
    }

    // Skip /ws - handled by WebSocket server
    if (url.pathname === '/ws') {
      // WebSocket upgrade will be handled by wss
      // Don't respond here, let the upgrade happen
      return;
    }

    // MCP endpoint
    if (url.pathname !== '/mcp') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Not Found');
      return;
    }

    // OPTIONS
    if (req.method?.toUpperCase() === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
      res.end();
      return;
    }

    // Normalize Accept header (KEY FIX from figma-comments)
    const accept = req.headers.accept;
    if (!accept || !accept.includes('application/json') || !accept.includes('text/event-stream')) {
      req.headers.accept = 'application/json, text/event-stream';
    }

    // Normalize Content-Type
    if (req.method?.toUpperCase() === 'POST' && !req.headers['content-type']) {
      req.headers['content-type'] = 'application/json';
    }

    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    try {
      // Existing session
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res);
        return;
      }

      // New session (POST without session ID)
      if (!sessionId && req.method?.toUpperCase() === 'POST') {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
            servers[id] = server;
          },
        });

        transport.onclose = () => {
          const currentId = transport.sessionId;
          if (currentId && transports[currentId]) delete transports[currentId];
          if (currentId && servers[currentId]) delete servers[currentId];
        };

        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res);

        if (!transport.sessionId) {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        }
        return;
      }

      // DELETE session
      if (sessionId && req.method?.toUpperCase() === 'DELETE') {
        if (transports[sessionId]) {
          await transports[sessionId].close().catch(() => undefined);
          delete transports[sessionId];
          delete servers[sessionId];
        }
        res.statusCode = 200;
        res.end();
        return;
      }

      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, id: null }));
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      }
    }
  });

  // WebSocket server for FigJam plugin
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    console.error('[WebSocket] New connection');
    let sessionCode: string | null = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'join') {
          sessionCode = msg.code?.toUpperCase();
          const session = pluginSessions.get(sessionCode!);
          if (session) {
            session.ws = ws;
            session.lastPing = Date.now();
            console.error(`[WebSocket] Plugin joined session: ${sessionCode}`);
            ws.send(JSON.stringify({ type: 'joined', code: sessionCode }));
            const pending = pendingCommands.get(sessionCode!) || [];
            pending.forEach((cmd) => ws.send(JSON.stringify(cmd)));
            if (pending.length > 0) {
              console.error(`[WebSocket] Sent ${pending.length} pending commands`);
              pendingCommands.set(sessionCode!, []);
            }
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          }
        }

        if (msg.type === 'ping' && sessionCode) {
          const session = pluginSessions.get(sessionCode);
          if (session) session.lastPing = Date.now();
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        console.error('[WebSocket] Error parsing message:', e);
      }
    });

    ws.on('close', () => {
      console.error(`[WebSocket] Connection closed: ${sessionCode}`);
      if (sessionCode) {
        const session = pluginSessions.get(sessionCode);
        if (session) session.ws = null;
      }
    });
  });

  httpServer.listen(port, host, () => {
    console.error(`
╔════════════════════════════════════════════════════════╗
║           Creator MCP Server v2.0.0                    ║
╠════════════════════════════════════════════════════════╣
║  HTTP:      http://${host}:${port}                         ║
║  MCP:       http://${host}:${port}/mcp                     ║
║  WebSocket: ws://${host}:${port}/ws                        ║
║  Discovery: http://${host}:${port}/.well-known/mcp         ║
╚════════════════════════════════════════════════════════╝
    `);
  });

  process.on('SIGINT', async () => {
    for (const sessionId of Object.keys(transports)) {
      try {
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        console.error(`Error closing transport ${sessionId}:`, error);
      }
    }
    process.exit(0);
  });
};

startHttp().catch((error) => {
  console.error('MCP server error:', error);
  process.exit(1);
});
