/**
 * Railway — LLM provider abstraction
 * ------------------------------------------------------------------
 * generate.js is written against the Anthropic Messages shape
 * (client.messages.create → { content: [{type:"tool_use", id, name, input}] }).
 * This module returns a client with that exact interface, backed by:
 *   - Anthropic  (sk-ant-...): the real @anthropic-ai/sdk.
 *   - OpenRouter (sk-or-...):  an OpenAI-compatible HTTP adapter.
 *   - Local      (provider:"local"): the SAME OpenAI-compatible adapter pointed
 *     at a local server (Ollama / LM Studio / llama.cpp) — no key, nothing
 *     leaves the machine. Needs a tool-calling-capable local model.
 * All three translate Anthropic-shaped requests/responses ⇄ OpenAI
 * chat-completions (tools, forced tool_choice, the tool_result repair turn),
 * so generate.js / routeRequest are provider-blind.
 * ------------------------------------------------------------------
 */
const Anthropic = require("@anthropic-ai/sdk");

const OPENROUTER_URL = "https://openrouter.ai/api/v1";
// Common local OpenAI-compatible endpoints: Ollama :11434, LM Studio :1234.
const DEFAULT_LOCAL_URL = "http://localhost:11434/v1";

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

/**
 * An OpenAI-compatible chat-completions client exposing the Anthropic interface.
 * Used for both OpenRouter (hosted) and local servers — only the base URL,
 * auth, and a friendly error label differ.
 */
function makeOpenAICompatibleClient(baseUrl, { apiKey, headers = {}, label = "LLM" } = {}) {
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  return {
    messages: {
      create: async ({ model, max_tokens, system, tools, tool_choice, messages }) => {
        const body = { model, max_tokens, messages: toOpenAIMessages(system, messages) };
        if (tools) body.tools = toOpenAITools(tools);
        const tc = toOpenAIToolChoice(tool_choice);
        if (tc) body.tool_choice = tc;

        let res;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
              ...headers,
            },
            body: JSON.stringify(body),
          });
        } catch (e) {
          // Local server not running is the common case — say so clearly.
          throw new Error(`${label} request failed (${url}): ${e?.message || e}`);
        }
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error?.message || `${label} HTTP ${res.status}`);
        return fromOpenAIResponse(json);
      },
    },
  };
}

/**
 * Build a provider client for the given config.
 * @param {{apiKey?:string, provider?:string, baseUrl?:string}} cfg
 */
function makeClient({ apiKey, provider, baseUrl }) {
  if (provider === "openrouter")
    return makeOpenAICompatibleClient(OPENROUTER_URL, {
      apiKey,
      headers: { "HTTP-Referer": "https://github.com/local/railway", "X-Title": "Railway" },
      label: "OpenRouter",
    });
  if (provider === "local")
    return makeOpenAICompatibleClient(baseUrl || DEFAULT_LOCAL_URL, { apiKey, label: "Local model" });
  return new Anthropic({ apiKey }); // default: Anthropic-native
}

module.exports = {
  makeClient,
  makeOpenAICompatibleClient,
  toOpenAIMessages,
  toOpenAITools,
  toOpenAIToolChoice,
  fromOpenAIResponse,
  DEFAULT_LOCAL_URL,
};
