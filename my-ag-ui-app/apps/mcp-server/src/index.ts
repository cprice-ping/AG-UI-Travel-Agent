/**
 * Travel MCP Server
 *
 * Implements the MCP Streamable HTTP transport (spec 2025-11-25).
 * Every request is authenticated via a PingOne-issued JWT Bearer token validated
 * against PingOne's JWKS endpoint.
 *
 * Endpoints:
 *   POST   /mcp                               — initiate session / send requests
 *   GET    /mcp                               — SSE stream for server-to-client notifications
 *   DELETE /mcp                               — terminate session
 *   GET    /health                             — liveness check
 *   GET    /.well-known/oauth-protected-resource — RFC 9728 resource metadata (§4.1)
 *
 * 2025-11-25 compliance notes:
 *   §2.0.1 — Origin header validated; returns 403 for unknown browser origins.
 *   §2.7   — MCP-Protocol-Version header validated on established sessions.
 *   §4.2   — WWW-Authenticate includes resource_metadata URL on 401.
 *   §9.2   — Bearer token validated on every request (not session-based auth).
 *   Known limitation: token audience (aud) claim is not validated — the access
 *   token is issued by PingOne to the web-app OAuth client, not directly to this
 *   resource server.  Fixing this requires registering the MCP server as a
 *   separate PingOne resource and having Auth.js request audience-bound tokens.
 */

import "dotenv/config";
import { randomUUID } from "crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const PINGONE_JWKS_URI = process.env.PINGONE_JWKS_URI ?? "";
const PINGONE_ISSUER = process.env.PINGONE_ISSUER ?? "";
const SKIP_AUTH = process.env.SKIP_AUTH === "true"; // allow disabling auth for local dev

/** Public base URL of this server (used in resource metadata and WWW-Authenticate). */
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

/**
 * Comma-separated list of browser origins allowed to connect.
 * Requests from unlisted origins are rejected with 403 (§2.0.1 DNS rebinding protection).
 * Non-browser requests (no Origin header) are always allowed.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Protocol versions this server supports.
 * §2.7: respond 400 to requests advertising an unknown version.
 */
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-03-26"]);

/**
 * Audience expected in the access token (§9.2/§11.8).
 * In PingOne, the custom scope 'mcp:travel_tools' belongs to a Resource whose
 * audience URL is the MCP server's own URL. PingOne puts that Resource audience
 * in the 'aud' claim — not the scope name itself.
 * Defaults to PUBLIC_URL so the two values stay in sync automatically.
 * Set MCP_AUDIENCE= (empty) in .env to disable audience validation.
 */
const MCP_AUDIENCE = process.env.MCP_AUDIENCE !== undefined
  ? process.env.MCP_AUDIENCE
  : PUBLIC_URL;

/** Base URL of the downstream Travel API. */
const API_BASE_URL = (process.env.API_BASE_URL ?? "http://localhost:3200").replace(/\/$/, "");

/** Shared API key sent in X-API-Key header on every API request. */
const API_KEY = process.env.API_KEY ?? "";

// Lazily initialise JWKS set once so the key cache is shared across requests.
let JWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!JWKS) {
    if (!PINGONE_JWKS_URI) throw new Error("PINGONE_JWKS_URI is not set");
    JWKS = createRemoteJWKSet(new URL(PINGONE_JWKS_URI));
  }
  return JWKS;
}

// ─── JWT validation ───────────────────────────────────────────────────────────

/** Claims we log from every incoming token. */
type TokenClaims = {
  sub?: string;
  preferred_username?: string;
  username?: string;
  name?: string;
  email?: string;
  scope?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
};

/**
 * Validates the Bearer token in the Authorization header.
 * On success, returns the decoded claims so callers can log them.
 * On failure, writes the 401 response and returns null.
 */
