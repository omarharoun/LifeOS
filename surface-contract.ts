/**
 * surface-contract.ts
 * ------------------------------------------------------------------
 * THE CONTRACT.
 *
 * This is the single seam where the model and the renderer meet.
 *   - The model emits a `Surface` (a typed tree built only from the
 *     fixed primitive vocabulary).
 *   - The renderer draws it.
 *   - Neither side ever touches arbitrary code.
 *
 * Two ideas do all the load-bearing work:
 *   1. DATA BY REFERENCE  — components hold `Binding`s (pointers into
 *      the data layer), never literal data. This enforces "data
 *      decoupled from interface" at the type level.
 *   2. ACTIONS BY NAME     — components reference a registered
 *      `capability` string, never an implementation. The model can
 *      express intent but cannot author a side effect.
 *
 * Because the schema is executable (zod), it is simultaneously:
 *   - the thing you constrain the model's output to,
 *   - the runtime gate that rejects/repairs bad trees,
 *   - the source of truth for the renderer's types.
 *
 * Run the demo:  npx tsx surface-contract.ts
 * Install:       npm i zod
 * ------------------------------------------------------------------
 */

import { z } from "zod";

/* ============================================================
 * 1. BINDINGS — data by reference, never embedded
 * ========================================================== */

export const Binding = z.discriminatedUnion("kind", [
  // pointer into the resolved data context, e.g. "draft.body"
  z.object({ kind: z.literal("ref"), path: z.string().min(1) }),
  // resolve a collection/value from the data layer on demand
  z.object({
    kind: z.literal("query"),
    source: z.string().min(1),
    filter: z.record(z.string(), z.unknown()).optional(),
  }),
  // escape hatch — discouraged; prefer ref/query so data stays in the layer
  z.object({ kind: z.literal("literal"), value: z.unknown() }),
]);
export type Binding = z.infer<typeof Binding>;

/* ============================================================
 * 2. ACTIONS — name a capability, never implement it
 * ========================================================== */

export const Action = z.object({
  capability: z.string().min(1), // e.g. "email.send", "ui.dismiss"
  args: z.record(z.string(), Binding).default({}),
});
export type Action = z.infer<typeof Action>;

/* ============================================================
 * 3. PRIMITIVES — the entire UI vocabulary (3 of them)
 *    To add a primitive later: define its schema here and add it
 *    to the `Node` union below. Nothing else changes.
 * ========================================================== */

// COMPOSER — input / editing surface (email body, reply, note)
export const Composer = z.object({
  type: z.literal("composer"),
  id: z.string().min(1),
  fields: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string(),
        binding: Binding, // value source + write-back target
        multiline: z.boolean().optional(),
        suggestions: Binding.optional(), // optional generative extras
      })
    )
    .min(1),
});

// LIST — a collection view (inbox threads, contacts, results)
export const List = z.object({
  type: z.literal("list"),
  id: z.string().min(1),
  source: Binding, // points at a collection in the data layer
  item: z.object({
    // template strings reference item fields: "{{from}}", "{{date}}"
    title: z.string().min(1),
    subtitle: z.string().optional(),
    timestamp: z.string().optional(),
  }),
  onSelect: Action.optional(),
});

// CONFIRM — a decision / commit point (send? delete? schedule?)
export const Confirm = z.object({
  type: z.literal("confirm"),
  id: z.string().min(1),
  summary: z.string().min(1),
  preview: Binding.optional(),
  onConfirm: Action,
  onCancel: Action.optional(),
});

export const Node = z.discriminatedUnion("type", [Composer, List, Confirm]);
export type Node = z.infer<typeof Node>;

/* ============================================================
 * 4. SURFACE — the top-level tree the model emits.
 *    A "do-it" intent produces NO surface at all; if a surface
 *    exists, the router decided the user wanted a place to act.
 * ========================================================== */

export const Surface = z.object({
  id: z.string().min(1),
  intent: z.string().min(1), // human-readable, for logging + repair
  ephemeral: z.boolean().default(true), // dissolves unless pinned (the non-trap default)
  blocks: z.array(Node).min(1), // ordered composition from the fixed kit
});
export type Surface = z.infer<typeof Surface>;

/* ============================================================
 * 5. VALIDATION — the gate that makes generative UI trustworthy.
 *    On failure, errors are shaped for a model repair loop:
 *    feed `errorsForRepair()` back and ask for a corrected tree.
 * ========================================================== */

export type ValidationError = { path: string; message: string };
export type ValidationResult =
  | { ok: true; surface: Surface }
  | { ok: false; errors: ValidationError[] };

