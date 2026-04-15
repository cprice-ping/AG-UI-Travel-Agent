/**
 * Travel Agent - powered by Gemini via LangChain.
 * Helps users plan trips with destinations, itineraries, flights, hotels and weather.
 */

import { z } from "zod";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  convertActionsToDynamicStructuredTools,
  CopilotKitStateAnnotation,
} from "@copilotkit/sdk-js/langgraph";
import { Annotation } from "@langchain/langgraph";

// ─── State shape ────────────────────────────────────────────────────────────

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
});

export type AgentState = typeof AgentStateAnnotation.State;

// ─── Tools ──────────────────────────────────────────────────────────────────

const searchFlights = tool(
  (args) => {
    const mockFlights: FlightResult[] = [
      {
        airline: "SkyJet Airways",
        flightNumber: `SJ${Math.floor(Math.random() * 900) + 100}`,
        departure: `${args.departureDate} 08:30`,
        arrival: `${args.departureDate} 14:45`,
        price: Math.floor(Math.random() * 400) + 250,
        duration: "6h 15m",
      },
      {
        airline: "Global Connect",
        flightNumber: `GC${Math.floor(Math.random() * 900) + 100}`,
        departure: `${args.departureDate} 13:00`,
        arrival: `${args.departureDate} 19:20`,
        price: Math.floor(Math.random() * 300) + 180,
        duration: "6h 20m",
      },
      {
        airline: "AirVoyage",
        flightNumber: `AV${Math.floor(Math.random() * 900) + 100}`,
        departure: `${args.departureDate} 21:15`,
        arrival: `${args.departureDate} 03:30+1`,
        price: Math.floor(Math.random() * 200) + 150,
        duration: "6h 15m",
      },
    ];
    return JSON.stringify(mockFlights);
  },
  {
    name: "searchFlights",
    description: "Search for available flights between two cities.",
    schema: z.object({
      origin: z.string().describe("Departure city or airport code"),
      destination: z.string().describe("Arrival city or airport code"),
      departureDate: z.string().describe("Departure date in YYYY-MM-DD format"),
    }),
  },
);

const searchHotels = tool(
  (args) => {
    const mockHotels: HotelResult[] = [
      {
        name: `The Grand ${args.destination} Hotel`,
        stars: 5,
        pricePerNight: Math.floor(Math.random() * 200) + 200,
        amenities: ["Pool", "Spa", "Restaurant", "Gym", "Free WiFi"],
        location: `Central ${args.destination}`,
      },
      {
        name: `${args.destination} Boutique Inn`,
        stars: 4,
        pricePerNight: Math.floor(Math.random() * 100) + 100,
        amenities: ["Breakfast included", "Free WiFi", "Bar"],
        location: `Old Town ${args.destination}`,
      },
      {
        name: `Budget Stay ${args.destination}`,
        stars: 3,
        pricePerNight: Math.floor(Math.random() * 60) + 50,
        amenities: ["Free WiFi", "24h Reception"],
        location: `${args.destination} City Centre`,
      },
    ];
    return JSON.stringify(mockHotels);
  },
  {
    name: "searchHotels",
    description: "Search for available hotels in a destination.",
    schema: z.object({
      destination: z.string().describe("The city or destination to search hotels in"),
      checkIn: z.string().describe("Check-in date in YYYY-MM-DD format"),
      checkOut: z.string().describe("Check-out date in YYYY-MM-DD format"),
    }),
  },
);

