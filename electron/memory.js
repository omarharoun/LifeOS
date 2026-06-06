/**
 * Railway — memory (M5)
 * ------------------------------------------------------------------
 * A tiny local log: { what you asked, what screen/mode appeared, what you
 * chose/edited, how long it took, when }. Before each new request we pull the
 * most relevant recent rows and hand them to the model (see generate.js's
 * history block) so it predicts the route and pre-fills better over time.
 *
 * No ML — recency + light keyword overlap. JSON file, one row per task.
 * createMemory(path) so tests can use a throwaway file.
 * ------------------------------------------------------------------
 */
const fs = require("fs");
const { dataPath } = require("./paths");

const DEFAULT_FILE = dataPath("memory.json");

const STOPWORDS = new Set(
  "the a an to of for and or but in on at my me i you your is it that this with".split(" ")
);
const tokenize = (s) =>
  String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

function createMemory(file = DEFAULT_FILE) {
  function load() {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return [];
    }
  }
  function save(rows) {
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  }

  /** Append a completed-task record. Caller supplies `ts` (no Date in scripts). */
  function append(record) {
    const rows = load();
    rows.push({ id: `m_${rows.length + 1}`, ...record });
    save(rows);
    return rows[rows.length - 1];
  }

  function recent(n = 5) {
    return load().slice(-n).reverse();
  }

  /**
   * Most relevant rows for a new request: keyword overlap first, then recency.
   * Returns a compact shape for the prompt: { request, intent, edits }.
   */
  function relevant(request, n = 5) {
    const rows = load();
    const q = new Set(tokenize(request));
    const scored = rows.map((r, i) => {
      const words = tokenize(r.request);
      const overlap = words.filter((w) => q.has(w)).length;
      return { r, overlap, i };
    });
    scored.sort((a, b) => b.overlap - a.overlap || b.i - a.i);
    return scored
      .filter((s) => s.overlap > 0)
      .slice(0, n)
      .map((s) => ({ request: s.r.request, intent: s.r.intent, edits: s.r.edits ?? 0 }));
  }

  /** Aggregate: count + median time-to-done (the one number that should fall). */
  function stats() {
    const rows = load();
    const times = rows.map((r) => r.timeToDoneMs).filter((t) => typeof t === "number").sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : null;
    return { count: rows.length, medianTimeToDoneMs: median };
  }

  return { append, recent, relevant, stats, load, _file: file };
}

module.exports = { createMemory, tokenize };
