// ============================================================
// AG-UI Travel Agent — LLM orchestration loop
//
// Takes a user message, builds an LLM tool manifest from all
// currently connected sites (prefixing tool names with siteLabel
// so the LLM knows which site to target), then runs a multi-turn
// tool-call loop until the model returns a final text response.
//
// TEXT_MESSAGE events are broadcast to all connected site tabs
// so both the Flights and Hotels panels update in real time.
// ============================================================

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.LLM_MODEL ?? "gpt-4o";

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
// Turns each site's tool list into OpenAI function definitions,
// prefixing names with the siteLabel so the model knows which
// site to route the call to.
function buildToolDefs(connections) {
  const defs = [];
  for (const [siteLabel, { tools }] of connections.entries()) {
    for (const tool of tools) {
      defs.push({
        type: "function",
        function: {
          name:        `${siteLabel}${PREFIX_SEP}${tool.name}`,
          description: `[${siteLabel}] ${tool.description}`,
          parameters:  tool.parameters ?? { type: "object", properties: {} },
        },
      });
    }
  }
  return defs;
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

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: userMessage },
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

  // ── Stream one LLM turn ────────────────────────────────────
  let textBuffer   = "";
  const toolCallsMap = {}; // delta index → { id, name, argumentsBuffer }
  let finishReason = null;

  const streamParams = {
    model:    MODEL,
    stream:   true,
    messages,
    ...(toolDefs.length > 0 && { tools: toolDefs, tool_choice: "auto" }),
  };

  try {
    const stream = await openai.chat.completions.create(streamParams);

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      // Text delta → broadcast immediately for streaming UX
      if (delta.content) {
        textBuffer += delta.content;
        broadcast({ type: "TEXT_MESSAGE", messageId, delta: delta.content });
      }

      // Tool call deltas — accumulate by index
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallsMap[tc.index]) {
            toolCallsMap[tc.index] = { id: "", name: "", argumentsBuffer: "" };
          }
          const slot = toolCallsMap[tc.index];
          if (tc.id)               slot.id               += tc.id;
          if (tc.function?.name)   slot.name             += tc.function.name;
          if (tc.function?.arguments) slot.argumentsBuffer += tc.function.arguments;
        }
      }
    }
  } catch (err) {
    console.error(`[agent] OpenAI stream error (depth=${depth}): ${err.message}`);
    const errId = newMsgId();
    broadcast({ type: "TEXT_MESSAGE",     messageId: errId, delta: `Sorry, I ran into an error: ${err.message}` });
    broadcast({ type: "TEXT_MESSAGE_END", messageId: errId });
    return;
  }

  const toolCalls = Object.values(toolCallsMap);

  // ── No tool calls: final response ─────────────────────────
  if (finishReason !== "tool_calls" || toolCalls.length === 0) {
    broadcast({ type: "TEXT_MESSAGE_END", messageId });
    return;
  }

  // ── There are tool calls ───────────────────────────────────
  // Close the text bubble if the model also emitted text before the tools
  if (textBuffer) {
    broadcast({ type: "TEXT_MESSAGE_END", messageId });
  }

  // Add the assistant's tool-call message to history
  messages.push({
    role:    "assistant",
    content: textBuffer || null,
    tool_calls: toolCalls.map((tc) => ({
      id:       tc.id,
      type:     "function",
      function: { name: tc.name, arguments: tc.argumentsBuffer },
    })),
  });

  // Execute tool calls sequentially — most tools depend on prior results
  for (const tc of toolCalls) {
    const { siteLabel, toolName } = parsePrefixedName(tc.name);

    let resultContent;
    try {
      let args;
      try { args = JSON.parse(tc.argumentsBuffer); } catch { args = {}; }

      console.log(`[agent] → ${siteLabel}::${toolName}(${tc.argumentsBuffer.slice(0, 200)})`);
      const raw = await callSiteTool(siteLabel, toolName, args);
      resultContent = typeof raw === "string" ? raw : JSON.stringify(raw);
      console.log(`[agent] ← ${siteLabel}::${toolName}: ${resultContent.slice(0, 200)}`);
    } catch (err) {
      console.warn(`[agent] Tool error ${siteLabel}::${toolName}: ${err.message}`);
      resultContent = JSON.stringify({ error: err.message });
    }

    messages.push({
      role:         "tool",
      tool_call_id: tc.id,
      content:      resultContent,
    });
  }

  // Continue the loop with the updated message history
  await agentLoop(messages, toolDefs, { callSiteTool, broadcast }, depth + 1);
}

// ── Helpers ───────────────────────────────────────────────────
function newMsgId() {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
