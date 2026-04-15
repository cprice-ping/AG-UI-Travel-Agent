/**
 * Travel Agent - powered by Gemini via LangChain.
 * Helps users plan trips with destinations, itineraries, flights, hotels and weather.
 *
 * Tools are served by an external MCP server (HTTP Streaming transport).
 * Each invocation authenticates using the PingOne access token stored in
 * the agent state, forwarded as a Bearer token to the MCP server.
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
  /** PingOne access token forwarded from the browser session (set by the frontend). */
  userToken: Annotation<string>,
});

export type AgentState = typeof AgentStateAnnotation.State;

// ─── MCP client factory ───────────────────────────────────────────────────────

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:3100/mcp";

/**
 * Creates a short-lived MCP client authenticated with the supplied Bearer token.
 * The caller is responsible for calling client.close() when done.
 */
function createMcpClient(token?: string): MultiServerMCPClient {
  return new MultiServerMCPClient({
    mcpServers: {
      travel: {
        url: MCP_SERVER_URL,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        // Disable SSE fallback — our server speaks Streamable HTTP natively.
        automaticSSEFallback: false,
      },
    },
    onConnectionError: "ignore", // degrade gracefully if MCP server is unavailable
  });
}

// ─── Chat node ───────────────────────────────────────────────────────────────

async function chat_node(state: AgentState, config: RunnableConfig) {
  const mcpClient = createMcpClient(state.userToken);
  let mcpTools: Awaited<ReturnType<MultiServerMCPClient["getTools"]>> = [];

  try {
    mcpTools = await mcpClient.getTools();
  } catch (err) {
    console.warn("[agent] MCP server unavailable — proceeding without tools:", (err as Error).message);
  }

  const model = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    temperature: 0.7,
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
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
${state.userToken ? "- Authenticated: yes (MCP tools available)" : "- Authenticated: no (log in to enable travel search tools)"}
`.trim();

  const systemMessage = new SystemMessage({
    content: `You are an expert AI travel agent with access to both backend tools (via MCP) and frontend actions.

BACKEND TOOLS — served by the MCP server, call these to fetch live data:
- getDestinationInfo(destination)
- searchFlights(origin, destination, departureDate)
- searchHotels(destination, checkIn, checkOut)
- getWeather(location)

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
3. Tool results appear as UI cards — do NOT repeat their content in text. Say "Here are some options!" instead.
4. Keep replies short and conversational.
5. If not authenticated, tell the user to log in to use flight/hotel search.

${travelContext}`,
  });

  const response = await modelWithTools.invoke(
    [systemMessage, ...state.messages],
    config,
  );

  await mcpClient.close();
  return { messages: response };
}

// ─── MCP tool node ────────────────────────────────────────────────────────────

/**
 * Custom tool node that initialises the MCP client per invocation so it can
 * pass the current user's Bearer token on every tool call.
 */
async function mcp_tool_node(state: AgentState, config: RunnableConfig) {
  const mcpClient = createMcpClient(state.userToken);
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
