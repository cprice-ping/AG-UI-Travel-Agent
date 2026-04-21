/**
 * Weather MCP Server
 *
 * Exposes two tools:
 *   - getWeather         — real current conditions via Open-Meteo (free, no API key)
 *   - getCurrentDateTime — pure JS UTC clock; grounds the agent for relative dates
 *
 * Implements MCP Streamable HTTP transport (spec 2025-11-25) with PingOne JWT auth.
 *
 * Endpoints:
 *   POST   /mcp                                   — initiate session / send requests
 *   GET    /mcp                                   — SSE stream for server notifications
 *   DELETE /mcp                                   — terminate session
 *   GET    /health                                — liveness check
 *   GET    /.well-known/oauth-protected-resource  — RFC 9728 resource metadata
 */

import "dotenv/config";
import { randomUUID } from "crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3150", 10);
const PINGONE_JWKS_URI = process.env.PINGONE_JWKS_URI ?? "";
const PINGONE_ISSUER = process.env.PINGONE_ISSUER ?? "";
const SKIP_AUTH = process.env.SKIP_AUTH === "true";

/** Public base URL of this server (used in resource metadata and WWW-Authenticate). */
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-03-26"]);

const MCP_AUDIENCE = process.env.MCP_AUDIENCE !== undefined
  ? process.env.MCP_AUDIENCE
  : PUBLIC_URL;

// ─── JWKS / JWT ───────────────────────────────────────────────────────────────

let JWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!JWKS) {
    if (!PINGONE_JWKS_URI) throw new Error("PINGONE_JWKS_URI is not set");
    JWKS = createRemoteJWKSet(new URL(PINGONE_JWKS_URI));
  }
  return JWKS;
}

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

async function requireAuth(req: Request, res: Response): Promise<TokenClaims | null> {
  if (SKIP_AUTH) {
    console.log("[auth] ⚠️  Auth disabled (SKIP_AUTH=true)");
    return { sub: "skip-auth" };
  }

  const resourceMetadataUrl = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
    res.status(401).json({ error: "Missing Bearer token" });
    return null;
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: PINGONE_ISSUER || undefined,
      ...(MCP_AUDIENCE ? { audience: MCP_AUDIENCE } : {}),
    });
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
    res.setHeader(
      "WWW-Authenticate",
      `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`,
    );
    res.status(401).json({ error: "Invalid or expired token" });
    return null;
  }
}

// ─── Open-Meteo weather helper ────────────────────────────────────────────────

// WMO weather interpretation codes → human-readable condition + emoji
// https://open-meteo.com/en/docs#weathervariables
const WMO_CONDITIONS: Record<number, { label: string; emoji: string }> = {
  0:  { label: "Clear sky",              emoji: "☀️"  },
  1:  { label: "Mainly clear",           emoji: "🌤️" },
  2:  { label: "Partly cloudy",          emoji: "⛅"  },
  3:  { label: "Overcast",               emoji: "☁️"  },
  45: { label: "Foggy",                  emoji: "🌫️" },
  48: { label: "Icy fog",                emoji: "🌫️" },
  51: { label: "Light drizzle",          emoji: "🌦️" },
  53: { label: "Drizzle",                emoji: "🌦️" },
  55: { label: "Heavy drizzle",          emoji: "🌧️" },
  61: { label: "Light rain",             emoji: "🌧️" },
  63: { label: "Rain",                   emoji: "🌧️" },
  65: { label: "Heavy rain",             emoji: "🌧️" },
  71: { label: "Light snow",             emoji: "🌨️" },
  73: { label: "Snow",                   emoji: "❄️"  },
  75: { label: "Heavy snow",             emoji: "❄️"  },
  77: { label: "Snow grains",            emoji: "🌨️" },
  80: { label: "Light showers",          emoji: "🌦️" },
  81: { label: "Showers",               emoji: "🌧️" },
  82: { label: "Heavy showers",          emoji: "🌧️" },
  85: { label: "Snow showers",           emoji: "🌨️" },
  86: { label: "Heavy snow showers",     emoji: "❄️"  },
  95: { label: "Thunderstorm",           emoji: "⛈️"  },
  96: { label: "Thunderstorm with hail", emoji: "⛈️"  },
  99: { label: "Thunderstorm with hail", emoji: "⛈️"  },
};

