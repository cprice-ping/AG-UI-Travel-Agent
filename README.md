# AG-UI Travel Agent

An AI travel planning assistant built on [AG-UI](https://docs.ag-ui.com) / [CopilotKit](https://copilotkit.ai) + [LangGraph](https://www.langchain.com/langgraph) + [MCP](https://modelcontextprotocol.io).

Demonstrates how user identity and OAuth tokens flow securely through an agentic architecture using **RFC 8693 Token Exchange** — the browser never holds tokens that can call MCP tools directly.

---

## Architecture

```
Browser
│
│  Next.js Web App  (port 3000)
│  ├─ CopilotKit sidebar (chat UI)
│  ├─ Travel dashboard (destinations, itinerary, cards)
│  ├─ PingOne login popup → Auth.js session
│  └─ Passes person token (subject_token) to agent via useCoAgent state
│
└──[AG-UI / CopilotKit protocol]──▶
                                    LangGraph Agent  (port 8123)
                                    ├─ Gemini 2.5 Flash (thinkingBudget: 2048)
                                    ├─ Holds own client credentials (never in browser)
                                    ├─ RFC 8693 Token Exchange: person token + CC token → per-server MCP token
                                    └──[MCP Streamable HTTP, Bearer: <mcp-token>]──▶

                                    ┌─────────────────────┐   ┌────────────────────────┐
                                    │  Travel MCP Server  │   │  Weather MCP Server    │
                                    │  (port 3100)        │   │  (port 3150)           │
                                    │                     │   │                        │
                                    │  searchFlights      │   │  getWeather            │
                                    │  searchHotels       │   │    └─ Open-Meteo API   │
                                    │  getDestinationInfo │   │  getCurrentDateTime    │
                                    │                     │   │                        │
                                    │  JWT: PingOne JWKS  │   │  JWT: PingOne JWKS     │
                                    │  aud: resource URL  │   │  aud: resource URL     │
                                    └──────────┬──────────┘   └────────────────────────┘
                                               │ X-API-Key
                                               ▼
                                    Travel REST API  (port 3200, internal only)
```

### Token architecture — RFC 8693 Token Exchange

```
1. User logs in via PingOne popup (1st-party, implied consent)
   → Auth.js issues person token
     aud   = api.pingone.com  (standard PingOne OIDC audience)
     scope = openid profile email  (identity only, no MCP scopes)

2. Person token passed to Agent via CopilotKit/AG-UI state
   (subject_token — proves WHO the user is)

3. Agent holds its own client credentials (server-side only)
   → Fetches CC token from PingOne (actor_token)

4. Before each MCP call, Agent performs Token Exchange:
   subject_token  = person token       (WHO — from browser)
   actor_token    = agent CC token     (WHICH component — never leaves agent)
   audience       = MCP server URL     (WHICH server)
   → TX token:  aud=<server>, act={sub: agent-client-id}, sub=<user>

PingOne maps the requested audience → Resource → sets aud on the TX token.
Security: stealing the person token is not enough to call MCP tools —
the agent's client secret (held server-side) is also required.
```

---

## Project structure

```
├── apps/
│   ├── web/             # Next.js frontend (port 3000)
│   ├── agent/           # LangGraph JS agent (port 8123)
│   ├── mcp-server/      # Travel MCP server — flights, hotels, destinations (port 3100)
│   ├── weather-server/  # Weather MCP server — weather + datetime tools (port 3150)
│   └── api/             # Travel REST API — data backend for mcp-server (port 3200, internal)
├── docker/              # Dockerfiles for all services
├── docker-compose.yml           # Full stack
├── docker-compose.gateway.yml   # Overlay: adds PingGateway between Agent and MCP servers
├── .env.example         # Single config file — copy to .env and fill in
└── fixtures/            # Test fixtures for e2e smoke tests
```

---

## Prerequisites

- Docker + Docker Compose
- PingOne tenant configured (see PingOne setup below)
- Gemini API key ([aistudio.google.com](https://aistudio.google.com/app/apikey))

---

## Quick start

### 1. Configure

```bash
cp .env.example .env
```

Edit `.env` — the file is split into sections:

| Section | What to fill in |
|---|---|
| `OIDC_*` | PingOne environment ID → issuer/JWKS/token endpoint URLs |
| `AUTH_CLIENT_ID/SECRET` | PingOne app with Authorization Code + PKCE grant |
| `AUTH_SECRET` | Random string: `openssl rand -base64 32` |
| `AGENT_CLIENT_ID/SECRET` | PingOne app with Client Credentials + Token Exchange grants |
| `GEMINI_API_KEY` | Google AI Studio key |
| `TRAVEL/WEATHER_SERVER_AUDIENCE` | Must match Resource URL registered in PingOne |

### 2. Start

```bash
docker compose up --build
```

Open http://localhost:3000, click **Login with PingOne**, then start chatting.

### 3. With PingGateway (optional)

Inserts PingGateway between the Agent and MCP servers. You provide the gateway route config.

```bash
docker compose -f docker-compose.yml -f docker-compose.gateway.yml up --build
```

The overlay overrides `MCP_SERVERS` on the agent to route through `http://pinggateway:8080/travel/mcp` and `/weather/mcp`. Set `PINGGATEWAY_CONFIG_DIR` in `.env` to point at your config directory.

---

## PingOne setup

You need three things in your PingOne environment:

### 1. Web application (Authorization Code + PKCE)

- Grant type: Authorization Code + PKCE
- Redirect URI: `http://localhost:3000/api/auth/callback/pingone`
- → `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` in `.env`

### 2. Agent application (Client Credentials + Token Exchange)

- Grant types: Client Credentials, Token Exchange
- → `AGENT_CLIENT_ID` / `AGENT_CLIENT_SECRET` in `.env`

### 3. Two PingOne Resources (one per MCP server)

Each Resource represents an MCP server's audience:

| Resource | Audience URL | Scope |
|---|---|---|
| Travel MCP | `http://localhost:3100` | `mcp:travel_tools` |
| Weather MCP | `http://localhost:3150` | `mcp:weather_tools` |

- Assign both scopes to the Agent application
- Set `TRAVEL_SERVER_AUDIENCE` / `WEATHER_SERVER_AUDIENCE` in `.env` to match the audience URLs exactly


---

## MCP server compliance

Both MCP servers implement the MCP Streamable HTTP spec (2025-11-25):

| Requirement | Implementation |
|---|---|
| §2.0.1 Origin validation | 403 for unlisted browser origins |
| §2.7 MCP-Protocol-Version | 400 for unsupported versions |
| §4.1 Protected Resource Metadata | `GET /.well-known/oauth-protected-resource` |
| §4.2 WWW-Authenticate | `Bearer resource_metadata=...` on all 401s |
| §9.2 Bearer token validation | PingOne JWKS + issuer + audience check |

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, Tailwind CSS, CopilotKit |
| Auth | Auth.js v5 (beta), PingOne OIDC |
| Token security | RFC 8693 Token Exchange (1st-party, implied consent) |
| Agent | LangGraph JS, `@langchain/google-genai` (Gemini 2.5 Flash) |
| MCP transport | `@modelcontextprotocol/sdk` Streamable HTTP |
| JWT validation | `jose` (JWKS, issuer, audience) |
| Weather data | Open-Meteo (free, no API key) |
| Monorepo | Turborepo + pnpm workspaces |
| Deployment | Docker Compose (with optional PingGateway overlay) |
