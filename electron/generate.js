/**
 * Railway — surface generation (M2)
 * ------------------------------------------------------------------
 * The seam where the model meets the contract. Given a typed request, we
 * ask Claude to emit a Surface (forced via a tool whose schema IS the
 * contract's zod schema), validate it with the real validator, and on
 * failure feed the errors back and ask for a fix — the repair loop.
 *
 * The model returns two things:
 *   - surface: the typed UI tree (validated against surface-contract.ts)
 *   - data:    the values the surface's bindings point at (draft.to, etc.)
 * Keeping data separate from the tree is the contract's whole point; in M3
 * `data` for real sources (Gmail) comes from the DataContext instead.
 * ------------------------------------------------------------------
 */
const path = require("path");
const { makeClient } = require("./llm");

const MAX_REPAIR_ATTEMPTS = 3;

// The contract is bundled to ESM (electron/gen/contract.mjs); import it once.
let _contract = null;
async function contract() {
  if (!_contract) {
    _contract = await import(
      "file://" + path.join(__dirname, "gen", "contract.mjs")
    );
  }
  return _contract;
}

const SYSTEM_PROMPT = `You are the surface generator for Railway, a personal launcher.
The user types a short request. You produce a small, purpose-built screen ("Surface")
to help them do it — OR the smallest screen that lets them act, then get out of the way.

You emit a Surface built ONLY from three primitives:
  - "composer": one or more editable fields (e.g. an email to/subject/body).
  - "list": a collection view (inbox threads, results) with a {{template}} item.
  - "confirm": a commit point (Send? Delete?) with onConfirm/onCancel actions.

Two hard rules from the contract:
  1. DATA BY REFERENCE. Components never embed literal content. A field's
     "binding" is { kind: "ref", path: "draft.body" } or { kind: "query", source: "inbox" }.
     The actual text/values go in the SEPARATE "data" object you also return,
     keyed so the refs resolve (e.g. data.draft.body = "Hi team, ...").
  2. ACTIONS BY NAME. Actions reference a capability string like "email.send"
     or "ui.dismiss" — never code. Use "ui.dismiss" for cancel.

Guidance:
  - Keep surfaces minimal. A draft email = one composer + one confirm to send.
  - Pre-fill sensible content in "data" so the screen is useful immediately.
  - Use ref bindings for composer fields and confirm previews; use a query
    binding ({ kind: "query", source: "inbox" }) for lists of live data.
  - Give every node a short unique id.

Call emit_surface with { surface, data }. Always call the tool.`;

const ROUTER_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

ROUTING — first decide between two tools:
  - do_silently: the user clearly wants it DONE now, no screen to review.
    Examples: "tell Sarah I'm running late", "reply yes to the invite",
    "let the vendor know we got it". Provide the capability (e.g. "email.send"),
    its args (e.g. { to, subject, body }), and a short human summary.
    Infer a reasonable recipient/subject/body from the request.
  - emit_surface: the user wants to see/edit something before it happens, or
    is browsing. Examples: "draft the tricky email", "write the vendor email",
    "check inbox". Produce a Surface (+ data) as described above.

