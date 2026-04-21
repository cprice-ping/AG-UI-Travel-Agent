# AG-UI Travel Agent

An AI travel planning assistant built on [AG-UI](https://docs.ag-ui.com) / [CopilotKit](https://copilotkit.ai) + [LangGraph](https://www.langchain.com/langgraph) + [MCP](https://modelcontextprotocol.io), exploring how user identity and OAuth tokens flow through an agentic architecture.

The agent calls real MCP servers over HTTP (spec 2025-11-25), authenticated with PingOne-issued Bearer tokens.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Next.js Web App  (port 3000)                        │   │
│  │                                                      │   │
│  │  • CopilotKit sidebar (chat UI)                      │   │
│  │  • Travel dashboard (destinations, itinerary, cards) │   │
│  │  • PingOne login popup → Auth.js session             │   │
│  │  • Passes userTokens: { travel, weather } to agent   │   │
│  └────────────────────────┬─────────────────────────────┘   │
└───────────────────────────│─────────────────────────────────┘
                            │ AG-UI / CopilotKit protocol
                            ▼
┌───────────────────────────────────────────────────────────────┐
│  LangGraph Agent  (port 8123)                                 │
│                                                               │
│  • Gemini Pro model (thinkingBudget: 2048)                    │
│  • Receives userTokens from frontend state                    │
│  • Connects to each MCP server using its per-server token     │
│  • Calls frontend actions (addDestination, addItineraryDay…)  │
│  • Tool schema cache keyed by token map                       │
└──────────┬────────────────────────────┬───────────────────────┘
           │ MCP Streamable HTTP         │ MCP Streamable HTTP
           │ Bearer: <travel token>      │ Bearer: <weather token>
           │ aud: localhost:3100         │ aud: localhost:3150
           ▼                            ▼
┌──────────────────────┐   ┌──────────────────────────────────┐
│  Travel MCP Server   │   │  Weather MCP Server              │
│  (port 3100)         │   │  (port 3150)                     │
│                      │   │                                  │
│  Tools:              │   │  Tools:                          │
│  • searchFlights     │   │  • getWeather                    │
│  • searchHotels      │   │    └─ Open-Meteo geocoding API   │
│  • getDestinationInfo│   │       + forecast API (free)      │
│                      │   │  • getCurrentDateTime            │
│  JWT auth: PingOne   │   │    └─ pure JS, no API call       │
│  aud: PUBLIC_URL     │   │                                  │
│                      │   │  JWT auth: PingOne               │
└──────────┬───────────┘   │  aud: PUBLIC_URL                 │
           │ X-API-Key     └──────────────────────────────────┘
           ▼
┌──────────────────────┐
│  Travel REST API     │
│  (port 3200)         │
│                      │
│  GET /flights        │
│  GET /hotels         │
│  GET /destination    │
│  GET /weather *      │
│  GET /health         │
│                      │
│  * weather route     │
│  still present but   │
│  not used by agent   │
└──────────────────────┘
```

### Auth flow

```
User clicks "Login with PingOne"
         │
         ▼
PingOne authorization endpoint
  scope=openid profile email mcp:travel_tools
  resource=http://localhost:3100   (travel MCP server audience)
         │
         ▼ access token  aud: "http://localhost:3100"
Auth.js session (Next.js)
         │
         ├─── userTokens.travel  ──▶  Travel MCP Server  (aud validated ✓)
         │
         └─── userTokens.weather ──▶  Weather MCP Server (aud: localhost:3150 ✗)
                                       currently uses same token — see note below
```

> **Open issue — multi-server audience**: The MCP spec §9.2 requires the Bearer token `aud` to match each server's identity. With two MCP servers, a correctly-issued token for server A will fail `aud` validation on server B. Options explored in this project:
> - **RFC 8707 Resource Indicators** — request both audiences at authorization time (correct, requires AS support)
> - **RFC 8693 Token Exchange** — exchange user token for a server-scoped token (breaks the consent chain)
> - **Shared audience** — both servers accept the same `MCP_AUDIENCE` value (demo shortcut, weakens isolation)
>
> For local development, set `MCP_AUDIENCE=http://localhost:3100` in `apps/weather-server/.env` to use the shared-audience approach.

---

## Project Structure

```
my-ag-ui-app/
├── apps/
│   ├── web/             # Next.js frontend (port 3000)
│   ├── agent/           # LangGraph agent (port 8123)
│   ├── mcp-server/      # Travel MCP server — flights, hotels, destinations (port 3100)
│   ├── weather-server/  # Weather MCP server — weather + datetime tools (port 3150)
│   └── api/             # Travel REST API — data backend for mcp-server (port 3200)
├── pnpm-workspace.yaml
└── turbo.json
```

---

## Prerequisites

- Node.js 18+
- pnpm 9.15.0+
- PingOne tenant (for OIDC login and JWT validation)
- Gemini API key

---

## Setup

### 1. Install dependencies

```bash
cd my-ag-ui-app
pnpm install
```

### 2. Configure each service

**`apps/agent/.env`**
```env
GEMINI_API_KEY=...
MCP_SERVERS={"travel":"http://localhost:3100/mcp","weather":"http://localhost:3150/mcp"}
```

**`apps/mcp-server/.env`** (copy from `.env.example`)
```env
PORT=3100
PINGONE_ISSUER=https://auth.pingone.com/<ENV_ID>/as
PINGONE_JWKS_URI=https://auth.pingone.com/<ENV_ID>/as/jwks
PUBLIC_URL=http://localhost:3100
ALLOWED_ORIGINS=http://localhost:3000
API_BASE_URL=http://localhost:3200
API_KEY=dev-travel-api-key-change-in-production
```

**`apps/weather-server/.env`** (copy from `.env.example`)
```env
PORT=3150
PINGONE_ISSUER=https://auth.pingone.com/<ENV_ID>/as
PINGONE_JWKS_URI=https://auth.pingone.com/<ENV_ID>/as/jwks
PUBLIC_URL=http://localhost:3150
ALLOWED_ORIGINS=http://localhost:3000
# For local dev with a single PingOne token — see multi-server auth note above
MCP_AUDIENCE=http://localhost:3100
```

**`apps/api/.env`**
```env
PORT=3200
API_KEY=dev-travel-api-key-change-in-production
```

**`apps/web/.env.local`**
```env
AUTH_SECRET=...
AUTH_PINGONE_ID=...            # PingOne application client ID
AUTH_PINGONE_SECRET=...        # PingOne application client secret
AUTH_PINGONE_ISSUER=https://auth.pingone.com/<ENV_ID>/as
NEXT_PUBLIC_COPILOTKIT_URL=http://localhost:8123
```

### 3. Start all services

Each service needs its own terminal:

```bash
# Terminal 1 — Travel REST API
cd apps/api && pnpm dev

# Terminal 2 — Travel MCP Server
cd apps/mcp-server && pnpm dev

# Terminal 3 — Weather MCP Server
cd apps/weather-server && pnpm dev

# Terminal 4 — LangGraph Agent
cd apps/agent && npx @langchain/langgraph-cli@latest dev --port 8123 --no-browser

# Terminal 5 — Next.js Web App
cd apps/web && pnpm dev
```

Then open http://localhost:3000, log in with PingOne, and start chatting.

---

## MCP Server compliance

Both MCP servers implement spec 2025-11-25:

| Requirement | Implementation |
|---|---|
| §2.0.1 Origin validation | 403 for unlisted browser origins |
| §2.7 MCP-Protocol-Version | 400 for unsupported versions on established sessions |
| §4.1 Protected Resource Metadata | `GET /.well-known/oauth-protected-resource` |
| §4.2 WWW-Authenticate | `Bearer resource_metadata=...` on all 401s |
| §9.2 Bearer token validation | PingOne JWKS + issuer + audience |

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15, Tailwind CSS, CopilotKit |
| Auth | Auth.js v5 (beta), PingOne OIDC |
| Agent | LangGraph, `@langchain/google-genai` (Gemini) |
| MCP transport | `@modelcontextprotocol/sdk` Streamable HTTP |
| JWT validation | `jose` |
| Weather data | Open-Meteo (free, no API key) |
| Monorepo | Turborepo + pnpm workspaces |