async function fetchWeather(location: string) {
  // 1. Geocode city name → lat/lon using Open-Meteo's free geocoding API
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
  );
  if (!geoRes.ok) throw new Error(`Geocoding failed: ${geoRes.status}`);
  const geoData = await geoRes.json() as {
    results?: { latitude: number; longitude: number; name: string; country: string; timezone: string }[];
  };
  if (!geoData.results?.length) throw new Error(`Location not found: ${location}`);
  const { latitude, longitude, name, country, timezone } = geoData.results[0];

  // 2. Fetch current weather from Open-Meteo (free, no API key)
  const wxRes = await fetch(
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&temperature_unit=celsius&wind_speed_unit=kmh&timezone=${encodeURIComponent(timezone)}`,
  );
  if (!wxRes.ok) throw new Error(`Weather fetch failed: ${wxRes.status}`);
  const wxData = await wxRes.json() as {
    current: {
      temperature_2m: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
      weather_code: number;
      wind_speed_10m: number;
      time: string;
    };
  };

  const cur = wxData.current;
  const wmo = WMO_CONDITIONS[cur.weather_code] ?? { label: "Unknown", emoji: "🌡️" };
  const tempC = Math.round(cur.temperature_2m);
  const tempF = Math.round(tempC * 9 / 5 + 32);
  const feelsC = Math.round(cur.apparent_temperature);
  const feelsF = Math.round(feelsC * 9 / 5 + 32);

  return {
    location: `${name}, ${country}`,
    condition: `${wmo.emoji} ${wmo.label}`,
    temperatureC: tempC,
    temperatureF: tempF,
    feelsLikeC: feelsC,
    feelsLikeF: feelsF,
    humidity: cur.relative_humidity_2m,
    windSpeedKmh: Math.round(cur.wind_speed_10m),
    observedAt: cur.time,
    source: "Open-Meteo (open-meteo.com)",
    summary: `${wmo.emoji} ${name}: ${wmo.label}, ${tempC}°C (${tempF}°F), feels like ${feelsC}°C. Humidity ${cur.relative_humidity_2m}%, wind ${Math.round(cur.wind_speed_10m)} km/h.`,
  };
}

// ─── Tool registration ────────────────────────────────────────────────────────

function registerWeatherTools(server: McpServer, claims: TokenClaims) {
  const caller =
    claims.preferred_username ?? claims.username ?? claims.name ?? claims.email ?? claims.sub ?? "unknown";

  function logToolCall(name: string, args: Record<string, unknown>) {
    console.log(`[tool] 🔧  ${name} | caller=${caller} | args=${JSON.stringify(args)}`);
  }

  // ── getWeather ─────────────────────────────────────────────────────────────
  server.registerTool(
    "getWeather",
    {
      title: "Get Weather",
      description:
        "Get real current weather conditions for any location using Open-Meteo. " +
        "Returns temperature (°C/°F), feels-like, humidity, wind speed, and condition.",
      inputSchema: z.object({
        location: z.string().describe("City or location name, e.g. 'Seattle' or 'Paris, France'"),
      }),
    },
    async ({ location }) => {
      logToolCall("getWeather", { location });
      try {
        const data = await fetchWeather(location);
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // ── getCurrentDateTime ─────────────────────────────────────────────────────
  server.registerTool(
    "getCurrentDateTime",
    {
      title: "Get Current Date & Time",
      description:
        "Returns the current UTC date, time, day of week, and month. " +
        "Call this first whenever the user mentions relative dates like 'today', 'tomorrow', " +
        "'next week', 'in 3 months', etc. so you can resolve them to exact YYYY-MM-DD values.",
      inputSchema: z.object({}),
    },
    async () => {
      logToolCall("getCurrentDateTime", {});
      const now = new Date();
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
      ];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            isoDate: now.toISOString().slice(0, 10),       // e.g. "2026-04-16"
            isoTime: now.toISOString().slice(11, 19) + "Z", // e.g. "14:32:07Z" (UTC)
            dayOfWeek: dayNames[now.getUTCDay()],
            month: monthNames[now.getUTCMonth()],
            year: now.getUTCFullYear(),
            hint: "All dates are UTC. To compute relative dates: tomorrow = isoDate + 1 day, " +
                  "'in 3 months' = isoDate + 3 calendar months, etc.",
          }),
        }],
      };
    },
  );
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

// §2.0.1 — DNS rebinding protection
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

const transports = new Map<string, StreamableHTTPServerTransport>();

app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: transports.size });
});

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: PINGONE_ISSUER ? [PINGONE_ISSUER] : [],
    scopes_supported: ["openid", "profile", "email", "mcp:weather_tools"],
    bearer_methods_supported: ["header"],
  });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const claims = await requireAuth(req, res);
  if (!claims) return;

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
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
        console.log(`[MCP] Session started: ${id} (total: ${transports.size})`);
      },
    });
    const server = new McpServer({ name: "weather-mcp-server", version: "1.0.0" });
    registerWeatherTools(server, claims);
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req: Request, res: Response) => {
  const claims = await requireAuth(req, res);
  if (!claims) return;

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) { res.status(400).json({ error: "mcp-session-id header required" }); return; }

  const transport = transports.get(sessionId);
  if (!transport) { res.status(404).json({ error: "Session not found" }); return; }

  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const claims = await requireAuth(req, res);
  if (!claims) return;

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) { res.status(400).json({ error: "mcp-session-id header required" }); return; }

  const transport = transports.get(sessionId);
  if (!transport) { res.status(404).json({ error: "Session not found" }); return; }

  await transport.handleRequest(req, res);
  transports.delete(sessionId);
  console.log(`[MCP] Session deleted: ${sessionId}`);
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────

const httpServer = app.listen(PORT, () => {
  console.log(`✅  Weather MCP Server listening at http://localhost:${PORT}/mcp`);
  if (SKIP_AUTH) {
    console.warn("⚠️  Auth is DISABLED (SKIP_AUTH=true). Do not use in production.");
  } else {
    console.log(`🔐  JWT issuer:  ${PINGONE_ISSUER}`);
    console.log(`🔑  JWKS URI:    ${PINGONE_JWKS_URI}`);
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
