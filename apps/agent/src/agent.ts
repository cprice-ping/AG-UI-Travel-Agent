/**
 * Travel Agent - powered by Gemini via LangChain.
 * Helps users plan trips with destinations, itineraries, flights, hotels and weather.
 *
 * TOKEN ARCHITECTURE — RFC 8693 Token Exchange
 * ─────────────────────────────────────────────
 * The browser performs plain OIDC login and passes the resulting person token
 * (subject_token) to this Agent via useCoAgent state (userTokens._subject).
 *
 * This Agent holds its own PingOne client credentials (AGENT_CLIENT_ID /
 * AGENT_CLIENT_SECRET) and independently fetches a client_credentials token
 * (actor_token) at startup. This token is cached for its lifetime.
 *
 * Before connecting to each MCP server, the Agent performs RFC 8693 Token
 * Exchange to produce a short-lived MCP-scoped token:
 *   subject_token      = person token   (WHO — identity delegation from user)
 *   actor_token        = agent CC token (WHICH component — server-side only)
 *   audience           = MCP server URL (scopes aud to that specific server)
 *   requested_token_type = access_token
 * → MCP token: aud=<server-url>, act=<agent-client-id>, sub=<user>
 *
 * Security property: stealing the person token from the browser does NOT
 * grant MCP access — the agent CC token (held only server-side) is also
 * required to complete the exchange. Neither token alone is sufficient.
 *
 * MCP tool exchange tokens are cached per (subject_token, server) pair with
 * a TTL slightly shorter than PingOne's token lifetime.
 */

import { RunnableConfig } from "@langchain/core/runnables";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import {
  convertActionsToDynamicStructuredTools,
  CopilotKitStateAnnotation,
} from "@copilotkit/sdk-js/langgraph";
import { Annotation } from "@langchain/langgraph";

// ─── Token logging helper ────────────────────────────────────────────────────

/**
 * Decode and log the public claims of a JWT for debugging.
 * Never logs the raw token — only the decoded payload (which is not secret;
 * JWTs are base64url-encoded, not encrypted).
 */
function logTokenClaims(label: string, jwt: string): void {
  try {
    const payloadB64 = jwt.split(".")[1];
    if (!payloadB64) return;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;
    const aud = Array.isArray(payload.aud) ? payload.aud.join(", ") : (payload.aud ?? "—");
    const act = payload.act ? JSON.stringify(payload.act) : "—";
    const exp = payload.exp ? new Date((payload.exp as number) * 1000).toISOString() : "—";
    const scopes = (payload.scope as string | undefined) ?? "—";
    console.log(
      `[token] ${label}\n` +
      `        sub=${payload.sub ?? "—"} | aud=[${aud}] | act=${act}\n` +
      `        scope=[${scopes}] | expires=${exp}`,
    );
  } catch {
    console.log(`[token] ${label} — could not decode (opaque token?)`);
  }
}

// ─── State shape ─────────────────────────────────────────────────────────────

export type Destination = {
  name: string;
  country: string;
  description: string;
  emoji: string;
};

export type Activity = {
  time: string;
  name: string;
  description: string;
  type: "sightseeing" | "food" | "adventure" | "culture" | "relaxation" | "transport";
  estimatedCost: number;
};

export type ItineraryDay = {
  date: string;
  destination: string;
  activities: Activity[];
};

export type Budget = {
  total: number;
  currency: string;
  spent: number;
};

export type TravelDates = {
  start: string;
  end: string;
};

export type FlightResult = {
  airline: string;
  flightNumber: string;
  departure: string;
  arrival: string;
  price: number;
  duration: string;
};

export type HotelResult = {
  name: string;
  stars: number;
  pricePerNight: number;
  amenities: string[];
  location: string;
};