async function requireAuth(req: Request, res: Response): Promise<TokenClaims | null> {
  if (SKIP_AUTH) {
    console.log("[auth] ⚠️  Auth disabled (SKIP_AUTH=true)");
    return { sub: "skip-auth" };
  }

  const resourceMetadataUrl = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    // §4.2: include resource_metadata so compliant clients can perform discovery.
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${resourceMetadataUrl}"`,
    );
    res.status(401).json({ error: "Missing Bearer token" });
    return null;
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: PINGONE_ISSUER || undefined,
      // §9.2/§11.8: validate aud so tokens issued for other services are rejected.
      // Only enforce when MCP_AUDIENCE is configured.
      ...(MCP_AUDIENCE ? { audience: MCP_AUDIENCE } : {}),
    });

    // Decode all claims for logging (jwtVerify already verified signature).
    const claims = decodeJwt(token) as TokenClaims;
    const displayName =
      claims.preferred_username ?? claims.username ?? claims.name ?? claims.email ?? claims.sub ?? "unknown";
    const expiry = claims.exp ? new Date(claims.exp * 1000).toISOString() : "unknown";
    const scopes = claims.scope ?? (payload.scope as string | undefined) ?? "";
    const aud = Array.isArray(claims.aud) ? claims.aud.join(", ") : (claims.aud ?? "none");

    console.log(
      `[auth] ✅  Token valid | sub=${claims.sub} | user=${displayName} | aud=[${aud}] | scopes=[${scopes}] | expires=${expiry}`,
    );

    return claims;
  } catch (err) {
    console.error("[auth] ❌  JWT validation failed:", (err as Error).message);
    const resourceMetadataUrl = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;
    res.setHeader(
      "WWW-Authenticate",
      `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`,
    );
    res.status(401).json({ error: "Invalid or expired token" });
    return null;
  }
}

// ─── API client helper ────────────────────────────────────────────────────────

/**
 * Calls a downstream Travel API endpoint with the shared API key.
 * TODO: replace X-API-Key with RFC 8693 token exchange once the MCP server has
 * its own PingOne client credentials and the API validates Bearer tokens.
 */
