#!/usr/bin/env node

/**
 * MCP Telepty Server — Session management tools for AI CLIs
 *
 * Tools:
 *   telepty_list_sessions    List all active telepty sessions
 *   telepty_inject_session   Inject text into a session
 *   telepty_session_status   Get detailed status of a session
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";

const PKG_VERSION = (() => {
  try {
    const p = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return p.version || "0.0.0";
  } catch { return "0.0.0"; }
})();

// ── Config ──

// #823 — env-then-file, the SAME order daemon.js (EXPECTED_TOKEN) and cli.js (getAuthToken) use.
// This file reads config.json directly rather than through auth.js, so it has to agree explicitly
// or an operator who sets TELEPTY_AUTH_TOKEN gets a working CLI and a 401-ing MCP server.
function getAuthToken() {
  if (process.env.TELEPTY_AUTH_TOKEN) return process.env.TELEPTY_AUTH_TOKEN;
  try {
    const configPath = path.join(os.homedir(), ".telepty", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config.authToken || "";
  } catch { return ""; }
}

function getDaemonUrl() {
  // TELEPTY_HOST accepts: `host`, `host:port`, or `http://host:port`. Embedded
  // port from TELEPTY_HOST is used unless TELEPTY_PORT is set explicitly.
  const explicitPort = process.env.TELEPTY_PORT ? Number(process.env.TELEPTY_PORT) : null;
  const raw = process.env.TELEPTY_HOST || "127.0.0.1";
  let stripped = String(raw).trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  let host = stripped;
  let embeddedPort = null;
  const ipv6Bracketed = stripped.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6Bracketed) {
    host = ipv6Bracketed[1];
    if (ipv6Bracketed[2]) embeddedPort = Number(ipv6Bracketed[2]);
  } else {
    const colonCount = (stripped.match(/:/g) || []).length;
    if (colonCount === 1) {
      const m = stripped.match(/^(.+):(\d+)$/);
      if (m) {
        host = m[1];
        embeddedPort = Number(m[2]);
      }
    }
  }
  const port = explicitPort != null ? explicitPort : (embeddedPort != null ? embeddedPort : 3848);
  const hostForUrl = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostForUrl}:${port}`;
}

async function daemonFetch(endpoint, options = {}) {
  const url = `${getDaemonUrl()}${endpoint}`;
  const token = getAuthToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { "x-telepty-token": token } : {}),
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`telepty daemon ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

// ── #60 Stage A output vocabulary ──
//
// The MCP surface is read by another AI, which makes an overclaim here worse than on the CLI: a
// human discounts a hedge, a model treats the field name as the fact. So each of these states what
// was measured and nothing beyond it.

// Transport reachability. Reads the daemon's own health verdict — the previous `s.connected` /
// `s.stale` fields are not in the serialized session at all (daemon.js serializeSession exposes
// `healthStatus`/`healthReason`), so every session was being reported as "disconnected" regardless
// of its real state.
function formatConnectivity(session) {
  const status = session.healthStatus || "UNKNOWN";
  const reason = session.healthReason;
  return reason && reason !== status ? `${status} (${reason})` : status;
}

// The measured activity observation, by its literal name. Never an internal FSM state, never a
// word that answers "is it done". An absent observation is reported as an absence, not omitted.
function formatObservation(observation) {
  if (!observation || !observation.kind) return "none observed";
  return observation.cause ? `${observation.kind} (cause: ${observation.cause})` : observation.kind;
}

// §A4 — the capability gap, explicit. Absence of a completion statement must never be readable as
// a quiet success.
function formatOutcomeProtocol(completion) {
  const capability = (completion && completion.capability) || {};
  const state = capability.outcome_protocol || "unavailable";
  const reason = capability.outcome_protocol_reason === "stage_b_deferred_to_0.9.0"
    ? "Stage B deferred: #816, #817"
    : (capability.outcome_protocol_reason || "Stage B deferred: #816, #817");
  return `${state} (${reason})`;
}

// ── MCP Server ──

const server = new McpServer({
  name: "telepty",
  version: PKG_VERSION,
});

// Tool: telepty_list_sessions
server.tool(
  "telepty_list_sessions",
  "List all active telepty sessions with their status, type, and last activity.",
  {},
  async () => {
    try {
      const sessions = await daemonFetch("/api/sessions");
      if (!Array.isArray(sessions) || sessions.length === 0) {
        return { content: [{ type: "text", text: "No active sessions." }] };
      }
      // #60 Stage A §8.5.3 — CONNECTIVITY and ACTIVITY are separate columns because they are
      // separate measurements, and neither is a task outcome. A connected, quiet session is the
      // exact combination this release stops presenting as "done".
      let text = `## Active Sessions (${sessions.length})\n\n`;
      text += "| ID | Type | Connectivity | Activity observation | Last Activity |\n";
      text += "|----|------|--------------|----------------------|---------------|\n";
      for (const s of sessions) {
        const lastAct = s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : "—";
        text += `| ${s.id} | ${s.type || "—"} | ${formatConnectivity(s)} | ${formatObservation(s.activityObservation)} | ${lastAct} |\n`;
      }
      // §A4 — stated once for the whole table, so no reader takes "connected + quiet" as an answer
      // to "is it finished". It is not an answer telepty can give in 0.8.0.
      text += `\nCompletion fact: none observed for any session — telepty measures transport and activity, not task outcome.\n`;
      text += `Outcome protocol: ${formatOutcomeProtocol(sessions[0] && sessions[0].completion)}\n`;
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error listing sessions: ${err.message}` }], isError: true };
    }
  }
);

// Tool: telepty_session_status
server.tool(
  "telepty_session_status",
  "Get detailed status of a specific telepty session.",
  {
    session_id: z.string().describe("Session ID to query"),
  },
  async ({ session_id }) => {
    try {
      const sessions = await daemonFetch("/api/sessions");
      const session = Array.isArray(sessions)
        ? sessions.find(s => s.id === session_id || s.id.startsWith(session_id))
        : null;
      if (!session) {
        return { content: [{ type: "text", text: `Session "${session_id}" not found.` }] };
      }
      // #60 Stage A §8.5.3 — three separate lines for three separate domains. Connectivity says
      // whether bytes can reach the session; the activity observation says what the PTY was
      // measured doing; completion says, explicitly, that telepty cannot tell you whether the task
      // is done. Collapsing any two of them is how a connected+quiet session came to be reported
      // as a finished one.
      let text = `## Session: ${session.id}\n\n`;
      text += `- **Type:** ${session.type || "unknown"}\n`;
      text += `- **Connectivity:** ${formatConnectivity(session)}\n`;
      text += `- **Activity observation:** ${formatObservation(session.activityObservation)}\n`;
      text += `- **Completion fact:** none observed\n`;
      text += `- **Outcome protocol:** ${formatOutcomeProtocol(session.completion)}\n`;
      text += `- **Command:** ${session.command || "—"}\n`;
      text += `- **CWD:** ${session.cwd || "—"}\n`;
      text += `- **Backend:** ${session.backend || "—"}\n`;
      text += `- **Created:** ${session.createdAt ? new Date(session.createdAt).toLocaleString() : "—"}\n`;
      text += `- **Last Activity:** ${session.lastActivityAt ? new Date(session.lastActivityAt).toLocaleString() : "—"}\n`;
      if (session.stateReport) {
        text += `- **State Report:** ${session.stateReport}\n`;
      }
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error querying session: ${err.message}` }], isError: true };
    }
  }
);

// Tool: telepty_inject_session
server.tool(
  "telepty_inject_session",
  "Inject text into a telepty session. Use this to send messages or prompts to other AI sessions.",
  {
    session_id: z.string().describe("Target session ID"),
    text: z.string().describe("Text to inject"),
    from: z.string().optional().describe("Sender session ID (return address)"),
    no_enter: z.boolean().default(false).describe("If true, do not send Enter after text"),
  },
  async ({ session_id, text, from, no_enter }) => {
    try {
      const body = { prompt: text };
      if (from) body.from = from;
      if (no_enter) body.no_enter = true;
      const result = await daemonFetch(`/api/sessions/${encodeURIComponent(session_id)}/inject`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const deliveryInfo = result.deliveryPath ? ` (via ${result.deliveryPath})` : "";
      return { content: [{ type: "text", text: `Injected to ${session_id}${deliveryInfo}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error injecting to ${session_id}: ${err.message}` }], isError: true };
    }
  }
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("telepty MCP server fatal:", err);
  process.exit(1);
});