const AgentStateAnnotation = Annotation.Root({
  ...CopilotKitStateAnnotation.spec,
  destinations: Annotation<Destination[]>,
  itinerary: Annotation<ItineraryDay[]>,
  budget: Annotation<Budget>,
  travelDates: Annotation<TravelDates>,
  flightResults: Annotation<FlightResult[]>,
  hotelResults: Annotation<HotelResult[]>,
  /**
   * Person token (RFC 8693 subject_token) from the browser's OIDC session.
   * Keyed as "_subject" — the Agent uses it as input to Token Exchange,
   * not directly as a Bearer token to any MCP server.
   */
  userTokens: Annotation<Record<string, string>>,
});

export type AgentState = typeof AgentStateAnnotation.State;

// ─── PingOne config ───────────────────────────────────────────────────────────

const PINGONE_TOKEN_ENDPOINT = (process.env.PINGONE_TOKEN_ENDPOINT ?? "").replace(/\/$/, "");
const AGENT_CLIENT_ID = process.env.AGENT_CLIENT_ID ?? "";
const AGENT_CLIENT_SECRET = process.env.AGENT_CLIENT_SECRET ?? "";

// ─── Agent client_credentials token ──────────────────────────────────────────

/**
 * The Agent's own OAuth token — the RFC 8693 actor_token.
 * Obtained once at startup via client_credentials grant and cached until expiry.
 * Never sent to the browser. Only used server-side as part of Token Exchange.
 */
let agentTokenCache: { token: string; expiresAt: number } | null = null;

async function getAgentToken(): Promise<string> {
  if (agentTokenCache && Date.now() < agentTokenCache.expiresAt) {
    return agentTokenCache.token;
  }
  if (!PINGONE_TOKEN_ENDPOINT || !AGENT_CLIENT_ID || !AGENT_CLIENT_SECRET) {
    throw new Error(
      "[agent] PINGONE_TOKEN_ENDPOINT, AGENT_CLIENT_ID, AGENT_CLIENT_SECRET must all be set",
    );
  }
  const resp = await fetch(PINGONE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: AGENT_CLIENT_ID,
      client_secret: AGENT_CLIENT_SECRET,
      // Request all MCP scopes the agent is authorised to act on.
      // PingOne requires at least one scope on a CC grant.
      scope: process.env.AGENT_CC_SCOPE ?? "mcp:travel_tools mcp:weather_tools",
    }),
  });
  if (!resp.ok) {
    throw new Error(`[agent] client_credentials failed: ${await resp.text()}`);
  }
  const data = await resp.json() as { access_token: string; expires_in?: number };
  const ttl = (data.expires_in ?? 300) * 1000;
  // Cache with a 30s buffer so we don't use an about-to-expire token.
  agentTokenCache = { token: data.access_token, expiresAt: Date.now() + ttl - 30_000 };
  console.log("[agent] ✅ Agent client_credentials token acquired");
  logTokenClaims("actor_token (agent CC)", data.access_token);
  return data.access_token;
}

// ─── RFC 8693 Token Exchange ──────────────────────────────────────────────────

/**
 * Exchange cache: keyed by (subject_token_prefix + server_url) to avoid
 * repeated exchanges for the same user+server within a short window.
 * Uses first 16 chars of subject_token as a stable key fragment (not sensitive —
 * JWT headers are public; we never log or expose the key itself).
 */
const exchangeCache = new Map<string, { token: string; expiresAt: number }>();
const EXCHANGE_TTL_MS = 4 * 60 * 1000; // 4 minutes (conservative vs PingOne's 5m default)

/**
 * Performs RFC 8693 Token Exchange to obtain a short-lived MCP server token.
 *
 * PingOne requirements:
 *   - The Agent application must have Token Exchange grant enabled in PingOne
 *   - The subject_token's aud must match the Agent resource (AUTH_AGENT_RESOURCE)
 *   - The audience parameter must be a registered PingOne Resource URL
 *
 * The resulting token has:
 *   aud = serverUrl  (only valid for this specific MCP server)
 *   sub = user sub   (delegated user identity)
 *   act = { sub: AGENT_CLIENT_ID }  (proves which component performed the exchange)
 */
