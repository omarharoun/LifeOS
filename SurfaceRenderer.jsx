import React, { useState, useCallback, useMemo, useRef } from "react";

/**
 * SurfaceRenderer
 * ------------------------------------------------------------------
 * Consumes a Surface (the typed tree from surface-contract.ts), resolves
 * its Bindings against a DataContext, draws the three primitives, and
 * fires Actions through a CapabilityRegistry.
 *
 * Everything system-specific lives in the two seams: `data` (DataContext)
 * and `capabilities` (CapabilityRegistry). Swap those for real adapters
 * and the renderer is unchanged. Surfaces are ephemeral: a fired action
 * can dissolve them.
 * ------------------------------------------------------------------
 */

/* ---------- binding helpers ---------- */
const getPath = (obj, path) =>
  path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const setPath = (obj, path, value) => {
  const keys = path.split(".");
  const next = Array.isArray(obj) ? [...obj] : { ...obj };
  let cur = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cur[k] = Array.isArray(cur[k]) ? [...cur[k]] : { ...(cur[k] ?? {}) };
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return next;
};

const fillTemplate = (str, item) =>
  str.replace(/\{\{(\w+)\}\}/g, (_, k) => (item?.[k] ?? "").toString());

/* ---------- the two seams (mock adapters for the demo) ---------- */
const initialData = {
  draft: {
    to: "billing@vendor.com",
    subject: "Re: Q3 invoice — pricing discrepancy",
    body:
      "Hi team,\n\nThanks for the invoice. Before we process it, the per-seat rate doesn't match the rate agreed in our March contract. Could you reissue at the contracted figure? Happy to send the signed copy for reference.\n\nBest,\nAlex",
    altPhrasings: [
      "Firmer: We can't process this invoice as-is — it contradicts our signed March terms. Please reissue.",
      "Warmer: I think there may be a small mix-up on the rate vs. our March agreement — could we sort it out?",
    ],
  },
  inbox: [
    { id: "t1", from: "Sarah Chen", snippet: "Can we move the 3pm?", date: "9:02" },
    { id: "t2", from: "Vendor Billing", snippet: "Q3 invoice attached", date: "Tue" },
    { id: "t3", from: "Design weekly", snippet: "Notes from standup", date: "Mon" },
  ],
};

/* ---------- example surfaces (what the model would emit) ---------- */
const SURFACES = {
  email_draft: {
    id: "srf_email",
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
  },
  inbox: {
    id: "srf_inbox",
    intent: "Recent threads",
    ephemeral: true,
    blocks: [
      {
        type: "list",
        id: "lst_1",
        source: { kind: "query", source: "inbox" },
        item: { title: "{{from}}", subtitle: "{{snippet}}", timestamp: "{{date}}" },
        onSelect: { capability: "email.openThread", args: {} },
      },
    ],
  },
};

// How long a silent do-it waits (catchable) before it actually commits.
const AUTOSEND_MS = 4500;

/* ---------- M4: build a review surface from a do-it action ---------- */
// When the router chose "do it silently" but the user taps "show me the draft",
// turn the action's args into a composer+confirm so they can edit and confirm.
// Shaped per capability (email vs calendar) so the right fields show.
function composerFromArgs(capability, args = {}) {
  if (capability === "calendar.createEvent") {
    const draft = {
      summary: args.summary ?? args.title ?? "",
      start: args.start ?? "",
      location: args.location ?? "",
    };
    const surface = {
      id: "srf_review",
      intent: "Review before adding to calendar",
      ephemeral: true,
      blocks: [
        {
          type: "composer",
          id: "cmp_review",
          fields: [
            { key: "summary", label: "Event", binding: { kind: "ref", path: "draft.summary" } },
            { key: "start", label: "When", binding: { kind: "ref", path: "draft.start" } },
            { key: "location", label: "Where", binding: { kind: "ref", path: "draft.location" } },
          ],
        },
        {
          type: "confirm",
          id: "cnf_review",
          summary: `Add "${draft.summary || "event"}" to your calendar?`,
          onConfirm: { capability, args: { event: { kind: "ref", path: "draft" } } },
          onCancel: { capability: "ui.dismiss", args: {} },
        },
      ],
    };
    return { surface, data: { draft } };
  }

  // default: email composer
  const draft = { to: args.to ?? "", subject: args.subject ?? "", body: args.body ?? "" };
  const surface = {
    id: "srf_review",
    intent: "Review before sending",
    ephemeral: true,
    blocks: [
      {
        type: "composer",
        id: "cmp_review",
        fields: [
          { key: "to", label: "To", binding: { kind: "ref", path: "draft.to" } },
          { key: "subject", label: "Subject", binding: { kind: "ref", path: "draft.subject" } },
          { key: "body", label: "Body", binding: { kind: "ref", path: "draft.body" }, multiline: true },
        ],
      },
      {
        type: "confirm",
        id: "cnf_review",
        summary: `Send to ${draft.to || "recipient"}?`,
        preview: { kind: "ref", path: "draft" },
        onConfirm: { capability, args: { draft: { kind: "ref", path: "draft" } } },
        onCancel: { capability: "ui.dismiss", args: {} },
      },
    ],
  };
  return { surface, data: { draft } };
}