export function validateSurface(input: unknown): ValidationResult {
  const parsed = Surface.safeParse(input);
  if (parsed.success) return { ok: true, surface: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    })),
  };
}

/**
 * JSON Schema for a Surface, derived from the same zod schema used to
 * validate. Used to constrain the model's tool output so what it emits and
 * what we accept are guaranteed to be the same shape.
 */
export function surfaceJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Surface) as Record<string, unknown>;
}

/** Compact, model-friendly description of what was wrong. */
export function errorsForRepair(errors: ValidationError[]): string {
  return [
    "The Surface you emitted was invalid. Fix these and re-emit a valid Surface:",
    ...errors.map((e) => `- ${e.path}: ${e.message}`),
  ].join("\n");
}

/* ============================================================
 * 6. SEAMS — the per-system plumbing.
 *    Shape validation above is universal. THESE are what you
 *    implement once per integrated system (email, calendar, ...).
 * ========================================================== */

/** Resolves `Binding`s against real data. One impl per data source. */
export interface DataContext {
  get(path: string): unknown; // resolve a "ref"
  query(source: string, filter?: Record<string, unknown>): unknown; // resolve a "query"
}

/** Holds the real implementations of named capabilities. */
export interface CapabilityRegistry {
  has(name: string): boolean;
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function resolveBinding(b: Binding, ctx: DataContext): unknown {
  switch (b.kind) {
    case "ref":
      return ctx.get(b.path);
    case "query":
      return ctx.query(b.source, b.filter);
    case "literal":
      return b.value;
  }
}

/**
 * Semantic check beyond shape: every referenced capability must be
 * registered before a surface is allowed to render. Returns the
 * names of any capabilities the surface needs but the registry lacks.
 */
export function checkCapabilities(
  surface: Surface,
  registry: CapabilityRegistry
): string[] {
  const missing: string[] = [];
  const visit = (a?: Action) => {
    if (a && !registry.has(a.capability)) missing.push(a.capability);
  };
  for (const node of surface.blocks) {
    if (node.type === "confirm") {
      visit(node.onConfirm);
      visit(node.onCancel);
    } else if (node.type === "list") {
      visit(node.onSelect);
    }
  }
  return [...new Set(missing)];
}

/* ============================================================
 * 7. EXAMPLE + SELF-CHECK
 *    "draft the vendor pushback" -> this surface. Note the actual
 *    draft text appears NOWHERE in the tree: it lives in the data
 *    context under `draft`, produced by the resolution step. The
 *    tree only points at it. That is the decoupling, made concrete.
 * ========================================================== */

const exampleSurface: unknown = {
  id: "srf_01",
  intent: "Draft pushback email to vendor",
  ephemeral: true,
  blocks: [
    {
      type: "composer",
      id: "cmp_1",
      fields: [
        { key: "to", label: "To", binding: { kind: "ref", path: "draft.to" } },
        { key: "subject", label: "Subject", binding: { kind: "ref", path: "draft.subject" } },
        {
          key: "body",
          label: "Body",
          binding: { kind: "ref", path: "draft.body" },
          multiline: true,
          suggestions: { kind: "ref", path: "draft.altPhrasings" },
        },
      ],
    },
    {
      type: "confirm",
      id: "cnf_1",
      summary: "Send to billing@vendor.com?",
      preview: { kind: "ref", path: "draft" },
      onConfirm: { capability: "email.send", args: { draft: { kind: "ref", path: "draft" } } },
      onCancel: { capability: "ui.dismiss", args: {} },
    },
  ],
};

function demo() {
  const result = validateSurface(exampleSurface);
  if (!result.ok) {
    console.error("✗ invalid surface");
    console.error(errorsForRepair(result.errors));
    return;
  }
  console.log("✓ valid surface:", result.surface.intent);

  // A minimal registry to show the capability gate working.
  const registered = new Set(["email.send", "ui.dismiss"]);
  const registry: CapabilityRegistry = {
    has: (n) => registered.has(n),
    invoke: async (n, args) => console.log(`invoke ${n}`, args),
  };

  const missing = checkCapabilities(result.surface, registry);
  console.log(
    missing.length === 0
      ? "✓ all capabilities registered"
      : `✗ missing capabilities: ${missing.join(", ")}`
  );
}

// Run the self-check only when this file is executed directly
// (e.g. `npx tsx surface-contract.ts`), not when imported as a library by
// the app — importing it should have no side effects, just exports.
import { pathToFileURL } from "node:url";
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  demo();
}