async function exchangeForMcpToken(
  subjectToken: string,
  actorToken: string,
  serverUrl: string,
): Promise<string> {
  // Use first 16 chars of subject token as cache key fragment (JWT header is public)
  const audience = serverUrl.replace(/\/mcp$/, "");
  const cacheKey = `${subjectToken.slice(0, 16)}::${serverUrl}`;
  const cached = exchangeCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    console.log(`[token] exchange cache HIT for ${serverUrl}`);
    return cached.token;
  }

  console.log(`[token] exchange MISS — performing RFC 8693 Token Exchange`);
  console.log(`[token]   audience=${audience}`);
  logTokenClaims("subject_token (person, input)", subjectToken);
  logTokenClaims("actor_token (agent CC, input)", actorToken);

  const resp = await fetch(PINGONE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: AGENT_CLIENT_ID,
      client_secret: AGENT_CLIENT_SECRET,
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      actor_token: actorToken,
      actor_token_type: "urn:ietf:params:oauth:token-type:access_token",
      // audience = the MCP server's registered resource URL in PingOne
      // PingOne will set aud = this value on the issued token
      audience,
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`[agent] Token Exchange failed for ${serverUrl}: ${body}`);
  }

  const data = await resp.json() as { access_token: string; expires_in?: number };
  const ttl = Math.min((data.expires_in ?? 300) * 1000, EXCHANGE_TTL_MS);
  exchangeCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + ttl });
  console.log(`[agent] ✅ MCP token exchanged for ${serverUrl}`);
  logTokenClaims(`mcp_token (output, aud=${audience})`, data.access_token);
  return data.access_token;
}

// ─── MCP server config ───────────────────────────────────────────────────────

/**
 * MCP server registry — a map of server name → URL.
 * Configure via MCP_SERVERS env var as JSON:
 *   MCP_SERVERS={"travel":"http://localhost:3100/mcp","weather":"http://localhost:3200/mcp"}
 * Falls back to MCP_SERVER_URL for single-server backward compatibility.
 */
function parseMcpServers(): Record<string, string> {
  const raw = process.env.MCP_SERVERS;
  if (raw) {
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      console.error("[agent] Failed to parse MCP_SERVERS env var — falling back to MCP_SERVER_URL");
    }
  }
  return { travel: process.env.MCP_SERVER_URL ?? "http://localhost:3100/mcp" };
}

const MCP_SERVERS = parseMcpServers();

// ─── MCP client factory ───────────────────────────────────────────────────────

/**
 * Creates a short-lived MCP client by performing Token Exchange for each server.
 *
 * subjectToken = person token from browser (userTokens._subject)
 * For each MCP server: exchange(subject, actor) → per-server MCP token → Bearer header
 *
 * Servers are skipped if Token Exchange fails (logged, not thrown) so a single
 * unavailable server doesn't block the others.
 * The caller is responsible for calling client.close() when done.
 */
async function createMcpClient(subjectToken: string): Promise<MultiServerMCPClient> {
  console.log(`[agent] createMcpClient — ${Object.keys(MCP_SERVERS).length} server(s): ${Object.keys(MCP_SERVERS).join(", ")}`);
  logTokenClaims("subject_token (person, from state)", subjectToken);
  const actorToken = await getAgentToken();

  const mcpServers: Record<string, {
    url: string;
    headers: Record<string, string>;
    automaticSSEFallback: boolean;
  }> = {};

  await Promise.all(
    Object.entries(MCP_SERVERS).map(async ([name, url]) => {
      try {
        const mcpToken = await exchangeForMcpToken(subjectToken, actorToken, url);
        mcpServers[name] = {
          url,
          headers: { Authorization: `Bearer ${mcpToken}` },
          automaticSSEFallback: false,
        };
        console.log(`[agent] ✅ ${name} → Bearer mcp_token ready`);
      } catch (err) {
        console.error(`[agent] ❌ Skipping ${name}: ${(err as Error).message}`);
      }
    }),
  );

  const connected = Object.keys(mcpServers);
  console.log(`[agent] MCP client ready — connected: [${connected.join(", ") || "none"}]`);

  return new MultiServerMCPClient({
    mcpServers,
    onConnectionError: "throw",
  });
}