/* ============================================================
 *  PRIMITIVES
 * ========================================================== */

function Composer({ node, data, onWrite }) {
  return (
    <div className="prim">
      {node.fields.map((f, i) => {
        const value = data && f.binding.kind === "ref" ? getPath(data, f.binding.path) ?? "" : "";
        const write = (v) => f.binding.kind === "ref" && onWrite(f.binding.path, v);
        const suggestions =
          f.suggestions && f.suggestions.kind === "ref" ? getPath(data, f.suggestions.path) ?? [] : [];
        return (
          <div className="field" key={f.key} style={{ animationDelay: `${0.06 * i}s` }}>
            <label className="label">{f.label}</label>
            {f.multiline ? (
              <textarea className="input area" value={value} rows={7} onChange={(e) => write(e.target.value)} />
            ) : (
              <input className="input" value={value} onChange={(e) => write(e.target.value)} />
            )}
            {suggestions.length > 0 && (
              <div className="chips">
                {suggestions.map((s, j) => (
                  <button className="chip" key={j} title={s} onClick={() => write(s)}>
                    ↻ rephrase {j + 1}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ListView({ node, data, onAction }) {
  const items = node.source.kind === "query" ? data?.[node.source.source] ?? [] : [];
  return (
    <div className="prim list">
      {items.map((item, i) => (
        <button
          className="row"
          key={item.id ?? i}
          style={{ animationDelay: `${0.05 * i}s` }}
          onClick={() => node.onSelect && onAction(node.onSelect, { item })}
        >
          <span className="row-main">
            <span className="row-title">{fillTemplate(node.item.title, item)}</span>
            {node.item.subtitle && <span className="row-sub">{fillTemplate(node.item.subtitle, item)}</span>}
          </span>
          {node.item.timestamp && <span className="row-time">{fillTemplate(node.item.timestamp, item)}</span>}
        </button>
      ))}
    </div>
  );
}

function Confirm({ node, data, onAction }) {
  const preview = node.preview && node.preview.kind === "ref" ? getPath(data, node.preview.path) : null;
  return (
    <div className="prim confirm">
      {preview && (
        <div className="preview">
          <span className="preview-line"><b>To</b> {preview.to}</span>
          <span className="preview-line"><b>Re</b> {preview.subject}</span>
          <p className="preview-body">{preview.body}</p>
        </div>
      )}
      <div className="confirm-bar">
        <span className="confirm-summary">{node.summary}</span>
        <span className="confirm-actions">
          {node.onCancel && (
            <button className="btn ghost" onClick={() => onAction(node.onCancel, {})}>Cancel</button>
          )}
          <button className="btn solid" onClick={() => onAction(node.onConfirm, {})}>Send</button>
        </span>
      </div>
    </div>
  );
}

const PRIMITIVES = { composer: Composer, list: ListView, confirm: Confirm };

/* ============================================================
 *  SURFACE + SHELL
 * ========================================================== */

function SurfaceView({ surface, data, onWrite, onAction, dissolving }) {
  return (
    <div className={`surface ${dissolving ? "dissolve" : ""}`}>
      <div className="surface-head">
        <span className="intent">{surface.intent}</span>
        {surface.ephemeral && <span className="eph">ephemeral · dissolves after use</span>}
      </div>
      {surface.blocks.map((node) => {
        const Prim = PRIMITIVES[node.type];
        return Prim ? (
          <Prim key={node.id} node={node} data={data} onWrite={onWrite} onAction={onAction} />
        ) : (
          <div key={node.id} className="prim err">unknown primitive: {node.type}</div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(initialData);
  const [surfaceKey, setSurfaceKey] = useState("email_draft");
  const [genSurface, setGenSurface] = useState(null); // M2: AI-generated surface
  const [busy, setBusy] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const [toast, setToast] = useState(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(null); // M4: a do-it action awaiting auto-commit
  const pendingTimer = useRef(null);
  const task = useRef(null); // M5: the in-flight task being timed/logged

  // A generated surface wins; otherwise fall back to the hardcoded examples.
  const surface = genSurface ?? (surfaceKey ? SURFACES[surfaceKey] : null);

  const flash = useCallback((msg) => {
    setToast(msg);
    window.clearTimeout(flash._t);
    flash._t = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const onWrite = useCallback((path, value) => {
    if (task.current) task.current.edits += 1; // M5: count edits as a quality signal
    setData((d) => setPath(d, path, value));
  }, []);

  // M5: log a completed task to memory (request, route, edits, time-to-done).
  const remember = useCallback((committed) => {
    const t = task.current;
    if (!t) return;
    task.current = null;
    const record = {
      request: t.request,
      intent: t.intent,
      mode: t.mode,
      edits: t.edits,
      committed,
      routeCorrected: !!t.routeCorrected,
      timeToDoneMs: Date.now() - t.startTs,
    };
    window.railway?.remember?.(record);
  }, []);

  const dissolve = useCallback(() => {
    setDissolving(true);
    window.setTimeout(() => {
      setSurfaceKey(null);
      setGenSurface(null);
      setDissolving(false);
    }, 360);
  }, []);

  // CapabilityRegistry — the action seam. Args arrive resolved here, then the
  // real implementation runs in the main process (Gmail) via window.railway.invoke.
  const onAction = useCallback(
    async (action, ctx) => {
      const resolvedArgs = Object.fromEntries(
        Object.entries(action.args || {}).map(([k, b]) => [
          k,
          b.kind === "ref" ? getPath(data, b.path) : b.kind === "literal" ? b.value : data[b.source],
        ])
      );

      // ui.dismiss is purely local — and abandons the task (M5).
      if (action.capability === "ui.dismiss") {
        remember(false);
        return dissolve();
      }

      // M3+: route real capabilities to the main-process registry (Gmail/Calendar).
      if (window.railway?.invoke) {
        const res = await window.railway.invoke(action.capability, { ...resolvedArgs, ...ctx });
        if (res?.ok) {
          if (action.capability === "email.send") {
            flash(res.simulated ? `Simulated send to ${res.to} ✓` : `Sent to ${res.to} ✓`);
            remember(true); // M5: task done
            dissolve();
          } else if (action.capability === "calendar.createEvent") {
            flash(res.simulated ? `Simulated: added "${res.summary}" ✓` : `Added "${res.summary}" to your calendar ✓`);
            remember(true);
            dissolve();
          } else {
            flash(res.note || "Done ✓");
          }
        } else {
          flash(res?.error || `Capability failed: ${action.capability}`);
        }
        return;
      }

      // Standalone demo fallback (no Electron bridge): mock the effects.
      switch (action.capability) {
        case "email.send":
          flash(`Sent to ${resolvedArgs.draft?.to ?? "recipient"} ✓`);
          remember(true);
          dissolve();
          break;
        case "email.openThread":
          flash(`Would open: "${ctx.item?.from}" — ${ctx.item?.snippet}`);
          break;
        default:
          flash(`Unregistered capability: ${action.capability}`);
      }
    },
    [data, dissolve, flash, remember]
  );

  // Keyword fallback: used standalone (no Electron bridge) or when the AI
  // is unavailable (no API key) or errors. The naive stand-in the AI replaces.
  const keywordRoute = useCallback(
    (text) => {
      const t = text.toLowerCase().trim();
      setGenSurface(null);
      setData(initialData); // hardcoded surfaces resolve against the mock data
      task.current = { request: text, startTs: Date.now(), mode: "keyword", intent: "", edits: 0 };
      // Word boundaries so "mail" doesn't match inside "email" (which would
      // misroute "write the vendor email" to the inbox).
      if (/\b(inbox|threads)\b|\bcheck\b/.test(t)) {
        task.current.intent = "inbox";
        setSurfaceKey("inbox");
        // M3: even on the keyword path, show the real inbox when connected.
        if (window.railway?.resolveQuery) {
          window.railway.resolveQuery("inbox").then((r) => {
            if (r?.ok && Array.isArray(r.items)) setData((d) => ({ ...d, inbox: r.items }));
          });
        }
      } else if (/\b(email|draft|write|reply|vendor|compose)\b/.test(t)) {
        task.current.intent = "email_draft";
        setSurfaceKey("email_draft");
      } else {
        setSurfaceKey(null);
        flash(`"${text}" → the AI would just do this. No surface needed.`);
        remember(true); // nothing to show — counts as done immediately
      }
    },
    [flash, remember]
  );

  // M4: clear any pending do-it action and its auto-commit timer.
  const clearPending = useCallback(() => {
    if (pendingTimer.current) {
      window.clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    }
    setPending(null);
  }, []);

  // M4: actually run a routed do-it action (the silent path) for real.
  const commitPending = useCallback(
    async (p) => {
      clearPending();
      if (window.railway?.invoke) {
        const res = await window.railway.invoke(p.capability, p.args);
        if (res?.ok) flash(res.simulated ? `Simulated: ${p.summary} ✓` : `${p.summary} ✓`);
        else flash(res?.error || `Failed: ${p.summary}`);
      } else {
        flash(`${p.summary} ✓`); // standalone demo
      }
      remember(true); // M5: do-it task done
    },
    [clearPending, flash, remember]
  );

  // M4: the one-tap fix — "no, show me the draft" turns the action into an
  // editable composer instead of sending. The task continues (now a surface),
  // and we note the route was corrected (a memory signal).
  const showDraftInstead = useCallback(
    (p) => {
      clearPending();
      if (task.current) {
        task.current.routeCorrected = true;
        task.current.mode = "surface";
      }
      const { surface, data: d } = composerFromArgs(p.capability, p.args);
      setData(d);
      setSurfaceKey(null);
      setGenSurface(surface);
    },
    [clearPending]
  );

  // M2/M4: type a request → main routes it (do-it vs show-me) and, for screens,
  // generates a validated Surface. Falls back to keywordRoute with no bridge/key.
  const summon = useCallback(
    async (text) => {
      setDissolving(false);
      clearPending();
      if (!text.trim()) return;
      setQuery("");
      const startTs = Date.now(); // M5: start the time-to-done clock

      if (window.railway?.generate) {
        setBusy(true);
        try {
          const res = await window.railway.generate(text);
          if (res?.ok && res.mode === "do") {
            // Silent do-it, but catchable: show a brief "sending…" with a
            // one-tap escape to the draft before it auto-commits.
            const p = { capability: res.capability, args: res.args, summary: res.summary || res.intent };
            task.current = { request: text, startTs, mode: "do", intent: p.summary, edits: 0 };
            setGenSurface(null);
            setSurfaceKey(null);
            setPending(p);
            pendingTimer.current = window.setTimeout(() => commitPending(p), AUTOSEND_MS);
            return;
          }
          if (res?.ok) {
            task.current = { request: text, startTs, mode: "surface", intent: res.intent || res.surface.intent, edits: 0 };
            setData(res.data || {});
            setSurfaceKey(null);
            setGenSurface(res.surface);
            return;
          }
          if (res && !res.needKey && res.error) flash(res.error.split("\n")[0]);
        } catch {
          flash("generation failed — using keyword fallback");
        } finally {
          setBusy(false);
        }
      }

      keywordRoute(text);
    },
    [flash, keywordRoute, clearPending, commitPending]
  );

  const styles = useMemo(() => CSS, []);

  return (
    <div className="root">
      <style>{styles}</style>
      <div className="stage">
        <header className="brand">
          <span className="dot" />
          <span className="brand-name">railway</span>
          <span className="brand-sub">a surface only when you need one</span>
        </header>

        <div className="bar">
          <span className="prompt">›</span>
          <input
            className="bar-input"
            placeholder="say what you need…  (try: write the vendor email · check inbox · remind me to call mom)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && summon(query)}
          />
        </div>

        <div className="canvas">
          {busy ? (
            <div className="empty">thinking…</div>
          ) : pending ? (
            // M4: the do-it path — done silently, but catchable for a moment.
            <div className="pending">
              <span className="pending-bar" />
              <div className="pending-row">
                <span className="pending-summary">{pending.summary} — doing this now…</span>
                <span className="pending-actions">
                  <button className="btn ghost" onClick={() => showDraftInstead(pending)}>
                    no — show me the draft
                  </button>
                  <button className="btn solid" onClick={() => commitPending(pending)}>
                    do it now
                  </button>
                </span>
              </div>
            </div>
          ) : surface ? (
            <SurfaceView
              surface={surface}
              data={data}
              onWrite={onWrite}
              onAction={onAction}
              dissolving={dissolving}
            />
          ) : (
            <div className="empty">Nothing on screen. That's the point.</div>
          )}
        </div>

        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}

/* ---------- styling (calm, editorial, low-chrome) ---------- */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;1,9..144,500&family=JetBrains+Mono:wght@400;500&display=swap');
.root{
  --paper:#f3efe6; --paper-2:#ebe5d8; --ink:#211d18; --ink-soft:#6b6357;
  --line:#d8d0bf; --clay:#b14d36; --clay-soft:#c9694f;
  min-height:100%; background:
    radial-gradient(120% 80% at 50% -10%, #f7f4ec 0%, var(--paper) 55%, var(--paper-2) 100%);
  font-family:'JetBrains Mono',monospace; color:var(--ink);
  display:flex; justify-content:center; padding:34px 18px 60px;
}
.stage{ width:100%; max-width:600px; }
.brand{ display:flex; align-items:baseline; gap:10px; margin-bottom:22px; }
.dot{ width:8px;height:8px;border-radius:50%;background:var(--clay);
  align-self:center; box-shadow:0 0 0 4px rgba(177,77,54,.14); }
.brand-name{ font-family:'Fraunces',serif; font-style:italic; font-size:21px; letter-spacing:.5px; }
.brand-sub{ font-size:11px; color:var(--ink-soft); letter-spacing:.3px; }
.bar{ display:flex; align-items:center; gap:10px; background:#fffdf8;
  border:1px solid var(--line); border-radius:13px; padding:13px 16px;
  box-shadow:0 1px 0 #fff inset, 0 6px 22px -16px rgba(33,29,24,.5); }
.prompt{ color:var(--clay); font-weight:500; }
.bar-input{ flex:1; border:0; outline:0; background:transparent; color:var(--ink);
  font-family:inherit; font-size:13.5px; }
.bar-input::placeholder{ color:#a89e8c; }
.canvas{ margin-top:20px; min-height:220px; }
.empty{ text-align:center; color:#a89e8c; font-size:12.5px; padding:56px 0; font-style:italic;
  font-family:'Fraunces',serif; }
.surface{ background:#fffdf8; border:1px solid var(--line); border-radius:16px;
  padding:20px; box-shadow:0 18px 50px -30px rgba(33,29,24,.6);
  animation:rise .42s cubic-bezier(.2,.7,.2,1) both; }
.surface.dissolve{ animation:fade .34s ease forwards; }
@keyframes rise{ from{opacity:0; transform:translateY(10px) scale(.985); filter:blur(3px);} to{opacity:1; transform:none; filter:none;} }
@keyframes fade{ to{opacity:0; transform:translateY(-6px) scale(.99); filter:blur(2px);} }
.surface-head{ display:flex; align-items:baseline; justify-content:space-between; gap:12px;
  margin-bottom:16px; padding-bottom:13px; border-bottom:1px dashed var(--line); }
.intent{ font-family:'Fraunces',serif; font-style:italic; font-size:17px; }
.eph{ font-size:9.5px; letter-spacing:.6px; text-transform:uppercase; color:var(--clay); white-space:nowrap; }
.field{ margin-bottom:14px; animation:rise .4s ease both; }
.label{ display:block; font-size:9.5px; letter-spacing:1px; text-transform:uppercase;
  color:var(--ink-soft); margin-bottom:5px; }
.input{ width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:9px;
  background:var(--paper); padding:9px 11px; font-family:inherit; font-size:13px; color:var(--ink); outline:0; }
.input:focus{ border-color:var(--clay-soft); background:#fff; }
.area{ resize:vertical; line-height:1.55; }
.chips{ display:flex; gap:7px; margin-top:7px; flex-wrap:wrap; }
.chip{ border:1px solid var(--line); background:#fff; color:var(--ink-soft);
  border-radius:20px; padding:4px 11px; font-family:inherit; font-size:10.5px; cursor:pointer; }
.chip:hover{ border-color:var(--clay-soft); color:var(--clay); }
.list{ display:flex; flex-direction:column; }
.row{ display:flex; align-items:center; justify-content:space-between; gap:12px; text-align:left;
  border:0; background:transparent; border-bottom:1px solid var(--line); padding:13px 4px;
  font-family:inherit; cursor:pointer; animation:rise .4s ease both; }
.row:last-child{ border-bottom:0; } .row:hover{ background:var(--paper); }
.row-main{ display:flex; flex-direction:column; gap:3px; min-width:0; }
.row-title{ font-size:13px; color:var(--ink); }
.row-sub{ font-size:11.5px; color:var(--ink-soft); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.row-time{ font-size:10.5px; color:#a89e8c; white-space:nowrap; }
.confirm{ margin-top:4px; }
.preview{ background:var(--paper); border:1px solid var(--line); border-radius:10px;
  padding:12px 14px; display:flex; flex-direction:column; gap:4px; margin-bottom:13px; }
.preview-line{ font-size:11.5px; color:var(--ink-soft); } .preview-line b{ color:var(--ink); font-weight:500; margin-right:6px; }
.preview-body{ font-size:12px; line-height:1.55; white-space:pre-wrap; margin:6px 0 0; color:var(--ink); }
.confirm-bar{ display:flex; align-items:center; justify-content:space-between; gap:12px; }
.confirm-summary{ font-size:12px; color:var(--ink-soft); }
.confirm-actions{ display:flex; gap:8px; }
.btn{ border-radius:9px; padding:9px 17px; font-family:inherit; font-size:12px; cursor:pointer; border:1px solid var(--line); }
.btn.ghost{ background:#fff; color:var(--ink-soft); } .btn.ghost:hover{ color:var(--ink); }
.btn.solid{ background:var(--clay); border-color:var(--clay); color:#fdf6f2; }
.btn.solid:hover{ background:var(--clay-soft); }
.err{ color:var(--clay); font-size:12px; }
.pending{ background:#fffdf8; border:1px solid var(--line); border-radius:14px; padding:16px 18px;
  box-shadow:0 14px 40px -28px rgba(33,29,24,.6); animation:rise .3s ease both; overflow:hidden; position:relative; }
.pending-bar{ position:absolute; left:0; top:0; height:3px; background:var(--clay);
  width:100%; transform-origin:left; animation:drain 4.5s linear forwards; }
@keyframes drain{ from{ transform:scaleX(1);} to{ transform:scaleX(0);} }
.pending-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.pending-summary{ font-size:13px; color:var(--ink); font-family:'Fraunces',serif; font-style:italic; }
.pending-actions{ display:flex; gap:8px; }
.toast{ position:fixed; bottom:26px; left:50%; transform:translateX(-50%);
  background:var(--ink); color:var(--paper); padding:10px 18px; border-radius:30px;
  font-size:12px; box-shadow:0 14px 34px -16px rgba(0,0,0,.6); animation:rise .3s ease both; }
`;