async function apiGet(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${API_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { "X-API-Key": API_KEY },
  });
  if (!res.ok) {
    throw new Error(`API ${path} returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

function registerTravelTools(server: McpServer, claims: TokenClaims) {
  const caller =
    claims.preferred_username ?? claims.username ?? claims.name ?? claims.email ?? claims.sub ?? "unknown";

  function logToolCall(name: string, args: Record<string, unknown>) {
    console.log(`[tool] 🔧  ${name} | caller=${caller} | args=${JSON.stringify(args)}`);
  }

  // ── searchFlights ──────────────────────────────────────────────────────────
  server.registerTool(
    "searchFlights",
    {
      title: "Search Flights",
      description: "Search for available flights between two cities.",
      inputSchema: z.object({
        origin: z.string().describe("Departure city or airport code"),
        destination: z.string().describe("Arrival city or airport code"),
        departureDate: z.string().describe("Departure date in YYYY-MM-DD format"),
      }),
    },
    async ({ origin, destination, departureDate }) => {
      logToolCall("searchFlights", { origin, destination, departureDate });
      const data = await apiGet("/flights", { origin, destination, departureDate });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    },
  );

  // ── searchHotels ───────────────────────────────────────────────────────────
  server.registerTool(
    "searchHotels",
    {
      title: "Search Hotels",
      description: "Search for available hotels in a destination city.",
      inputSchema: z.object({
        destination: z.string().describe("City to search hotels in"),
        checkIn: z.string().describe("Check-in date YYYY-MM-DD"),
        checkOut: z.string().describe("Check-out date YYYY-MM-DD"),
      }),
    },
    async ({ destination, checkIn, checkOut }) => {
      logToolCall("searchHotels", { destination, checkIn, checkOut });
      const data = await apiGet("/hotels", { destination, checkIn, checkOut });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    },
  );

  // ── getDestinationInfo ─────────────────────────────────────────────────────
  server.registerTool(
    "getDestinationInfo",
    {
      title: "Get Destination Info",
      description:
        "Get detailed information about a travel destination including highlights, best time to visit, and practical tips.",
      inputSchema: z.object({
        destination: z.string().describe("City or region to look up"),
      }),
    },
    async ({ destination }) => {
      logToolCall("getDestinationInfo", { destination });
      const data = await apiGet("/destination", { name: destination });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    },
  );

  // ── getWeather ─────────────────────────────────────────────────────────────
  server.registerTool(
    "getWeather",
    {
      title: "Get Weather",
      description: "Get the current weather forecast for a travel destination.",
      inputSchema: z.object({
        location: z.string().describe("City or location to get weather for"),
      }),
    },
    async ({ location }) => {
      logToolCall("getWeather", { location });
      const data = await apiGet("/weather", { location }) as { summary: string };
      return { content: [{ type: "text" as const, text: data.summary ?? JSON.stringify(data) }] };
    },
  );
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

// §2.0.1 — DNS rebinding protection: validate Origin on all browser requests.
// Non-browser (server-to-server) requests omit Origin and are always allowed.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({ error: "Forbidden: Origin not allowed" });
    return;
  }
  next();
});

app.use(
  cors({
    // Reflect the specific requesting origin (or skip if none) rather than wildcard.
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, origin ?? true);
      } else {
        callback(new Error("Origin not allowed"), false);
      }
    },
    exposedHeaders: ["mcp-session-id"],
    allowedHeaders: ["content-type", "mcp-session-id", "authorization", "mcp-protocol-version", "last-event-id"],
  }),
);
app.use(express.json());

// Session store: sessionId → transport
const transports = new Map<string, StreamableHTTPServerTransport>();

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: transports.size });
});

// ── GET /.well-known/oauth-protected-resource — RFC 9728 §3 (spec §4.1) ──────
// Allows MCP clients to discover the authorization server via standardised
// metadata discovery, as required by the 2025-11-25 spec.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: PINGONE_ISSUER ? [PINGONE_ISSUER] : [],
    scopes_supported: ["openid", "profile", "email", "mcp:travel_tools"],
    bearer_methods_supported: ["header"],
  });
});

// ── POST /mcp — client initiates or continues a session ─────────────────────
app.post("/mcp", async (req: Request, res: Response) => {
  const claims = await requireAuth(req, res);
  if (!claims) return;

  // §2.7 — Validate MCP-Protocol-Version on established sessions.
  // New sessions (no mcp-session-id) are the initialize exchange; version header
  // is not yet available there.  Absent header on existing sessions is accepted
  // for backward compat (treated as 2025-03-26 per spec).
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const protocolVersion = req.headers["mcp-protocol-version"] as string | undefined;
  if (sessionId && protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) {
    res.status(400).json({
      error: `Unsupported MCP-Protocol-Version: ${protocolVersion}. Supported: ${[...SUPPORTED_PROTOCOL_VERSIONS].join(", ")}`,
    });
    return;
  }

  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    // New session
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
        console.log(`[MCP] Session started: ${id} (total: ${transports.size})`);
      },
    });

    // NOTE: Do NOT delete the session from the map on transport.onclose.
    // In Streamable HTTP the GET SSE stream is ephemeral — the client closes
    // it after receiving the initial response, then continues sending tool
    // calls via POST with the same session-id.  Evicting the session here
    // would force a brand-new session (and a new auth round-trip) for every
    // tool call.  Explicit cleanup is handled by the DELETE /mcp handler.

    const server = new McpServer({ name: "travel-mcp-server", version: "1.0.0" });
    registerTravelTools(server, claims);
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// ── GET /mcp — SSE stream for server-initiated notifications ─────────────────
app.get("/mcp", async (req: Request, res: Response) => {
  const claims = await requireAuth(req, res);
  if (!claims) return;

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "mcp-session-id header required" });
    return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  await transport.handleRequest(req, res);
});

// ── DELETE /mcp — client terminates a session ────────────────────────────────
app.delete("/mcp", async (req: Request, res: Response) => {
  const claims = await requireAuth(req, res);
  if (!claims) return;

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "mcp-session-id header required" });
    return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  await transport.handleRequest(req, res);
  transports.delete(sessionId);
  console.log(`[MCP] Session deleted: ${sessionId}`);
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────

const httpServer = app.listen(PORT, () => {
  console.log(`✅  Travel MCP Server listening at http://localhost:${PORT}/mcp`);
  if (SKIP_AUTH) {
    console.warn("⚠️  Auth is DISABLED (SKIP_AUTH=true). Do not use in production.");
  } else {
    console.log(`🔐  JWT issuer:   ${PINGONE_ISSUER}`);
    console.log(`🔑  JWKS URI:     ${PINGONE_JWKS_URI}`);
  }
});

process.on("SIGINT", async () => {
  console.log("\n[MCP] Shutting down...");
  httpServer.close();
  for (const [id, transport] of transports) {
    await transport.close();
    transports.delete(id);
  }
  process.exit(0);
});