// ─── Tool schema cache ───────────────────────────────────────────────────────

/** Cached tool schemas keyed by subject token prefix. Tools contain only schema
 * info used for model binding — execution always goes through mcp_tool_node which
 * creates its own fresh connection with freshly-exchanged tokens. */
const toolsCache = new Map<string, {
  tools: Awaited<ReturnType<MultiServerMCPClient["getTools"]>>;
  expiresAt: number;
}>();

const TOOLS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Returns MCP tool schemas for the given subject token, reusing a cached result
 * when available. On cache miss, performs Token Exchange, opens a short-lived
 * connection, fetches the list, then closes it.
 */
async function getCachedMcpTools(
  subjectToken: string,
): Promise<Awaited<ReturnType<MultiServerMCPClient["getTools"]>>> {
  // Use first 16 chars of subject token as cache key (JWT header is public)
  const key = subjectToken.slice(0, 16);
  const cached = toolsCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.tools;
  }
  const client = await createMcpClient(subjectToken);
  try {
    const tools = await client.getTools();
    toolsCache.set(key, { tools, expiresAt: Date.now() + TOOLS_CACHE_TTL_MS });
    return tools;
  } finally {
    await client.close();
  }
}

// ─── Chat node ───────────────────────────────────────────────────────────────

async function chat_node(state: AgentState, config: RunnableConfig) {
  // _subject = person token (RFC 8693 subject_token) from browser OIDC session.
  // Non-empty means the user is logged in; Agent will Token Exchange it per server.
  let mcpTools: Awaited<ReturnType<MultiServerMCPClient["getTools"]>> = [];
  const subjectToken = (state.userTokens ?? {})["_subject"] ?? "";
  const isAuthenticated = Boolean(subjectToken);

  if (isAuthenticated) {
    try {
      mcpTools = await getCachedMcpTools(subjectToken);
    } catch (err) {
      console.error("[agent] MCP tool load failed:", (err as Error).message);
    }
  }

  const model = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    temperature: 0.7,
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    // Allow a moderate thinking budget so the model can reason about when to
    // call tools. Budget 0 disabled tool selection reasoning entirely.
    // The original 'parts' crash was caused by very large thinking responses;
    // capping at 2048 keeps thinking tokens small enough to avoid it.
    thinkingConfig: { thinkingBudget: 2048 },
  });

  const allTools = [
    ...convertActionsToDynamicStructuredTools(state.copilotkit?.actions ?? []),
    ...mcpTools,
  ];

  const modelWithTools = model.bindTools!(allTools);

  const travelContext = `
Current travel plan:
- Destinations: ${JSON.stringify(state.destinations ?? [])}
- Travel dates: ${JSON.stringify(state.travelDates ?? {})}
- Budget: ${JSON.stringify(state.budget ?? {})}
- Itinerary days: ${(state.itinerary ?? []).length}
`.trim();

  // Derive the backend tools section from actual loaded tools so the prompt
  // stays accurate when servers are added/removed without editing this file.
  const backendToolsSection = isAuthenticated && mcpTools.length > 0
    ? `BACKEND TOOLS — call these to fetch live data (results appear as UI cards):\n${mcpTools.map((t) => `- ${t.name}`).join("\n")}`
    : `BACKEND TOOLS — NOT available. The user is not logged in.
Do NOT answer flight, hotel, or weather queries from memory.
Instead, tell the user: "Please log in with PingOne to enable live travel search."\nYou may still help with general destination advice.`;

  const systemMessage = new SystemMessage({
    content: `You are an expert AI travel agent.

${backendToolsSection}

FRONTEND ACTIONS (call these to update the live travel dashboard on the left):
- addDestination(name, country, description, emoji)
- setTravelDates(start, end) — YYYY-MM-DD format
- addItineraryDay(date, destination, activities[])
  Each activity: time (HH:MM), name, description, estimatedCost (number),
  type — MUST be one of: sightseeing, food, adventure, culture, relaxation, transport
- updateBudget(total, currency, spent)

RULES:
1. When a destination is confirmed, call addDestination AND setTravelDates immediately.
2. When building an itinerary, call addItineraryDay for EACH day.
3. After calling getWeather, searchFlights, searchHotels, or getDestinationInfo, do NOT describe
   the results in your text reply — a structured UI card is shown to the user automatically.
   Acknowledge briefly (e.g. "Here's the weather in Seattle:" or "I found some flights for you:")
   then stop. Do not restate temperatures, prices, flight numbers, or other data from the result.
4. Keep replies short and conversational.
5. Whenever the user mentions a relative date ("today", "tomorrow", "next Friday", "in 3 months",
   "next summer", etc.), call getCurrentDateTime FIRST to get today's date, then compute the
   exact YYYY-MM-DD before calling any search tools.

${travelContext}`,
  });

  let response;
  try {
    response = await modelWithTools.invoke(
      [systemMessage, ...state.messages],
      config,
    );
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // Gemini 2.5 Flash thinking chunks occasionally have empty `parts` arrays
    // that @langchain/google-genai 2.1.27 can't handle. Retry once with
    // thinking disabled as a fallback.
    if (msg.includes("parts")) {
      console.warn("[agent] Thinking chunk error — retrying with thinkingBudget:0");
      const fallbackModel = new ChatGoogleGenerativeAI({
        model: "gemini-2.5-flash",
        temperature: 0.7,
        apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
        thinkingConfig: { thinkingBudget: 0 },
      });
      const fallbackWithTools = fallbackModel.bindTools!(allTools);
      response = await fallbackWithTools.invoke(
        [systemMessage, ...state.messages],
        config,
      );
    } else {
      throw err;
    }
  }

  return { messages: response };
}

