// ============================================================
// AG-UI Travel Agent — WebSocket + HTTP server
//
// Each browser tab (Flights, Hotels) connects via WebSocket on /ws.
// The tab identifies itself with a SITE_CONNECT message and sends
// its registered tool manifest.  The agent receives USER_MESSAGE
// events from any tab, runs an LLM orchestration loop, and calls
// tools on the appropriate site via TOOL_CALL messages.
//
// Multiple tabs of the same siteLabel (e.g. two Flights tabs) are
// not supported in demo mode — the latest connection wins.
// ============================================================

import { createServer } from "http";
import { WebSocketServer } from "ws";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { handleUserMessage } from "./agent.js";

// ── Express app ───────────────────────────────────────────────
const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGIN || "http://localhost:8080")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// ── Connection registry ───────────────────────────────────────
// siteLabel → { ws, origin, tools: [{ name, description, parameters }] }
export const connections = new Map();

// ── Pending tool calls ────────────────────────────────────────
// toolCallId → { resolve, reject, timer }
const pendingToolCalls = new Map();

const TOOL_CALL_TIMEOUT_MS = 60_000; // user may take time to confirm booking

// ── callSiteTool ──────────────────────────────────────────────
// Sends a TOOL_CALL to the named site and waits for a TOOL_RESULT.
export function callSiteTool(siteLabel, name, args) {
  return new Promise((resolve, reject) => {
    const conn = connections.get(siteLabel);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) {
      reject(new Error(`Site "${siteLabel}" is not connected`));
      return;
    }

    const toolCallId = randomUUID();

    const timer = setTimeout(() => {
      if (pendingToolCalls.has(toolCallId)) {
        pendingToolCalls.delete(toolCallId);
        reject(new Error(`Tool call "${name}" on "${siteLabel}" timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s`));
      }
    }, TOOL_CALL_TIMEOUT_MS);

    pendingToolCalls.set(toolCallId, { resolve, reject, timer });

    conn.ws.send(
      JSON.stringify({ type: "TOOL_CALL", toolCallId, name, arguments: JSON.stringify(args) }),
      (err) => {
        if (err) {
          clearTimeout(timer);
          pendingToolCalls.delete(toolCallId);
          reject(new Error(`Send failed for tool "${name}": ${err.message}`));
        }
      }
    );
  });
}

// ── broadcast ─────────────────────────────────────────────────
// Sends a message to every currently connected site tab.
export function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const { ws } of connections.values()) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// ── WebSocket server ──────────────────────────────────────────
const server = createServer(app);
const wss    = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://x");

  if (pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  // Origin check for WS upgrades
  const origin = req.headers.origin ?? "";
  if (origin && !allowedOrigins.includes(origin)) {
    console.warn(`[ws] Rejected WS upgrade from disallowed origin: ${origin}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  let siteLabel = null;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore malformed frames
    }

    switch (msg.type) {
      case "SITE_CONNECT":
        siteLabel = msg.siteLabel;
        connections.set(siteLabel, { ws, origin: msg.origin ?? "", tools: msg.tools ?? [] });
        console.log(
          `[ws] ✓ ${siteLabel} connected from ${msg.origin ?? "(unknown)"}` +
          ` — ${msg.tools?.length ?? 0} tool(s): ${msg.tools?.map((t) => t.name).join(", ") || "(none)"}`
        );
        break;

      case "TOOLS_UPDATE":
        if (siteLabel && connections.has(siteLabel)) {
          connections.get(siteLabel).tools = msg.tools ?? [];
          console.log(
            `[ws] ${siteLabel} tools updated — ` +
            `${msg.tools?.length ?? 0} tool(s): ${msg.tools?.map((t) => t.name).join(", ") || "(none)"}`
          );
        }
        break;

      case "TOOL_RESULT": {
        const pending = pendingToolCalls.get(msg.toolCallId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingToolCalls.delete(msg.toolCallId);
          pending.resolve(msg.content ?? "");
        }
        break;
      }

      case "USER_MESSAGE":
        if (siteLabel && msg.message) {
          console.log(`[ws] USER_MESSAGE from ${siteLabel}: ${String(msg.message).slice(0, 120)}`);
          handleUserMessage(msg.message, siteLabel, { connections, callSiteTool, broadcast }).catch((err) =>
            console.error(`[agent] handleUserMessage error: ${err.message}`)
          );
        }
        break;

      default:
        // Unknown message type — ignore
        break;
    }
  });

  ws.on("close", () => {
    if (siteLabel) {
      connections.delete(siteLabel);
      console.log(`[ws] ${siteLabel} disconnected`);
    }
  });

  ws.on("error", (err) => {
    console.error(`[ws] ${siteLabel ?? "(unknown)"} socket error: ${err.message}`);
  });
});

// ── HTTP: POST /chat ──────────────────────────────────────────
// Accepts a user message (e.g. from a test client or CI). Fires
// the agent turn asynchronously; TEXT_MESSAGE events go over WS.
app.post("/chat", (req, res) => {
  const { message, siteLabel: originSite } = req.body ?? {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: '"message" (string) is required.' });
  }

  // Pick source site: use the provided label, or fall back to the first connected site.
  const origin = originSite && connections.has(originSite)
    ? originSite
    : [...connections.keys()][0] ?? null;

  if (!origin) {
    return res.status(503).json({ error: "No site is currently connected to the agent." });
  }

  res.json({ ok: true, origin, note: "Agent turn started — TEXT_MESSAGE events sent via WebSocket." });

  handleUserMessage(message, origin, { connections, callSiteTool, broadcast }).catch((err) =>
    console.error(`[chat] Agent error: ${err.message}`)
  );
});

// ── HTTP: GET /health ─────────────────────────────────────────
app.get("/health", (_req, res) => {
  const connected = [...connections.entries()].map(([label, c]) => ({
    siteLabel: label,
    origin:    c.origin,
    tools:     c.tools.length,
  }));
  res.json({ ok: true, connected });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`AG-UI Travel Agent listening on :${PORT}`);
  console.log(`  WebSocket path:  ws://localhost:${PORT}/ws`);
  console.log(`  Chat endpoint:   http://localhost:${PORT}/chat`);
  console.log(`  Health probe:    http://localhost:${PORT}/health`);
  console.log(`  Allowed origins: ${allowedOrigins.join(", ")}`);
  console.log(`  LLM model:       ${process.env.LLM_MODEL ?? "gpt-4o (default)"}`);
});