const getDestinationInfo = tool(
  (args) => {
    const destinationData: Record<string, { description: string; highlights: string[]; bestTime: string; currency: string; language: string }> = {
      paris: {
        description: "The City of Light, known for art, fashion, gastronomy and culture.",
        highlights: ["Eiffel Tower", "Louvre Museum", "Notre-Dame Cathedral", "Montmartre", "Seine River Cruises"],
        bestTime: "April–June and September–November",
        currency: "Euro (EUR)",
        language: "French",
      },
      tokyo: {
        description: "A mesmerizing blend of ultramodern and traditional, from neon-lit skyscrapers to historic temples.",
        highlights: ["Shibuya Crossing", "Senso-ji Temple", "Tsukiji Fish Market", "Harajuku", "Mount Fuji Day Trip"],
        bestTime: "March–May (cherry blossom) and September–November",
        currency: "Japanese Yen (JPY)",
        language: "Japanese",
      },
      bali: {
        description: "An Indonesian island paradise with terraced rice paddies, volcanic mountains, and beautiful beaches.",
        highlights: ["Uluwatu Temple", "Tegallalang Rice Terraces", "Sacred Monkey Forest", "Seminyak Beach", "Ubud Arts Village"],
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
    };

    const key = args.destination.toLowerCase();
    const info = Object.entries(destinationData).find(([k]) => key.includes(k));

    if (info) {
      return JSON.stringify({ destination: args.destination, ...info[1] });
    }

    return JSON.stringify({
      destination: args.destination,
      description: `${args.destination} is a wonderful travel destination with rich culture and unique experiences.`,
      highlights: ["Local cuisine", "Cultural sites", "Natural scenery", "Shopping", "Nightlife"],
      bestTime: "Spring or Autumn for mild weather",
      currency: "Local currency",
      language: "Local language",
    });
  },
  {
    name: "getDestinationInfo",
    description: "Get detailed information about a travel destination including highlights, best time to visit, and practical tips.",
    schema: z.object({
      destination: z.string().describe("The destination city or region to get information about"),
    }),
  },
);

const getWeather = tool(
  (args) => {
    const conditions = ["Sunny ☀️", "Partly cloudy ⛅", "Warm and clear 🌤️", "Mild with light breeze 🌬️"];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];
    const temp = Math.floor(Math.random() * 15) + 18;
    return `Weather in ${args.location}: ${condition}, ${temp}°C (${Math.round(temp * 9/5 + 32)}°F). Humidity: ${Math.floor(Math.random() * 30) + 40}%. Perfect for exploring!`;
  },
  {
    name: "getWeather",
    description: "Get the current weather forecast for a travel destination.",
    schema: z.object({
      location: z.string().describe("The city or location to get weather for"),
    }),
  },
);

const tools = [searchFlights, searchHotels, getDestinationInfo, getWeather];

// ─── Chat node ───────────────────────────────────────────────────────────────

async function chat_node(state: AgentState, config: RunnableConfig) {
  const model = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    temperature: 0.7,
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  });

  const modelWithTools = model.bindTools!([
    ...convertActionsToDynamicStructuredTools(state.copilotkit?.actions ?? []),
    ...tools,
  ]);

  const travelContext = `
Current travel plan:
- Destinations: ${JSON.stringify(state.destinations ?? [])}
- Travel dates: ${JSON.stringify(state.travelDates ?? {})}
- Budget: ${JSON.stringify(state.budget ?? {})}
- Itinerary days: ${(state.itinerary ?? []).length}
`.trim();

  const systemMessage = new SystemMessage({
    content: `You are an expert AI travel agent with access to both backend tools and frontend actions.

BACKEND TOOLS (call these to fetch data — results show as UI cards automatically):
- getDestinationInfo(destination)
- searchFlights(origin, destination, departureDate)
- searchHotels(destination, checkIn, checkOut)
- getWeather(location)

FRONTEND ACTIONS (call these to update the live travel dashboard on the left):
- addDestination(name, country, description, emoji) — adds a destination card
- setTravelDates(start, end) — sets trip dates in YYYY-MM-DD format
- addItineraryDay(date, destination, activities[]) — adds a day to the itinerary
  Each activity must have: time (HH:MM), name, description, estimatedCost (number),
  and type — which MUST be one of: sightseeing, food, adventure, culture, relaxation, transport
- updateBudget(total, currency, spent) — updates the budget tracker

RULES — follow these strictly:
1. When a destination is confirmed, ALWAYS call addDestination AND setTravelDates immediately.
2. When building an itinerary, call addItineraryDay for EACH day.
3. When tool results (flights, hotels, weather) appear as UI cards, do NOT repeat their content in your text reply. Say something brief like "Here are some options!" instead.
4. Keep chat replies short and conversational.
5. Always suggest 1-2 hidden gems alongside famous attractions.

${travelContext}`,
  });

  const response = await modelWithTools.invoke(
    [systemMessage, ...state.messages],
    config,
  );

  return { messages: response };
}

// ─── Routing ─────────────────────────────────────────────────────────────────

function shouldContinue({ messages, copilotkit }: AgentState) {
  const lastMessage = messages[messages.length - 1] as AIMessage;

  if (lastMessage.tool_calls?.length) {
    const actions = copilotkit?.actions;
    const toolCallName = lastMessage.tool_calls![0].name;

    if (!actions || actions.every((action) => action.name !== toolCallName)) {
      return "tool_node";
    }
  }

  return "__end__";
}

// ─── Graph ───────────────────────────────────────────────────────────────────

const workflow = new StateGraph(AgentStateAnnotation)
  .addNode("chat_node", chat_node)
  .addNode("tool_node", new ToolNode(tools))
  .addEdge(START, "chat_node")
  .addEdge("tool_node", "chat_node")
  .addConditionalEdges("chat_node", shouldContinue as any);

const memory = new MemorySaver();

export const graph = workflow.compile({
  checkpointer: memory,
});
