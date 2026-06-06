import React, { useState, useCallback, useMemo } from "react";

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
  const [dissolving, setDissolving] = useState(false);
  const [toast, setToast] = useState(null);
  const [query, setQuery] = useState("");

  const surface = surfaceKey ? SURFACES[surfaceKey] : null;

  const flash = useCallback((msg) => {
    setToast(msg);
    window.clearTimeout(flash._t);
    flash._t = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const onWrite = useCallback((path, value) => setData((d) => setPath(d, path, value)), []);

  const dissolve = useCallback(() => {
    setDissolving(true);
    window.setTimeout(() => {
      setSurfaceKey(null);
      setDissolving(false);
    }, 360);
  }, []);

  // CapabilityRegistry — the action seam. Args arrive resolved.
  const onAction = useCallback(
    (action, ctx) => {
      const resolvedArgs = Object.fromEntries(
        Object.entries(action.args || {}).map(([k, b]) => [
          k,
          b.kind === "ref" ? getPath(data, b.path) : b.kind === "literal" ? b.value : data[b.source],
        ])
      );
      switch (action.capability) {
        case "email.send":
          flash(`Sent to ${resolvedArgs.draft?.to ?? "recipient"} ✓`);
          dissolve();
          break;
        case "email.openThread":
          flash(`Would open: "${ctx.item?.from}" — ${ctx.item?.snippet}`);
          break;
        case "ui.dismiss":
          dissolve();
          break;
        default:
          flash(`Unregistered capability: ${action.capability}`);
      }
    },
    [data, dissolve, flash]
  );

  // The router: do-it vs summon. Naive keyword routing stands in for the model.
  const summon = useCallback(
    (text) => {
      const t = text.toLowerCase().trim();
      setDissolving(false);
      if (!t) return;
      // Word boundaries so "mail" doesn't match inside "email" (which would
      // misroute "write the vendor email" to the inbox). This naive router is
      // the stand-in the M2 AI router replaces.
      if (/\b(inbox|threads)\b|\bcheck\b/.test(t)) setSurfaceKey("inbox");
      else if (/\b(email|draft|write|reply|vendor|compose)\b/.test(t)) setSurfaceKey("email_draft");
      else {
        setSurfaceKey(null);
        flash(`"${text}" → the AI would just do this. No surface needed.`);
      }
      setQuery("");
    },
    [flash]
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
          {surface ? (
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
.toast{ position:fixed; bottom:26px; left:50%; transform:translateX(-50%);
  background:var(--ink); color:var(--paper); padding:10px 18px; border-radius:30px;
  font-size:12px; box-shadow:0 14px 34px -16px rgba(0,0,0,.6); animation:rise .3s ease both; }
`;
