/**
 * Travel MCP Server
 *
 * Exposes 4 travel tools via the MCP Streamable HTTP transport (2025-03-26 spec).
 * Every request is authenticated via a PingOne-issued JWT Bearer token validated
 * against PingOne's JWKS endpoint.
 *
 * Endpoints:
 *   POST   /mcp   — initiate session / send requests
 *   GET    /mcp   — SSE stream for server-to-client notifications
 *   DELETE /mcp   — terminate session
 *   GET    /health — liveness check
 */

import "dotenv/config";
import { randomUUID } from "crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const PINGONE_JWKS_URI = process.env.PINGONE_JWKS_URI ?? "";
const PINGONE_ISSUER = process.env.PINGONE_ISSUER ?? "";
const SKIP_AUTH = process.env.SKIP_AUTH === "true"; // allow disabling auth for local dev

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

async function requireAuth(req: Request, res: Response): Promise<boolean> {
  if (SKIP_AUTH) return true;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return false;
  }

  const token = authHeader.slice(7);
  try {
    await jwtVerify(token, getJWKS(), {
      issuer: PINGONE_ISSUER || undefined,
    });
    return true;
  } catch (err) {
    console.error("JWT validation failed:", (err as Error).message);
    res.status(401).json({ error: "Invalid or expired token" });
    return false;
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

function registerTravelTools(server: McpServer) {
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
      const flights = [
        {
          airline: "SkyJet Airways",
          flightNumber: `SJ${Math.floor(Math.random() * 900) + 100}`,
          departure: `${departureDate} 08:30`,
          arrival: `${departureDate} 14:45`,
          price: Math.floor(Math.random() * 400) + 250,
          duration: "6h 15m",
          origin,
          destination,
        },
        {
          airline: "Global Connect",
          flightNumber: `GC${Math.floor(Math.random() * 900) + 100}`,
          departure: `${departureDate} 13:00`,
          arrival: `${departureDate} 19:20`,
          price: Math.floor(Math.random() * 300) + 180,
          duration: "6h 20m",
          origin,
          destination,
        },
        {
          airline: "AirVoyage",
          flightNumber: `AV${Math.floor(Math.random() * 900) + 100}`,
          departure: `${departureDate} 21:15`,
          arrival: `${departureDate} 03:30+1`,
          price: Math.floor(Math.random() * 200) + 150,
          duration: "6h 15m",
          origin,
          destination,
        },
      ];
      return { content: [{ type: "text" as const, text: JSON.stringify(flights) }] };
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
      const hotels = [
        {
          name: `The Grand ${destination} Hotel`,
          stars: 5,
          pricePerNight: Math.floor(Math.random() * 200) + 200,
          amenities: ["Pool", "Spa", "Restaurant", "Gym", "Free WiFi"],
          location: `Central ${destination}`,
          checkIn,
          checkOut,
        },
        {
          name: `${destination} Boutique Inn`,
          stars: 4,
          pricePerNight: Math.floor(Math.random() * 100) + 100,
          amenities: ["Breakfast included", "Free WiFi", "Bar"],
          location: `Old Town ${destination}`,
          checkIn,
          checkOut,
        },
        {
          name: `Budget Stay ${destination}`,
          stars: 3,
          pricePerNight: Math.floor(Math.random() * 60) + 50,
          amenities: ["Free WiFi", "24h Reception"],
          location: `${destination} City Centre`,
          checkIn,
          checkOut,
        },
      ];
      return { content: [{ type: "text" as const, text: JSON.stringify(hotels) }] };
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
      const knownDestinations: Record<
        string,
        { description: string; highlights: string[]; bestTime: string; currency: string; language: string }
      > = {
        paris: {
          description: "The City of Light, known for art, fashion, gastronomy and culture.",
          highlights: ["Eiffel Tower", "Louvre Museum", "Notre-Dame Cathedral", "Montmartre", "Seine River Cruises"],
          bestTime: "April–June and September–November",
          currency: "Euro (EUR)",
          language: "French",
        },
        tokyo: {
          description:
            "A mesmerising blend of ultramodern and traditional, from neon-lit skyscrapers to historic temples.",
          highlights: [
            "Shibuya Crossing",
            "Senso-ji Temple",
            "Tsukiji Fish Market",
            "Harajuku",
            "Mount Fuji Day Trip",
          ],
          bestTime: "March–May (cherry blossom) and September–November",
          currency: "Japanese Yen (JPY)",
          language: "Japanese",
        },
        bali: {
          description:
            "An Indonesian island paradise with terraced rice paddies, volcanic mountains, and beautiful beaches.",
          highlights: [
            "Uluwatu Temple",
            "Tegallalang Rice Terraces",
            "Sacred Monkey Forest",
            "Seminyak Beach",
            "Ubud Arts Village",
          ],
          bestTime: "April–October (dry season)",
          currency: "Indonesian Rupiah (IDR)",
          language: "Balinese / Indonesian",
        },
        barcelona: {
          description: "A vibrant coastal city bursting with Modernista architecture, beaches, and world-class cuisine.",
          highlights: ["Sagrada Família", "Park Güell", "La Rambla", "Gothic Quarter", "Camp Nou"],
          bestTime: "May–June and September–October",
          currency: "Euro (EUR)",
          language: "Catalan / Spanish",
        },
        "new york": {
          description: "The city that never sleeps — a global hub for finance, art, fashion, and food.",
          highlights: ["Central Park", "Metropolitan Museum", "Times Square", "Brooklyn Bridge", "High Line"],
          bestTime: "April–June and September–November",
          currency: "US Dollar (USD)",
          language: "English",
        },
      };

      const key = destination.toLowerCase();
      const match = Object.entries(knownDestinations).find(([k]) => key.includes(k));
      const info = match
        ? { destination, ...match[1] }
        : {
            destination,
            description: `${destination} is a wonderful travel destination with rich culture and unique experiences.`,
            highlights: ["Local cuisine", "Cultural sites", "Natural scenery", "Shopping", "Nightlife"],
            bestTime: "Spring or Autumn for mild weather",
            currency: "Local currency",
            language: "Local language",
          };

      return { content: [{ type: "text" as const, text: JSON.stringify(info) }] };
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
      const conditions = ["Sunny ☀️", "Partly cloudy ⛅", "Warm and clear 🌤️", "Mild with light breeze 🌬️"];
      const condition = conditions[Math.floor(Math.random() * conditions.length)];
      const tempC = Math.floor(Math.random() * 15) + 18;
      const tempF = Math.round(tempC * 9 / 5 + 32);
      const humidity = Math.floor(Math.random() * 30) + 40;
      const result = `Weather in ${location}: ${condition}, ${tempC}°C (${tempF}°F). Humidity: ${humidity}%. Perfect for exploring!`;
      return { content: [{ type: "text" as const, text: result }] };
    },
  );
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

app.use(
  cors({
    origin: "*", // tighten in production
    exposedHeaders: ["mcp-session-id"],
    allowedHeaders: ["content-type", "mcp-session-id", "authorization"],
  }),
);
app.use(express.json());

// Session store: sessionId → transport
const transports = new Map<string, StreamableHTTPServerTransport>();

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: transports.size });
});

// ── POST /mcp — client initiates or continues a session ─────────────────────
app.post("/mcp", async (req: Request, res: Response) => {
  if (!(await requireAuth(req, res))) return;

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
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

    transport.onclose = () => {
      // Cleaned up via the DELETE handler, but also handle unexpected closes.
      for (const [id, t] of transports) {
        if (t === transport) {
          transports.delete(id);
          console.log(`[MCP] Session closed: ${id}`);
          break;
        }
      }
    };

    const server = new McpServer({ name: "travel-mcp-server", version: "1.0.0" });
    registerTravelTools(server);
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// ── GET /mcp — SSE stream for server-initiated notifications ─────────────────
app.get("/mcp", async (req: Request, res: Response) => {
  if (!(await requireAuth(req, res))) return;

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
  if (!(await requireAuth(req, res))) return;

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
