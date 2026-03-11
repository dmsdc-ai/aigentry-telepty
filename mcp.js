const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { zodToJsonSchema } = require('zod-to-json-schema');
const { getConfig } = require('./auth');

const config = getConfig();
const TOKEN = config.authToken;

const server = new Server({ name: 'telepty-mcp-server', version: '0.0.1' }, { capabilities: { tools: {} } });

const tools = [
  {
    name: 'telepty_list_remote_sessions',
    description: 'List all active AI CLI sessions (PTYs) running on a remote telepty daemon. Used to discover available target session IDs.',
    schema: z.object({ remote_url: z.string().describe('Tailscale IP/Host and port (e.g., 100.100.100.5:3848) of the remote daemon.') })
  },
  {
    name: 'telepty_inject_context',
    description: 'Inject a prompt or context into specific active AI CLI sessions on a remote machine. You can specify a single session ID, multiple session IDs, or broadcast to all.',
    schema: z.object({ 
      remote_url: z.string(), 
      session_ids: z.array(z.string()).optional().describe('An array of exact session IDs to inject into. If not provided, it will inject into session_id.'), 
      session_id: z.string().optional().describe('Legacy fallback for a single session ID.'),
      broadcast: z.boolean().optional().describe('If true, injects the prompt into ALL active sessions on the remote daemon. Overrides session_ids.'),
      prompt: z.string().describe('Text to inject into stdin.') 
    })
  },
  {
    name: 'telepty_publish_bus_event',
    description: 'Publish a structured JSON event to the telepty in-memory event bus. This is a fire-and-forget broadcast to any AI agents currently listening. If no agents are listening, the message is dropped.',
    schema: z.object({
      remote_url: z.string().describe('Tailscale IP/Host and port (e.g., 100.100.100.5:3848) of the remote daemon.'),
      payload: z.record(z.any()).describe('The structured JSON payload to broadcast to the event bus. Must be an object.')
    })
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => {
    const schema = zodToJsonSchema(t.schema);
    delete schema.$schema;
    if (!schema.type) schema.type = 'object';
    return { name: t.name, description: t.description, inputSchema: schema };
  })
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    if (name === 'telepty_list_remote_sessions') {
      const baseUrl = args.remote_url.startsWith('http') ? args.remote_url : `http://${args.remote_url}`;
      const res = await fetch(`${baseUrl}/api/sessions`, { headers: { 'x-telepty-token': TOKEN } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sessions = await res.json();
      if (!sessions || sessions.length === 0) return { content: [{ type: 'text', text: `No active sessions found on ${args.remote_url}` }] };
      let text = `Active sessions on ${args.remote_url}:\n\n`;
      sessions.forEach(s => { text += `- ID: ${s.id}\n  Command: ${s.command}\n  Workspace: ${s.cwd}\n\n`; });
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'telepty_inject_context') {
      const baseUrl = args.remote_url.startsWith('http') ? args.remote_url : `http://${args.remote_url}`;
      
      let endpoint = '';
      let body = {};
      
      if (args.broadcast) {
        endpoint = `${baseUrl}/api/sessions/broadcast/inject`;
        body = { prompt: args.prompt };
      } else if (args.session_ids && args.session_ids.length > 0) {
        endpoint = `${baseUrl}/api/sessions/multicast/inject`;
        body = { session_ids: args.session_ids, prompt: args.prompt };
      } else if (args.session_id) {
        endpoint = `${baseUrl}/api/sessions/${encodeURIComponent(args.session_id)}/inject`;
        body = { prompt: args.prompt };
      } else {
        throw new Error('You must provide either broadcast: true, session_ids: [...], or session_id: "..."');
      }

      const res = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telepty-token': TOKEN }, body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      
      let msg = `✅ Successfully injected context.`;
      if (args.broadcast) msg += ` (Broadcasted to ${data.results.successful.length} sessions)`;
      else if (args.session_ids) msg += ` (Multicasted to ${data.results.successful.length} sessions)`;
      else msg += ` (Targeted session '${args.session_id}')`;

      return { content: [{ type: 'text', text: msg }] };
    }
    
    if (name === 'telepty_publish_bus_event') {
      const baseUrl = args.remote_url.startsWith('http') ? args.remote_url : `http://${args.remote_url}`;
      
      const res = await fetch(`${baseUrl}/api/bus/publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telepty-token': TOKEN }, body: JSON.stringify(args.payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      
      return { content: [{ type: 'text', text: `✅ Successfully published event to the bus. Delivered to ${data.delivered} active listeners.` }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Telepty MCP Server running on stdio');
}
main().catch(console.error);
