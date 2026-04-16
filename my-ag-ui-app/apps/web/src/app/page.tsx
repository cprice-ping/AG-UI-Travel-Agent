"use client";

import { useCoAgent, useCopilotAction } from "@copilotkit/react-core";
import { CopilotKitCSSProperties, CopilotSidebar } from "@copilotkit/react-ui";
import { useSession, signOut } from "next-auth/react";
import { useEffect } from "react";

// ─── Types (mirror agent state) ──────────────────────────────────────────────

type Destination = {
  name: string;
  country: string;
  description: string;
  emoji: string;
};

type ActivityType = "sightseeing" | "food" | "adventure" | "culture" | "relaxation" | "transport";

type Activity = {
  time: string;
  name: string;
  description: string;
  type: ActivityType;
  estimatedCost: number;
};

type ItineraryDay = {
  date: string;
  destination: string;
  activities: Activity[];
};

type Budget = {
  total: number;
  currency: string;
  spent: number;
};

type TravelDates = {
  start: string;
  end: string;
};

type FlightResult = {
  airline: string;
  flightNumber: string;
  departure: string;
  arrival: string;
  price: number;
  duration: string;
};

type HotelResult = {
  name: string;
  stars: number;
  pricePerNight: number;
  amenities: string[];
  location: string;
};

