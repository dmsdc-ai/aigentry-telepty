const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { zodToJsonSchema } = require('zod-to-json-schema');

const server = new Server({ name: 'telepty-mcp-server', version: '0.0.1' }, { capabilities: { tools: {} } });

const tools = [
  {
    name: 'telepty_list_remote_sessions',
    description: 'List all active AI CLI sessions (PTYs) running on a remote telepty daemon. Used to discover available target session IDs.',
    schema: z.object({ remote_url: z.string().describe('Tailscale IP/Host and port (e.g., 100.100.100.5:3848) of the remote daemon.') })
  },
  {
    name: 'telepty_inject_context',
    description: 'Inject a prompt or context into an active AI CLI session on a remote machine. WARNING: You MUST use telepty_list_remote_sessions first to find the exact session_id, and ask the user for confirmation if ambiguous.',
    schema: z.object({ remote_url: z.string(), session_id: z.string().describe('The EXACT session ID.'), prompt: z.string().describe('Text to inject into stdin.') })
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: zodToJsonSchema(t.schema) }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    if (name === 'telepty_list_remote_sessions') {
      const baseUrl = args.remote_url.startsWith('http') ? args.remote_url : `http://${args.remote_url}`;
      const res = await fetch(`${baseUrl}/api/sessions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sessions = await res.json();
      if (!sessions || sessions.length === 0) return { content: [{ type: 'text', text: `No active sessions found on ${args.remote_url}` }] };
      let text = `Active sessions on ${args.remote_url}:\n\n`;
      sessions.forEach(s => { text += `- ID: ${s.id}\n  Command: ${s.command}\n  Workspace: ${s.cwd}\n\n`; });
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'telepty_inject_context') {
      const baseUrl = args.remote_url.startsWith('http') ? args.remote_url : `http://${args.remote_url}`;
      const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(args.session_id)}/inject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: args.prompt })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return { content: [{ type: 'text', text: `✅ Successfully injected context into session '${args.session_id}'. The remote agent has been awakened.` }] };
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
