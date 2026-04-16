/**
 * Travel Agent - powered by Gemini via LangChain.
 * Helps users plan trips with destinations, itineraries, flights, hotels and weather.
 *
 * Tools are served by external MCP servers (HTTP Streaming transport).
 * Each invocation authenticates using a per-server PingOne access token stored
 * in agent state, forwarded as a Bearer token to the relevant MCP server.
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
   * Per-server PingOne access tokens, keyed by server name matching MCP_SERVERS.
   * e.g. { travel: "eyJ...", weather: "eyJ..." }
   * The frontend acquires each token via the appropriate PingOne scope and syncs
   * it here.  Only servers with a non-empty token will be connected.
   */
  userTokens: Annotation<Record<string, string>>,
});

export type AgentState = typeof AgentStateAnnotation.State;

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
 * Creates a short-lived MCP client connecting to every server that has a token.
 * Servers without a token in the map are skipped entirely.
 * The caller is responsible for calling client.close() when done.
 */
function createMcpClient(tokens: Record<string, string>): MultiServerMCPClient {
  const mcpServers: Record<string, {
    url: string;
    headers: Record<string, string>;
    automaticSSEFallback: boolean;
  }> = {};
  for (const [name, url] of Object.entries(MCP_SERVERS)) {
    const token = tokens[name];
    if (token) {
      mcpServers[name] = {
        url,
        headers: { Authorization: `Bearer ${token}` },
        // Our servers speak Streamable HTTP natively — no SSE fallback needed.
        automaticSSEFallback: false,
      };
    }
  }
  return new MultiServerMCPClient({
    mcpServers,
    onConnectionError: "throw",
  });
}

// ─── Tool schema cache ───────────────────────────────────────────────────────

/** Cached tool schemas keyed by Bearer token. Tools contain only schema info
 * used for model binding — execution always goes through mcp_tool_node which
 * creates its own fresh connection. */
const toolsCache = new Map<string, {
  tools: Awaited<ReturnType<MultiServerMCPClient["getTools"]>>;
  expiresAt: number;
}>();

const TOOLS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Stable cache key derived from the token map (sorted by server name). */
function tokensKey(tokens: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(tokens)
        .filter(([, v]) => Boolean(v))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

/**
 * Returns MCP tool schemas for the given token map, reusing a cached result
 * when available. On cache miss, opens a short-lived connection, fetches the
 * list, then closes it — so chat_node never holds a persistent session.
 */
async function getCachedMcpTools(
  tokens: Record<string, string>,
): Promise<Awaited<ReturnType<MultiServerMCPClient["getTools"]>>> {
  const key = tokensKey(tokens);
  const cached = toolsCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.tools;
  }
  const client = createMcpClient(tokens);
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
  // Only contact MCP servers that have a token in state.
  let mcpTools: Awaited<ReturnType<MultiServerMCPClient["getTools"]>> = [];
  const tokens = state.userTokens ?? {};
  const isAuthenticated = Object.values(tokens).some(Boolean);

  if (isAuthenticated) {
    try {
      mcpTools = await getCachedMcpTools(tokens);
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
3. Tool results appear as UI cards — do NOT repeat their content in text.
4. Keep replies short and conversational.

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
  const tokens = state.userTokens ?? {};
  if (!Object.values(tokens).some(Boolean)) {
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

  const mcpClient = createMcpClient(tokens);
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
