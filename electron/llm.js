/**
 * Railway — LLM provider abstraction
 * ------------------------------------------------------------------
 * generate.js is written against the Anthropic Messages shape
 * (client.messages.create → { content: [{type:"tool_use", id, name, input}] }).
 * This module returns a client with that exact interface, backed by either:
 *   - Anthropic  (sk-ant-...): the real @anthropic-ai/sdk.
 *   - OpenRouter (sk-or-...):  an OpenAI-compatible HTTP adapter that
 *     translates Anthropic-shaped requests/responses ⇄ OpenAI chat-completions
 *     (tools, forced tool_choice, and the tool_result repair turn).
 *
 * Keeping the adapter here means generate.js / routeRequest are provider-blind.
 * ------------------------------------------------------------------
 */
const Anthropic = require("@anthropic-ai/sdk");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/* ---------- Anthropic ⇄ OpenAI translation (for OpenRouter) ---------- */

function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content });
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === "tool_result") {
            // Anthropic tool_result → OpenAI tool message.
            out.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content:
                typeof block.content === "string" ? block.content : JSON.stringify(block.content),
            });
          } else if (block.type === "text") {
            out.push({ role: "user", content: block.text });
          }
        }
      }
    } else if (m.role === "assistant") {
      if (Array.isArray(m.content)) {
        let text = "";
        const toolCalls = [];
        for (const block of m.content) {
          if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
            });
          } else if (block.type === "text") {
            text += block.text;
          }
        }
        const am = { role: "assistant", content: text || null };
        if (toolCalls.length) am.tool_calls = toolCalls;
        out.push(am);
      } else {
        out.push({ role: "assistant", content: m.content });
      }
    }
  }
  return out;
}

function toOpenAITools(tools = []) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toOpenAIToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === "tool") return { type: "function", function: { name: choice.name } };
  if (choice.type === "any") return "required";
  if (choice.type === "auto") return "auto";
  return undefined;
}

/** Map an OpenAI chat-completions response back to the Anthropic content shape. */
function fromOpenAIResponse(json) {
  const msg = json?.choices?.[0]?.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  return { content };
}

function makeOpenRouterClient(apiKey) {
  return {
    messages: {
      create: async ({ model, max_tokens, system, tools, tool_choice, messages }) => {
        const body = {
          model,
          max_tokens,
          messages: toOpenAIMessages(system, messages),
        };
        if (tools) body.tools = toOpenAITools(tools);
        const tc = toOpenAIToolChoice(tool_choice);
        if (tc) body.tool_choice = tc;

        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            // Optional attribution headers OpenRouter recommends.
            "HTTP-Referer": "https://github.com/local/railway",
            "X-Title": "Railway",
          },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) {
          const msg = json?.error?.message || `OpenRouter HTTP ${res.status}`;
          throw new Error(msg);
        }
        return fromOpenAIResponse(json);
      },
    },
  };
}

/**
 * Build a provider client for the given config.
 * @param {{apiKey:string, provider?:string}} cfg
 */
function makeClient({ apiKey, provider }) {
  if (provider === "openrouter") return makeOpenRouterClient(apiKey);
  return new Anthropic({ apiKey }); // default: Anthropic-native
}

module.exports = { makeClient, toOpenAIMessages, toOpenAITools, toOpenAIToolChoice, fromOpenAIResponse };
