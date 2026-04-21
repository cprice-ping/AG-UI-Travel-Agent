/**
 * Travel Data API
 *
 * REST resource server for travel data — flights, hotels, destinations, weather.
 * This is the actual API that the MCP server fronts. It knows nothing about MCP
 * or the end user; it only sees requests from the MCP server identified by an
 * API key.
 *
 * Authentication: X-API-Key header (shared secret between MCP server and this API).
 * In production this would be replaced by the MCP server performing an
 * RFC 8693 token exchange and calling with an audience-bound Bearer token.
 *
 * Endpoints:
 *   GET /flights?origin=&destination=&departureDate=
 *   GET /hotels?destination=&checkIn=&checkOut=
 *   GET /destination?name=
 *   GET /weather?location=
 *   GET /health
 */

import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3200", 10);
const API_KEY = process.env.API_KEY ?? "";

if (!API_KEY) {
  console.warn("⚠️  API_KEY is not set — all requests will be rejected");
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: () => void) {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    res.status(401).json({ error: "Invalid or missing X-API-Key" });
    return;
  }
  next();
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

function searchFlights(origin: string, destination: string, departureDate: string) {
  return [
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
}

function searchHotels(destination: string, checkIn: string, checkOut: string) {
  return [
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
}

const KNOWN_DESTINATIONS: Record<string, {
  description: string;
  highlights: string[];
  bestTime: string;
  currency: string;
  language: string;
}> = {
  paris: {
    description: "The City of Light, known for art, fashion, gastronomy and culture.",
    highlights: ["Eiffel Tower", "Louvre Museum", "Notre-Dame Cathedral", "Montmartre", "Seine River Cruises"],
    bestTime: "April–June and September–November",
    currency: "Euro (EUR)",
    language: "French",
  },
  tokyo: {
    description: "A mesmerising blend of ultramodern and traditional, from neon-lit skyscrapers to historic temples.",
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
  "new york": {
    description: "The city that never sleeps — a global hub for finance, art, fashion, and food.",
    highlights: ["Central Park", "Metropolitan Museum", "Times Square", "Brooklyn Bridge", "High Line"],
    bestTime: "April–June and September–November",
    currency: "US Dollar (USD)",
    language: "English",
  },
  seattle: {
    description: "The Emerald City — tech hub surrounded by mountains, water, and world-class coffee culture.",
    highlights: ["Space Needle", "Pike Place Market", "Chihuly Garden", "Museum of Pop Culture", "Mount Rainier Day Trip"],
    bestTime: "June–September (dry season)",
    currency: "US Dollar (USD)",
    language: "English",
  },
  london: {
    description: "A world capital blending royal history, cutting-edge culture, and multicultural cuisine.",
    highlights: ["Tower of London", "British Museum", "Buckingham Palace", "Borough Market", "Tate Modern"],
    bestTime: "May–September",
    currency: "British Pound (GBP)",
    language: "English",
  },
  sydney: {
    description: "Australia's harbour city — iconic opera house, golden beaches, and vibrant dining scene.",
    highlights: ["Sydney Opera House", "Bondi Beach", "Harbour Bridge Climb", "Darling Harbour", "Blue Mountains"],
    bestTime: "September–November and March–May",
    currency: "Australian Dollar (AUD)",
    language: "English",
  },
};

function getDestinationInfo(name: string) {
  const key = name.toLowerCase();
  const match = Object.entries(KNOWN_DESTINATIONS).find(([k]) => key.includes(k));
  return match
    ? { destination: name, ...match[1] }
    : {
        destination: name,
        description: `${name} is a wonderful travel destination with rich culture and unique experiences.`,
        highlights: ["Local cuisine", "Cultural sites", "Natural scenery", "Shopping", "Nightlife"],
        bestTime: "Spring or Autumn for mild weather",
        currency: "Local currency",
        language: "Local language",
      };
}

// WMO weather interpretation codes → human-readable condition + emoji
// https://open-meteo.com/en/docs#weathervariables
const WMO_CONDITIONS: Record<number, { label: string; emoji: string }> = {
  0:  { label: "Clear sky",             emoji: "☀️"  },
  1:  { label: "Mainly clear",          emoji: "🌤️" },
  2:  { label: "Partly cloudy",         emoji: "⛅"  },
  3:  { label: "Overcast",              emoji: "☁️"  },
  45: { label: "Foggy",                 emoji: "🌫️" },
  48: { label: "Icy fog",               emoji: "🌫️" },
  51: { label: "Light drizzle",         emoji: "🌦️" },
  53: { label: "Drizzle",               emoji: "🌦️" },
  55: { label: "Heavy drizzle",         emoji: "🌧️" },
  61: { label: "Light rain",            emoji: "🌧️" },
  63: { label: "Rain",                  emoji: "🌧️" },
  65: { label: "Heavy rain",            emoji: "🌧️" },
  71: { label: "Light snow",            emoji: "🌨️" },
  73: { label: "Snow",                  emoji: "❄️"  },
  75: { label: "Heavy snow",            emoji: "❄️"  },
  77: { label: "Snow grains",           emoji: "🌨️" },
  80: { label: "Light showers",         emoji: "🌦️" },
  81: { label: "Showers",               emoji: "🌧️" },
  82: { label: "Heavy showers",         emoji: "🌧️" },
  85: { label: "Snow showers",          emoji: "🌨️" },
  86: { label: "Heavy snow showers",    emoji: "❄️"  },
  95: { label: "Thunderstorm",          emoji: "⛈️"  },
  96: { label: "Thunderstorm with hail",emoji: "⛈️"  },
  99: { label: "Thunderstorm with hail",emoji: "⛈️"  },
};

async function getWeather(location: string) {
  // 1. Geocode city name → lat/lon using Open-Meteo's free geocoding API
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
  );
  if (!geoRes.ok) throw new Error(`Geocoding failed: ${geoRes.status}`);
  const geoData = await geoRes.json() as {
    results?: { latitude: number; longitude: number; name: string; country: string; timezone: string }[];
  };

  if (!geoData.results?.length) {
    throw new Error(`Location not found: ${location}`);
  }
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

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

// Only MCP server calls this API — no browser origins needed.
// Allow any origin for health checks; lock down data routes via API key.
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/flights", requireApiKey, (req: Request, res: Response) => {
  const { origin, destination, departureDate } = req.query;
  if (!origin || !destination || !departureDate) {
    res.status(400).json({ error: "origin, destination, and departureDate are required" });
    return;
  }
  console.log(`[api] GET /flights | origin=${origin} | destination=${destination} | date=${departureDate}`);
  res.json(searchFlights(String(origin), String(destination), String(departureDate)));
});

app.get("/hotels", requireApiKey, (req: Request, res: Response) => {
  const { destination, checkIn, checkOut } = req.query;
  if (!destination || !checkIn || !checkOut) {
    res.status(400).json({ error: "destination, checkIn, and checkOut are required" });
    return;
  }
  console.log(`[api] GET /hotels | destination=${destination} | checkIn=${checkIn} | checkOut=${checkOut}`);
  res.json(searchHotels(String(destination), String(checkIn), String(checkOut)));
});

app.get("/destination", requireApiKey, (req: Request, res: Response) => {
  const { name } = req.query;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  console.log(`[api] GET /destination | name=${name}`);
  res.json(getDestinationInfo(String(name)));
});

app.get("/weather", requireApiKey, async (req: Request, res: Response) => {
  const { location } = req.query;
  if (!location) {
    res.status(400).json({ error: "location is required" });
    return;
  }
  console.log(`[api] GET /weather | location=${location}`);
  try {
    res.json(await getWeather(String(location)));
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg.includes("not found") ? 404 : 502;
    res.status(status).json({ error: msg });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅  Travel API listening at http://localhost:${PORT}`);
  console.log(`🔑  API key auth: ${API_KEY ? "enabled" : "DISABLED — set API_KEY"}`);
});