When in doubt, prefer emit_surface — showing a screen is the safe default.
Call exactly one tool.`;

function doSilentlyTool() {
  return {
    name: "do_silently",
    description:
      "Use when the user clearly wants the task done immediately with no screen to review.",
    input_schema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "e.g. email.send" },
        args: {
          type: "object",
          description: "Arguments for the capability, e.g. { to, subject, body }.",
          additionalProperties: true,
        },
        summary: {
          type: "string",
          description: "Short human summary, e.g. \"Email Sarah you're running late\".",
        },
      },
      required: ["capability", "args", "summary"],
    },
  };
}

/**
 * M4 router: one model call decides do-it vs show-me.
 * @returns {Promise<
 *   {ok:true, mode:"do", capability, args, summary, intent} |
 *   {ok:true, mode:"surface", surface, data, intent} |
 *   {ok:false, error, needKey?:boolean}>}
 */
async function routeRequest(requestText, { apiKey, model, provider, history = [], client } = {}) {
  if (!apiKey && !client)
    return { ok: false, needKey: true, error: "No API key configured." };

  const { validateSurface, surfaceJsonSchema } = await contract();
  const emitTool = buildToolSchema(surfaceJsonSchema());
  client = client || makeClient({ apiKey, provider });

  const historyBlock =
    history.length > 0
      ? `\n\nRecent things this user did (for better defaults/pre-fill):\n` +
        history.map((h) => `- "${h.request}" → ${h.intent}`).join("\n")
      : "";

  let resp;
  try {
    resp = await client.messages.create({
      model,
      max_tokens: 2048,
      system: ROUTER_SYSTEM_PROMPT,
      tools: [emitTool, doSilentlyTool()],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: `Request: ${requestText}${historyBlock}` }],
    });
  } catch (e) {
    return { ok: false, error: `Anthropic API error: ${e?.message || e}` };
  }

  const toolUse = resp.content.find((c) => c.type === "tool_use");
  if (!toolUse) return { ok: false, error: "model did not choose an action" };

  if (toolUse.name === "do_silently") {
    const { capability, args, summary } = toolUse.input || {};
    return { ok: true, mode: "do", capability, args: args || {}, summary: summary || "", intent: summary || requestText };
  }

  // emit_surface chosen — validate; if invalid, fall back to the repair loop.
  const { surface, data } = toolUse.input || {};
  const valid = validateSurface(surface);
  if (valid.ok)
    return { ok: true, mode: "surface", surface: valid.surface, data: data || {}, intent: valid.surface.intent };

  const repaired = await generateSurface(requestText, { apiKey, model, provider, history, client });
  if (repaired.ok) return { ok: true, mode: "surface", ...repaired };
  return repaired;
}

function buildToolSchema(surfaceJsonSchema) {
  // Strip the $schema header zod adds; Anthropic wants a bare JSON Schema.
  const surface = { ...surfaceJsonSchema };
  delete surface.$schema;
  return {
    name: "emit_surface",
    description:
      "Emit the Surface (typed UI tree) plus the data its bindings resolve against.",
    input_schema: {
      type: "object",
      properties: {
        surface,
        data: {
          type: "object",
          description:
            "Values the surface's ref/query bindings point at, e.g. { draft: { to, subject, body }, inbox: [...] }.",
          additionalProperties: true,
        },
      },
      required: ["surface", "data"],
    },
  };
}

/**
 * Generate a validated Surface for a request.
 * @returns {Promise<{ok:true, surface, data, intent} | {ok:false, error, needKey?:boolean}>}
 */
async function generateSurface(requestText, { apiKey, model, provider, history = [], client } = {}) {
  if (!apiKey && !client)
    return { ok: false, needKey: true, error: "No API key configured." };

  const { validateSurface, errorsForRepair, surfaceJsonSchema } = await contract();

  const tool = buildToolSchema(surfaceJsonSchema());
  // `client` is injectable for tests; real runs build the provider client.
  client = client || makeClient({ apiKey, provider });

  // Optional memory (M5): a compact preamble of recent, relevant requests.
  const historyBlock =
    history.length > 0
      ? `\n\nRecent things this user did (for better defaults/pre-fill):\n` +
        history.map((h) => `- "${h.request}" → ${h.intent}`).join("\n")
      : "";

  const messages = [
    { role: "user", content: `Request: ${requestText}${historyBlock}` },
  ];

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await client.messages.create({
        model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [tool],
        tool_choice: { type: "tool", name: "emit_surface" },
        messages,
      });
    } catch (e) {
      return { ok: false, error: `Anthropic API error: ${e?.message || e}` };
    }

    const toolUse = resp.content.find((c) => c.type === "tool_use");
    if (!toolUse) {
      lastError = "model did not call emit_surface";
      continue;
    }

    const { surface, data } = toolUse.input || {};
    const result = validateSurface(surface);
    if (result.ok) {
      return { ok: true, surface: result.surface, data: data || {}, intent: result.surface.intent };
    }

    // Repair: show the model exactly what was wrong and let it try again.
    lastError = errorsForRepair(result.errors);
    messages.push({ role: "assistant", content: resp.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: lastError,
        },
      ],
    });
  }

  return {
    ok: false,
    error: `Could not produce a valid surface after ${MAX_REPAIR_ATTEMPTS} attempts. Last error:\n${lastError}`,
  };
}

module.exports = { generateSurface, routeRequest };