// ─── MCP tool node ────────────────────────────────────────────────────────────

/**
 * Custom tool node that initialises the MCP client per invocation so it can
 * pass the current user's Bearer token on every tool call.
 */
async function mcp_tool_node(state: AgentState, config: RunnableConfig) {
  const subjectToken = (state.userTokens ?? {})["_subject"] ?? "";
  if (!subjectToken) {
    // Guard: should not reach here unauthenticated, but return an error message
    // as a ToolMessage so the agent can surface it to the user.
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    const toolCallId = lastMessage.tool_calls?.[0]?.id ?? "unknown";
    const { ToolMessage } = await import("@langchain/core/messages");
    return {
      messages: [
        new ToolMessage({
          tool_call_id: toolCallId,
          content: "Authentication required. Please log in with PingOne to use this tool.",
        }),
      ],
    };
  }

  // Perform Token Exchange for each server, then execute the tool call.
  const mcpClient = await createMcpClient(subjectToken);
  try {
    const mcpTools = await mcpClient.getTools();
    const toolNode = new ToolNode(mcpTools);
    return await toolNode.invoke(state, config);
  } finally {
    await mcpClient.close();
  }
}

// ─── Routing ─────────────────────────────────────────────────────────────────

function shouldContinue({ messages, copilotkit }: AgentState) {
  const lastMessage = messages[messages.length - 1] as AIMessage;

  if (lastMessage.tool_calls?.length) {
    const actions = copilotkit?.actions;
    const toolCallName = lastMessage.tool_calls![0].name;

    // If the tool call is NOT a frontend CopilotKit action → send to MCP tool node
    if (!actions || actions.every((action: { name: string }) => action.name !== toolCallName)) {
      return "mcp_tool_node";
    }
  }

  return "__end__";
}

// ─── Graph ───────────────────────────────────────────────────────────────────

const workflow = new StateGraph(AgentStateAnnotation)
  .addNode("chat_node", chat_node)
  .addNode("mcp_tool_node", mcp_tool_node)
  .addEdge(START, "chat_node")
  .addEdge("mcp_tool_node", "chat_node")
  .addConditionalEdges("chat_node", shouldContinue as any);

const memory = new MemorySaver();

export const graph = workflow.compile({
  checkpointer: memory,
});
