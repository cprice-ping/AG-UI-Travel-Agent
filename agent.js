// ============================================================
// AG-UI Travel Agent — LLM orchestration loop (Gemini)
//
// Takes a user message, builds an LLM tool manifest from all
// currently connected sites (prefixing tool names with siteLabel
// so the LLM knows which site to target), then runs a multi-turn
// tool-call loop until the model returns a final text response.
//
// TEXT_MESSAGE events are broadcast to all connected site tabs
// so both the Flights and Hotels panels update in real time.
// ============================================================

import { GoogleGenAI } from "@google/genai";

const ai    = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.LLM_MODEL ?? "gemini-2.0-flash";

// Delimiter used in prefixed tool names (OpenAI function names: [a-zA-Z0-9_-])
const PREFIX_SEP = "__";
const MAX_DEPTH  = 12; // max tool-call rounds per turn

const SYSTEM_PROMPT = `\
You are a friendly and efficient travel agent with real-time access to flight and hotel booking tools.

You have tools from two connected sites:
- "flights" site: search and book flights
- "hotels" site: search and book hotels

Tool naming convention: <site>${PREFIX_SEP}<toolName>
For example: flights${PREFIX_SEP}search_flights, hotels${PREFIX_SEP}select_hotel

When a user asks to arrange travel:
1. Search for flights matching their request.
2. Search for hotels at the destination for the same dates.
3. Present the best options clearly (name, price, key details).
4. Ask the user to confirm before booking.
5. Once confirmed, call book_flight and book_hotel.
   Note: each booking requires the user to click a confirmation button in their browser tab — tell them to do that when prompted.

Be concise. Use plain text with line breaks rather than markdown tables.
When quoting prices, be specific. Summarise total cost at the end.`;

// ── Tool manifest builder ─────────────────────────────────────
// Turns each site's tool list into Gemini functionDeclarations,
// prefixing names with the siteLabel so the model knows which
// site to route the call to.
// NOTE: "travelagent" connections have no tools — skip them.
function buildToolDefs(connections) {
  const declarations = [];
  for (const [siteLabel, { tools }] of connections.entries()) {
    if (siteLabel === "travelagent") continue;
    for (const tool of tools) {
      declarations.push({
        name:        `${siteLabel}${PREFIX_SEP}${tool.name}`,
        description: `[${siteLabel}] ${tool.description}`,
        parameters:  tool.parameters ?? { type: "object", properties: {} },
      });
    }
  }
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];
}

// ── Parse prefixed tool name ──────────────────────────────────
function parsePrefixedName(prefixed) {
  const idx = prefixed.indexOf(PREFIX_SEP);
  if (idx === -1) return { siteLabel: prefixed, toolName: prefixed };
  return {
    siteLabel: prefixed.slice(0, idx),
    toolName:  prefixed.slice(idx + PREFIX_SEP.length),
  };
}

// ── Entry point ───────────────────────────────────────────────
export async function handleUserMessage(userMessage, _originSiteLabel, { connections, callSiteTool, broadcast }) {
  const toolDefs = buildToolDefs(connections);

  // Gemini message history — starts with the user's message
  const messages = [
    { role: "user", parts: [{ text: userMessage }] },
  ];

  await agentLoop(messages, toolDefs, { callSiteTool, broadcast });
}

// ── LLM tool-call loop ────────────────────────────────────────
async function agentLoop(messages, toolDefs, { callSiteTool, broadcast }, depth = 0) {
  if (depth > MAX_DEPTH) {
    const msgId = newMsgId();
    broadcast({ type: "TEXT_MESSAGE",     messageId: msgId, delta: "I've reached my tool-call limit for this request. Please try again." });
    broadcast({ type: "TEXT_MESSAGE_END", messageId: msgId });
    return;
  }

  const messageId = newMsgId();
  let textBuffer  = "";
  const toolCalls = []; // { name, args }

  try {
    const stream = await ai.models.generateContentStream({
      model:    MODEL,
      contents: messages,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        ...(toolDefs.length > 0 && { tools: toolDefs }),
      },
    });

    for await (const chunk of stream) {
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) {
          textBuffer += part.text;
          broadcast({ type: "TEXT_MESSAGE", messageId, delta: part.text });
        }
        if (part.functionCall) {
          toolCalls.push({
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          });
        }
      }
    }
  } catch (err) {
    console.error(`[agent] Gemini stream error (depth=${depth}): ${err.message}`);
    const errId = newMsgId();
    broadcast({ type: "TEXT_MESSAGE",     messageId: errId, delta: `Sorry, I ran into an error: ${err.message}` });
    broadcast({ type: "TEXT_MESSAGE_END", messageId: errId });
    return;
  }

  // ── No tool calls: final response ──────────────────────────
  if (toolCalls.length === 0) {
    broadcast({ type: "TEXT_MESSAGE_END", messageId });
    return;
  }

  // ── There are tool calls ───────────────────────────────────
  // Close the text bubble if the model emitted text before tools
  if (textBuffer) {
    broadcast({ type: "TEXT_MESSAGE_END", messageId });
  }

  // Add model's response (text + function calls) to history
  messages.push({
    role:  "model",
    parts: [
      ...(textBuffer ? [{ text: textBuffer }] : []),
      ...toolCalls.map((tc) => ({ functionCall: { name: tc.name, args: tc.args } })),
    ],
  });

  // Execute tool calls sequentially and collect functionResponse parts
  const resultParts = [];
  for (const tc of toolCalls) {
    const { siteLabel, toolName } = parsePrefixedName(tc.name);
    let result;
    try {
      console.log(`[agent] → ${siteLabel}::${toolName}(${JSON.stringify(tc.args).slice(0, 200)})`);
      const raw = await callSiteTool(siteLabel, toolName, tc.args);
      try { result = JSON.parse(raw); } catch { result = { result: String(raw) }; }
      console.log(`[agent] ← ${siteLabel}::${toolName}: ${JSON.stringify(result).slice(0, 200)}`);
    } catch (err) {
      console.warn(`[agent] Tool error ${siteLabel}::${toolName}: ${err.message}`);
      result = { error: err.message };
    }
    // Gemini function responses go back as "user" parts
    resultParts.push({ functionResponse: { name: tc.name, response: result } });
  }

  messages.push({ role: "user", parts: resultParts });

  // Continue the loop with the updated message history
  await agentLoop(messages, toolDefs, { callSiteTool, broadcast }, depth + 1);
}

// ── Helpers ───────────────────────────────────────────────────
function newMsgId() {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