type AgentState = {
  destinations: Destination[];
  itinerary: ItineraryDay[];
  budget: Budget;
  travelDates: TravelDates;
  flightResults: FlightResult[];
  hotelResults: HotelResult[];
  /** PingOne Bearer token — forwarded to the MCP server for each tool call. */
  userToken: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParseJSON<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TravelAgentPage() {
  return (
    <main style={{ "--copilot-kit-primary-color": "#0ea5e9" } as CopilotKitCSSProperties}>
      <TravelContent />
      <CopilotSidebar
        clickOutsideToClose={false}
        defaultOpen={true}
        showDevConsole={false}
        labels={{
          title: "✈️ AI Travel Agent",
          initial:
            "Hi! I'm your AI travel agent powered by Gemini.\n\nTell me where you'd like to go and I'll help you plan every detail!\n\nTry:\n- **\"Plan a week in Tokyo\"**\n- **\"Find flights from NYC to Paris in June\"**\n- **\"What's the weather like in Bali?\"**\n- **\"Build me a 5-day Paris itinerary\"**",
        }}
      />
    </main>
  );
}

// ─── Main Content ─────────────────────────────────────────────────────────────

function TravelContent() {
  const { data: session, status: authStatus, update: refreshSession } = useSession();
  const accessToken = (session as { accessToken?: string } | null)?.accessToken ?? "";

  /**
   * Open PingOne login in a centred popup window so the main tab — and all
   * agent state (destinations, itinerary, chat history) — is preserved.
   * After a successful callback, Auth.js redirects the popup to /auth/close,
   * which posts a message back here and calls window.close().
   */
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data === "auth:complete") {
        refreshSession(); // re-fetches the Auth.js session without a page reload
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleLogin() {
    const width = 520;
    const height = 640;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);

    // /auth/signin is an intermediate page that calls signIn() as a POST on
    // mount — window.open() can only do GET, so we can't hit /api/auth/signin
    // directly (Auth.js v5 requires POST for that endpoint).
    // NOTE: do NOT include 'noreferrer' — it sets window.opener=null in the
    // popup, breaking the postMessage back to this tab.
    window.open(
      "/auth/signin",
      "pingone-login",
      `width=${width},height=${height},left=${left},top=${top},popup=1`,
    );
  }

  const { state, setState } = useCoAgent<AgentState>({
    name: "starterAgent",
    initialState: {
      destinations: [],
      itinerary: [],
      budget: { total: 3000, currency: "USD", spent: 0 },
      travelDates: { start: "", end: "" },
      flightResults: [],
      hotelResults: [],
      userToken: accessToken,
    },
  });

  // Sync userToken into agent state whenever the session changes.
  // Must be in useEffect — calling setState in the render body is a React
  // anti-pattern that can cause loops or silently drop the update.
  useEffect(() => {
    setState((prev) => ({ ...prev, userToken: accessToken } as AgentState));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // ── Frontend actions the agent can call ────────────────────────────────────

  useCopilotAction({
    name: "addDestination",
    description: "Add a destination to the travel plan.",
    parameters: [
      { name: "name", type: "string", description: "City name", required: true },
      { name: "country", type: "string", description: "Country", required: true },
      { name: "description", type: "string", description: "Short description", required: true },
      { name: "emoji", type: "string", description: "A relevant emoji for the destination", required: true },
    ],
    handler: ({ name, country, description, emoji }) => {
      setState((prev) => ({
        ...prev,
        destinations: [
          ...(prev?.destinations || []),
          { name, country, description, emoji },
        ],
      }));
    },
    render: () => null,
  });

  useCopilotAction({
    name: "addItineraryDay",
    description: "Add a day with activities to the travel itinerary.",
    parameters: [
      { name: "date", type: "string", description: "Date in YYYY-MM-DD format", required: true },
      { name: "destination", type: "string", description: "City for this day", required: true },
      {
        name: "activities",
        type: "object[]",
        description: "List of activities for the day",
        attributes: [
          { name: "time", type: "string", description: "Time e.g. 09:00" },
          { name: "name", type: "string", description: "Activity name" },
          { name: "description", type: "string", description: "Short description" },
          { name: "type", type: "string", description: "Activity type" },
          { name: "estimatedCost", type: "number", description: "Estimated cost in USD" },
        ],
      },
    ],
    handler: ({ date, destination, activities }) => {
      setState((prev) => ({
        ...prev,
        itinerary: [
          ...(prev?.itinerary || []),
          { date, destination, activities: activities as Activity[] },
        ],
      }));
    },
    render: () => null,
  });

  useCopilotAction({
    name: "setTravelDates",
    description: "Set the travel dates for the trip.",
    parameters: [
      { name: "start", type: "string", description: "Start date YYYY-MM-DD", required: true },
      { name: "end", type: "string", description: "End date YYYY-MM-DD", required: true },
    ],
    handler: ({ start, end }) => {
      setState((prev) => ({ ...prev, travelDates: { start, end } }));
    },
    render: () => null,
  });

  useCopilotAction({
    name: "updateBudget",
    description: "Update the travel budget.",
    parameters: [
      { name: "total", type: "number", description: "Total budget amount", required: true },
      { name: "currency", type: "string", description: "Currency code e.g. USD", required: true },
      { name: "spent", type: "number", description: "Amount already allocated/spent" },
    ],
    handler: ({ total, currency, spent }) => {
      setState((prev) => ({ ...prev, budget: { total, currency, spent: spent ?? 0 } }));
    },
    render: () => null,
  });

  useCopilotAction({
    name: "clearItinerary",
    description: "Clear all destinations and itinerary to start fresh.",
    parameters: [],
    handler: () => {
      setState((prev) => ({
        ...prev,
        destinations: [],
        itinerary: [],
        flightResults: [],
        hotelResults: [],
      }));
    },
    render: () => null,
  });

  // ── Generative UI for tools ────────────────────────────────────────────────

  useCopilotAction({
    name: "searchFlights",
    description: "Search for available flights",
    available: "disabled",
    parameters: [
      { name: "origin", type: "string" },
      { name: "destination", type: "string" },
      { name: "departureDate", type: "string" },
    ],
    render: ({ args, result, status }) => (
      <FlightSearchCard
        origin={args.origin}
        destination={args.destination}
        date={args.departureDate}
        results={safeParseJSON(result, [])}
        isLoading={status === "inProgress"}
      />
    ),
  });

  useCopilotAction({
    name: "searchHotels",
    description: "Search for available hotels",
    available: "disabled",
    parameters: [
      { name: "destination", type: "string" },
      { name: "checkIn", type: "string" },
      { name: "checkOut", type: "string" },
    ],
    render: ({ args, result, status }) => (
      <HotelSearchCard
        destination={args.destination}
        checkIn={args.checkIn}
        checkOut={args.checkOut}
        results={safeParseJSON(result, [])}
        isLoading={status === "inProgress"}
      />
    ),
  });

  useCopilotAction({
    name: "getWeather",
    description: "Get weather for a destination",
    available: "disabled",
    parameters: [{ name: "location", type: "string" }],
    render: ({ args, result, status }) => (
      <WeatherCard
        location={args.location}
        forecast={result || ""}
        isLoading={status === "inProgress"}
      />
    ),
  });

  useCopilotAction({
    name: "getDestinationInfo",
    description: "Get info about a destination",
    available: "disabled",
    parameters: [{ name: "destination", type: "string" }],
    render: ({ args, result, status }) => (
      <DestinationInfoCard
        destination={args.destination}
        info={safeParseJSON(result, null)}
        isLoading={status === "inProgress"}
      />
    ),
  });

  const budgetPercent = state.budget
    ? Math.min(100, Math.round((state.budget.spent / state.budget.total) * 100))
    : 0;

  const totalActivityCost = (state.itinerary || [])
    .flatMap((day) => day.activities || [])
    .reduce((sum, a) => sum + (a.estimatedCost || 0), 0);

  return (
    <div className="h-screen w-screen bg-gradient-to-br from-sky-900 via-sky-800 to-indigo-900 overflow-y-auto">
      {/* Header */}
      <header className="bg-white/10 backdrop-blur-md border-b border-white/20 px-6 py-4 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-3xl">✈️</span>
            <div>
              <h1 className="text-xl font-bold text-white">AI Travel Planner</h1>
              <p className="text-sky-200 text-sm">Powered by Gemini + AG-UI + MCP</p>
            </div>
          </div>

          {/* Right side: budget pill + auth button */}
          <div className="flex items-center gap-3">
            {/* Budget pill */}
            {state.budget && (
              <div className="flex items-center gap-3 bg-white/10 rounded-full px-4 py-2">
                <span className="text-white/70 text-sm">Budget:</span>
                <span className="text-white font-semibold">
                  {state.budget.currency} {state.budget.total.toLocaleString()}
                </span>
                <div className="w-24 h-2 bg-white/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-400 to-sky-400 rounded-full transition-all"
                    style={{ width: `${budgetPercent}%` }}
                  />
                </div>
                <span className="text-white/70 text-sm">
                  {totalActivityCost > 0
                    ? `~${state.budget.currency} ${totalActivityCost} planned`
                    : `${budgetPercent}% allocated`}
                </span>
              </div>
            )}

            {/* Auth button */}
            {authStatus === "loading" ? (
              <div className="w-24 h-9 rounded-full bg-white/10 animate-pulse" />
            ) : session ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 bg-emerald-500/20 border border-emerald-400/40 rounded-full px-3 py-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="text-emerald-200 text-sm font-medium">
                    {(session as { preferredUsername?: string } & typeof session)?.preferredUsername
                      ?? session.user?.name
                      ?? session.user?.email
                      ?? "Logged in"}
                  </span>
                </div>
                <button
                  onClick={() => signOut()}
                  className="text-white/60 hover:text-white text-sm px-3 py-1.5 rounded-full border border-white/20 hover:border-white/40 transition-all"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <button
                onClick={handleLogin}
                className="flex items-center gap-2 bg-sky-500 hover:bg-sky-400 text-white text-sm font-medium px-4 py-2 rounded-full transition-all shadow-lg shadow-sky-500/30"
              >
                <span>🔐</span> Login with PingOne
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* Travel Dates Banner */}
        {state.travelDates?.start && (
          <div className="bg-white/10 backdrop-blur rounded-2xl p-4 flex items-center gap-4 border border-white/20">
            <span className="text-2xl">📅</span>
            <div>
              <p className="text-white font-medium">Travel Period</p>
              <p className="text-sky-200">
                {state.travelDates.start} → {state.travelDates.end}
              </p>
            </div>
          </div>
        )}

        {/* Destinations */}
        {(state.destinations || []).length > 0 && (
          <section>
            <h2 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
              <span>🗺️</span> Your Destinations
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {state.destinations.map((dest, i) => (
                <DestinationCard key={i} destination={dest} />
              ))}
            </div>
          </section>
        )}

        {/* Itinerary */}
        {(state.itinerary || []).length > 0 && (
          <section>
            <h2 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
              <span>📋</span> Your Itinerary
            </h2>
            <div className="space-y-4">
              {state.itinerary.map((day, i) => (
                <ItineraryDayCard key={i} day={day} dayNumber={i + 1} />
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {(state.destinations || []).length === 0 && (state.itinerary || []).length === 0 && (
          <div className="text-center py-20">
            <div className="text-6xl mb-4">🌍</div>
            <h2 className="text-white text-2xl font-bold mb-2">Ready to Explore?</h2>
            <p className="text-sky-300 text-lg mb-8">
              Chat with your AI travel agent to start planning your dream trip
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl mx-auto">
              {["🗼 Paris", "🗾 Tokyo", "🌴 Bali", "🏖️ Barcelona"].map((dest) => (
                <div
                  key={dest}
                  className="bg-white/10 border border-white/20 rounded-xl p-3 text-white text-sm cursor-default"
                >
                  {dest}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── UI sub-components ────────────────────────────────────────────────────────

function DestinationCard({ destination }: { destination: Destination }) {
  return (
    <div className="bg-white/10 backdrop-blur border border-white/20 rounded-2xl p-5 hover:bg-white/15 transition-all">
      <div className="flex items-start justify-between mb-3">
        <span className="text-4xl">{destination.emoji}</span>
      </div>
      <h3 className="text-white font-bold text-lg">{destination.name}</h3>
      <p className="text-sky-300 text-sm mb-2">{destination.country}</p>
      <p className="text-white/70 text-sm line-clamp-3">{destination.description}</p>
    </div>
  );
}

const activityTypeColors: Record<string, string> = {
  sightseeing: "bg-purple-500/30 text-purple-200",
  food: "bg-orange-500/30 text-orange-200",
  adventure: "bg-red-500/30 text-red-200",
  culture: "bg-yellow-500/30 text-yellow-200",
  relaxation: "bg-green-500/30 text-green-200",
  transport: "bg-blue-500/30 text-blue-200",
};

const activityEmoji: Record<string, string> = {
  sightseeing: "📸",
  food: "🍽️",
  adventure: "🧗",
  culture: "🎭",
  relaxation: "🧘",
  transport: "🚇",
};

function normaliseActivityType(raw: string): string {
  const t = raw?.toLowerCase();
  // map common Gemini variants to our known types
  if (["art", "museum", "history"].includes(t)) return "culture";
  if (["shopping", "leisure", "entertainment"].includes(t)) return "relaxation";
  if (["nature", "outdoor", "park"].includes(t)) return "adventure";
  if (["dining", "restaurant", "cafe"].includes(t)) return "food";
  if (["transfer", "flight", "train"].includes(t)) return "transport";
  if (t in activityTypeColors) return t;
  return "sightseeing"; // safe default
}

function ItineraryDayCard({ day, dayNumber }: { day: ItineraryDay; dayNumber: number }) {
  const dayTotal = (day.activities || []).reduce((s, a) => s + (a.estimatedCost || 0), 0);

  return (
    <div className="bg-white/10 backdrop-blur border border-white/20 rounded-2xl overflow-hidden">
      <div className="bg-white/10 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="bg-sky-500 text-white text-sm font-bold rounded-full w-8 h-8 flex items-center justify-center">
            {dayNumber}
          </span>
          <div>
            <p className="text-white font-semibold">{day.destination}</p>
            <p className="text-sky-300 text-sm">{day.date}</p>
          </div>
        </div>
        {dayTotal > 0 && (
          <span className="text-sky-200 text-sm bg-white/10 rounded-full px-3 py-1">
            ~${dayTotal} est.
          </span>
        )}
      </div>
      <div className="divide-y divide-white/10">
        {(day.activities || []).map((activity, i) => (
          <div key={i} className="px-5 py-3 flex items-start gap-3">
            <span className="text-lg mt-0.5">{activityEmoji[normaliseActivityType(activity.type)] || "📍"}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-white/60 text-xs font-mono">{activity.time}</span>
                <span className="text-white font-medium text-sm">{activity.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${activityTypeColors[normaliseActivityType(activity.type)] || "bg-white/20 text-white/70"}`}>
                  {normaliseActivityType(activity.type)}
                </span>
              </div>
              <p className="text-white/60 text-sm mt-0.5">{activity.description}</p>
            </div>
            {activity.estimatedCost > 0 && (
              <span className="text-emerald-300 text-sm shrink-0">${activity.estimatedCost}</span>
            )}
          </div>
        ))}
        {(day.activities || []).length === 0 && (
          <p className="px-5 py-3 text-white/40 text-sm italic">No activities planned yet</p>
        )}
      </div>
    </div>
  );
}

// ─── Generative UI Tool Cards ─────────────────────────────────────────────────

function FlightSearchCard({
  origin,
  destination,
  date,
  results,
  isLoading,
}: {
  origin?: string;
  destination?: string;
  date?: string;
  results: FlightResult[];
  isLoading: boolean;
}) {
  return (
    <div className="bg-gradient-to-r from-sky-600 to-indigo-600 rounded-xl overflow-hidden shadow-xl my-2 max-w-md">
      <div className="px-4 py-3 bg-black/20 flex items-center gap-2">
        <span className="text-xl">✈️</span>
        <div>
          <p className="text-white font-semibold text-sm">
            {origin} → {destination}
          </p>
          <p className="text-white/70 text-xs">{date}</p>
        </div>
      </div>
      {isLoading ? (
        <div className="px-4 py-6 text-center text-white/70">Searching flights…</div>
      ) : (
        <div className="divide-y divide-white/10">
          {results.map((f, i) => (
            <div key={i} className="px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-white font-medium text-sm">{f.airline}</p>
                <p className="text-white/60 text-xs">{f.flightNumber} · {f.duration}</p>
                <p className="text-white/50 text-xs">{f.departure} → {f.arrival}</p>
              </div>
              <span className="text-emerald-300 font-bold">${f.price}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HotelSearchCard({
  destination,
  checkIn,
  checkOut,
  results,
  isLoading,
}: {
  destination?: string;
  checkIn?: string;
  checkOut?: string;
  results: HotelResult[];
  isLoading: boolean;
}) {
  return (
    <div className="bg-gradient-to-r from-violet-600 to-purple-600 rounded-xl overflow-hidden shadow-xl my-2 max-w-md">
      <div className="px-4 py-3 bg-black/20 flex items-center gap-2">
        <span className="text-xl">🏨</span>
        <div>
          <p className="text-white font-semibold text-sm">{destination}</p>
          <p className="text-white/70 text-xs">{checkIn} → {checkOut}</p>
        </div>
      </div>
      {isLoading ? (
        <div className="px-4 py-6 text-center text-white/70">Searching hotels…</div>
      ) : (
        <div className="divide-y divide-white/10">
          {results.map((h, i) => (
            <div key={i} className="px-4 py-3">
              <div className="flex items-center justify-between">
                <p className="text-white font-medium text-sm">{h.name}</p>
                <span className="text-emerald-300 font-bold">${h.pricePerNight}/night</span>
              </div>
              <p className="text-white/60 text-xs">{"⭐️".repeat(h.stars)} · {h.location}</p>
              <p className="text-white/50 text-xs mt-1">{h.amenities.join(" · ")}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WeatherCard({
  location,
  forecast,
  isLoading,
}: {
  location?: string;
  forecast: string;
  isLoading: boolean;
}) {
  return (
    <div className="bg-gradient-to-r from-sky-500 to-teal-500 rounded-xl overflow-hidden shadow-xl my-2 max-w-sm">
      <div className="px-4 py-3 bg-black/20 flex items-center gap-2">
        <span className="text-xl">🌤️</span>
        <p className="text-white font-semibold text-sm">{location}</p>
      </div>
      <div className="px-4 py-3">
        {isLoading ? (
          <p className="text-white/70 text-sm">Fetching forecast…</p>
        ) : (
          <p className="text-white text-sm">{forecast}</p>
        )}
      </div>
    </div>
  );
}

function DestinationInfoCard({
  destination,
  info,
  isLoading,
}: {
  destination?: string;
  info: { description: string; highlights: string[]; bestTime: string; currency: string; language: string } | null;
  isLoading: boolean;
}) {
  return (
    <div className="bg-gradient-to-r from-amber-600 to-orange-600 rounded-xl overflow-hidden shadow-xl my-2 max-w-md">
      <div className="px-4 py-3 bg-black/20 flex items-center gap-2">
        <span className="text-xl">🌍</span>
        <p className="text-white font-semibold text-sm">{destination}</p>
      </div>
      {isLoading ? (
        <div className="px-4 py-6 text-center text-white/70">Loading info…</div>
      ) : info ? (
        <div className="px-4 py-3 space-y-3">
          <p className="text-white text-sm">{info.description}</p>
          <div>
            <p className="text-white/60 text-xs uppercase font-semibold mb-1">Top Highlights</p>
            <div className="flex flex-wrap gap-1">
              {info.highlights.map((h, i) => (
                <span key={i} className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full">{h}</span>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-white/60">Best Time</p>
              <p className="text-white">{info.bestTime}</p>
            </div>
            <div>
              <p className="text-white/60">Language</p>
              <p className="text-white">{info.language}</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
