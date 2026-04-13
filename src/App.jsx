import { useState, useRef, useCallback, useEffect } from "react";

let _apiKey = "";
let _hubspotToken = "";
let _addLog = null;
let _tokenAccum = { input: 0, output: 0 };
let _setTokenCount = null;

/* ═══ UTILITIES ═══ */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const delay = sleep;
async function countdownWait(seconds, logFn, label) {
  let remaining = seconds;
  while (remaining > 0) {
    if (logFn && remaining < seconds) logFn("WAIT", "Cooldown", `${label} ${remaining}s remaining...`);
    const chunk = Math.min(remaining, 5);
    await sleep(chunk * 1000);
    remaining -= chunk;
  }
}
function parseNum(s) { if (!s) return 0; return parseInt(String(s).replace(/[^0-9]/g, ""), 10) || 0; }
function truncate(s, max = 2000) { return s && s.length > max ? s.slice(0, max) : (s || ""); }
function ts() { return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

/* ═══ JSON PARSER — 5 FALLBACK STRATEGIES ═══ */
function parseJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  try { const r = JSON.parse(clean); return Array.isArray(r) ? r : r; } catch (e) {}
  const arrStart = clean.indexOf('[');
  const arrEnd = clean.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try { const a = JSON.parse(clean.slice(arrStart, arrEnd + 1)); return { signals: a, companies: a }; } catch (e) {}
  }
  const objStart = clean.indexOf('{');
  const objEnd = clean.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try { return JSON.parse(clean.slice(objStart, objEnd + 1)); } catch (e) {}
  }
  for (const line of clean.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try { const p = JSON.parse(t); return Array.isArray(p) ? { signals: p } : p; } catch (e) {}
    }
  }
  const objects = [];
  const objRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let match;
  while ((match = objRegex.exec(clean)) !== null) {
    try { objects.push(JSON.parse(match[0])); } catch (e) {}
  }
  if (objects.length > 0) return { signals: objects };
  return null;
}

/* ═══ CLAUDE API HELPER ═══
   Model strategy: Sonnet for quality (web search, DM finding),
   Haiku for speed (JSON parsing, outreach generation). */
async function callClaude(systemPrompt, userMessage, useWebSearch = false, maxSearchUses = 3, useModel = null) {
  const addLog = _addLog;
  const model = useModel || (useWebSearch ? 'claude-sonnet-4-20250514' : 'claude-haiku-4-5-20251001');
  const isSonnet = model.includes('sonnet');
  const timeoutMs = (useWebSearch && isSonnet) ? 120000 : 60000;
  const maxTok = useWebSearch ? 1500 : 2048;
  const body = {
    model, max_tokens: maxTok, system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearchUses }];
  }
  const cleanKey = _apiKey.replace(/[^\x20-\x7E]/g, '').trim();
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-api-key': cleanKey,
          'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body), signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status === 429 || res.status === 529) {
        if (addLog) addLog("RATE", "System", `Rate limited — attempt ${attempt + 1}/3, waiting 15s...`, "warn");
        await sleep(15000);
        lastError = new Error('Rate limited');
        continue;
      }
      if (!res.ok) { const errBody = await res.text(); throw new Error(`API ${res.status}: ${errBody.slice(0, 200)}`); }
      const data = await res.json();
      if (data.usage) {
        const inp = data.usage.input_tokens || 0;
        const out = data.usage.output_tokens || 0;
        _tokenAccum.input += inp; _tokenAccum.output += out;
        if (_setTokenCount) _setTokenCount({ ..._tokenAccum });
        if (addLog) addLog("TOK", "Tokens", `${Math.round(inp / 1000)}K in / ${Math.round(out / 1000)}K out (${isSonnet ? 'Sonnet' : 'Haiku'})`, "dim");
      }
      return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (err.name === 'AbortError') {
        if (addLog) addLog("WARN", "System", `Timed out after ${timeoutMs / 1000}s — retrying...`, "warn");
      } else if (attempt < 2) {
        if (addLog) addLog("ERR", "System", `${err.message.slice(0, 100)} — retrying in 15s`, "error");
      }
      if (attempt < 2) await sleep(15000);
    }
  }
  throw lastError || new Error('All retries failed');
}

/* ═══ HUBSPOT PROXY ═══ */
async function hubspot(method, path, body) {
  if (!_hubspotToken) return null;
  const opts = { method, headers: { "Content-Type": "application/json", "x-hubspot-token": _hubspotToken } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/hubspot/${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HubSpot ${res.status}`);
  return data;
}

/* ═══ THEME ═══ */
const T = {
  bg: '#09090b', surface: '#18181b', surfaceHover: '#1f1f23', border: '#27272a', borderLight: '#3f3f46',
  text: '#fafafa', textSecondary: '#a1a1aa', textMuted: '#71717a', textDim: '#52525b',
  blue: '#3b82f6', blueDim: '#1e3a5f', green: '#22c55e', greenDim: '#14532d',
  red: '#ef4444', redDim: '#450a0a', orange: '#f59e0b', orangeDim: '#451a03',
  purple: '#8b5cf6', purpleDim: '#2e1065', cyan: '#06b6d4', linkedIn: '#0077b5',
};

const PRESETS = [
  "Mid-market mortgage lenders hiring call center agents",
  "Regional insurance carriers hiring claims phone reps",
  "Credit unions hiring member service reps",
  "Auto lenders hiring loan servicing phone agents",
];

/* ═══════════════ APP ROOT ═══════════════ */
export default function App() {
  const [page, setPage] = useState("pipeline");
  const [keys, setKeys] = useState({ a: "", h: "" });
  const [connected, setConnected] = useState({ a: false, h: false });
  const [hsVerified, setHsVerified] = useState(null); // null=unchecked, true=ok, false=bad
  const [hsVerifying, setHsVerifying] = useState(false);

  const updateKey = (k, v) => {
    const clean = v.replace(/[^\x20-\x7E]/g, "").trim();
    setKeys(p => ({ ...p, [k]: clean }));
    if (k === "a") { _apiKey = clean; setConnected(p => ({ ...p, a: !!clean })); }
    if (k === "h") { _hubspotToken = clean; setConnected(p => ({ ...p, h: !!clean })); setHsVerified(null); }
  };

  const verifyHubSpot = async () => {
    if (!keys.h) return;
    setHsVerifying(true);
    try {
      const res = await fetch('/api/hubspot/crm/v3/objects/companies?limit=1', {
        headers: { 'x-hubspot-token': keys.h }
      });
      setHsVerified(res.ok);
    } catch {
      setHsVerified(false);
    }
    setHsVerifying(false);
  };

  const hsConnected = connected.h && hsVerified === true;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Inter',-apple-system,BlinkMacSystemFont,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}button{cursor:pointer;font-family:inherit}input:focus{outline:none}
        ::selection{background:${T.blueDim};color:${T.text}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:translateX(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
        .fu{animation:fadeUp .25s ease-out both}.si{animation:slideIn .15s ease-out both}
        .card{background:${T.surface};border:1px solid ${T.border};border-radius:12px;transition:border-color .2s}
        input[type=password],input[type=text]{background:${T.surface};border:1px solid ${T.border};border-radius:8px;padding:9px 12px;font-size:13px;color:${T.text};font-family:'JetBrains Mono',monospace;transition:border-color .2s,box-shadow .2s;width:100%}
        input[type=password]:focus,input[type=text]:focus{border-color:${T.blue};box-shadow:0 0 0 3px ${T.blueDim}44}
        .btn-primary{background:${T.blue};color:#fff;border:none;border-radius:8px;padding:9px 20px;font-size:13px;font-weight:600;transition:opacity .15s,transform .1s;letter-spacing:.01em}
        .btn-primary:hover{opacity:.88}.btn-primary:active{transform:scale(.98)}.btn-primary:disabled{opacity:.3;cursor:not-allowed}
        .btn-ghost{background:transparent;border:1px solid ${T.border};color:${T.textSecondary};border-radius:8px;padding:8px 16px;font-size:12px;font-weight:500;transition:all .15s}
        .btn-ghost:hover{border-color:${T.borderLight};color:${T.text};background:${T.surfaceHover}}
        .btn-ghost:disabled{opacity:.3;cursor:not-allowed}
        .tab-btn{padding:10px 18px;font-size:12.5px;font-weight:500;border:none;background:transparent;transition:color .15s;border-bottom:2px solid transparent;cursor:pointer}
        .tab-btn:hover{color:${T.textSecondary}!important}
        .company-card{background:${T.surface};border:2px solid ${T.border};border-radius:12px;padding:16px 18px;cursor:pointer;transition:border-color .15s,box-shadow .15s}
        .company-card:hover{border-color:${T.borderLight};box-shadow:0 2px 12px #000a}
        .company-card.selected{border-color:${T.blue};box-shadow:0 0 0 1px ${T.blue}44}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:${T.border};border-radius:2px}
        ::-webkit-scrollbar-thumb:hover{background:${T.borderLight}}
      `}</style>

      {/* ── NAV ── */}
      <nav style={{
        background: `${T.bg}ee`, backdropFilter: "blur(12px)", borderBottom: `1px solid ${T.border}`,
        padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between",
        height: 54, position: "sticky", top: 0, zIndex: 100
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: T.blueDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5L12 3Z" fill={T.blue} opacity=".9"/>
                <path d="M8 16c2-5 5-8 9-10-2 3-3 5.5-3.5 8.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </div>
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.02em", color: T.text }}>Feather</span>
            <span style={{ fontSize: 10, color: T.textDim, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 6px", fontWeight: 500 }}>Pipeline</span>
          </div>
          <div style={{ height: 18, width: 1, background: T.border }} />
          {[["pipeline", "Pipeline"], ["architecture", "How it works"]].map(([id, l]) => (
            <button key={id} onClick={() => setPage(id)} style={{
              padding: "5px 12px", borderRadius: 6, fontSize: 13, fontWeight: 500, border: "none",
              background: page === id ? T.blueDim : "transparent",
              color: page === id ? T.blue : T.textMuted,
              transition: "all .15s"
            }}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {connected.a && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: T.green }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.green, display: "inline-block", animation: "pulse 2s infinite" }} />
              Claude connected
            </div>
          )}
          {connected.h && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: hsVerified === true ? T.orange : hsVerified === false ? T.red : T.textMuted }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: hsVerified === true ? T.orange : hsVerified === false ? T.red : T.textDim, display: "inline-block" }} />
              HubSpot {hsVerified === true ? "ready" : hsVerified === false ? "invalid" : "unverified"}
            </div>
          )}
        </div>
      </nav>

      {/* ── KEYS BAR ── */}
      {(!connected.a || !connected.h) && (
        <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "16px 28px" }} className="fu">
          <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: ".05em" }}>
                Anthropic API Key {connected.a && <span style={{ color: T.green, fontWeight: 700 }}>&#10003; connected</span>}
              </div>
              <input type="password" placeholder="sk-ant-api03-..." value={keys.a} onChange={e => updateKey("a", e.target.value)}
                style={{ borderColor: connected.a ? T.green : T.border }} />
            </div>
            <div style={{ flex: "1 1 260px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: ".05em" }}>
                HubSpot Token <span style={{ fontWeight: 400, color: T.textDim }}>(optional)</span>
                {hsVerified === true && <span style={{ color: T.green, fontWeight: 700 }}> &#10003; verified</span>}
                {hsVerified === false && <span style={{ color: T.red, fontWeight: 700 }}> &#10007; invalid token</span>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="password" placeholder="pat-na1-..." value={keys.h} onChange={e => updateKey("h", e.target.value)}
                  style={{ flex: 1, borderColor: hsVerified === true ? T.green : hsVerified === false ? T.red : T.border }} />
                {connected.h && (
                  <button onClick={verifyHubSpot} disabled={hsVerifying} className="btn-ghost" style={{ whiteSpace: "nowrap", fontSize: 11 }}>
                    {hsVerifying ? "Checking..." : "Verify"}
                  </button>
                )}
              </div>
            </div>
            {!connected.a && (
              <div style={{ fontSize: 11, color: T.textDim, lineHeight: 1.6, paddingBottom: 2, flex: "0 0 200px" }}>
                Keys stay in memory only.<br/>Never stored or sent to our servers.
              </div>
            )}
          </div>
        </div>
      )}

      {page === "pipeline" ? <Pipeline hs={hsConnected} /> : <Arch />}
    </div>
  );
}

/* ═══════════════ PIPELINE ═══════════════ */
function Pipeline({ hs }) {
  const [query, setQuery] = useState(PRESETS[0]);
  const [phase, setPhase] = useState("idle");
  const [signals, setSignals] = useState([]);
  const [qualified, setQualified] = useState([]);
  const [approved1, setApproved1] = useState(new Set());
  const [enriched, setEnriched] = useState([]);
  const [approved2, setApproved2] = useState(new Set());
  const [final, setFinal] = useState([]);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [tabs, setTabs] = useState({});
  const [hsStatus, setHsStatus] = useState({});
  const [logs, setLogs] = useState([]);
  const [tokenCount, setTokenCount] = useState({ input: 0, output: 0 });
  const running = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const logEnd = useRef(null);
  const [runGuard, setRunGuard] = useState(false);
  const abortRef = useRef(null);

  const log = useCallback((icon, src, msg, type = "info") => {
    setLogs(p => [...p, { icon, src, msg, type, time: ts() }]);
  }, []);
  _addLog = log;
  _setTokenCount = setTokenCount;

  useEffect(() => { logEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  const resetPipeline = useCallback(() => {
    setSignals([]); setQualified([]); setApproved1(new Set()); setEnriched([]);
    setApproved2(new Set()); setFinal([]); setExpanded(null); setLogs([]);
    setError(null); setHsStatus({}); setElapsed(0); setTabs({}); setTokenCount({ input: 0, output: 0 });
    clearInterval(timerRef.current); timerRef.current = null;
    _tokenAccum = { input: 0, output: 0 };
  }, []);

  const cancelPipeline = useCallback(() => {
    abortRef.current?.abort();
    running.current = false;
    clearInterval(timerRef.current);
    log("STOP", "System", "Pipeline cancelled", "warn");
    setPhase("idle");
    setRunGuard(false);
  }, [log]);

  /* ── HUBSPOT PUSH ── */
  const pushHS = async (item) => {
    if (!_hubspotToken) return;
    const id = item.company.name;
    setHsStatus(p => ({ ...p, [id]: "pushing" }));
    try {
      const empCount = parseNum(item.company.employees);
      let coId = null;
      try {
        const searchRes = await hubspot("POST", "crm/v3/objects/companies/search", {
          filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: item.company.name }] }], limit: 1
        });
        if (searchRes?.results?.length > 0) {
          coId = searchRes.results[0].id;
          log("HS", "HubSpot", `Found existing company: ${item.company.name}`, "info");
        }
      } catch { /* will create new */ }

      if (!coId) {
        const co = await hubspot("POST", "crm/v3/objects/companies", {
          properties: {
            name: item.company.name,
            industry: item.signal?.industry || item.company.industry || "",
            numberofemployees: empCount || undefined,
            description: truncate(`ICP Score: ${item.company.total_score}/10. Hiring ${item.signal?.num_openings || "multiple"}x ${item.signal?.role_title || "phone agents"}. Source: ${item.signal?.source || "web"}.`, 2000)
          }
        });
        coId = co?.id;
      }

      if (item.dm?.name && item.dm.name !== "N/A" && item.dm.email_guess && item.dm.email_guess.includes("@")) {
        const names = item.dm.name.trim().split(/\s+/);
        await hubspot("POST", "crm/v3/objects/contacts", {
          properties: {
            firstname: names[0] || "", lastname: names.slice(1).join(" ") || "",
            jobtitle: item.dm.title || "", company: item.company.name,
            email: item.dm.email_guess,
            hs_content_membership_notes: truncate(item.dm.background || "", 500),
          },
          associations: coId ? [{ to: { id: coId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 1 }] }] : []
        });
      }

      const savings = parseNum(item.roi?.savings);
      const desc = truncate([
        `DM: ${item.dm?.name || "TBD"} (${item.dm?.title || ""})`,
        item.dm?.email_guess ? `Email: ${item.dm.email_guess}` : "",
        item.dm?.linkedin_url ? `LinkedIn: ${item.dm.linkedin_url}` : "",
        savings ? `ROI: $${Math.round(savings / 1000)}K/yr savings` : "",
        item.outreach?.email?.body ? `\nEmail:\n${item.outreach.email.body}` : "",
      ].filter(Boolean).join("\n"), 2000);

      await hubspot("POST", "crm/v3/objects/deals", {
        properties: {
          dealname: `Feather — ${item.company.name}`, pipeline: "default",
          dealstage: "appointmentscheduled", amount: savings > 0 ? String(savings) : "100000",
          description: desc,
        },
        associations: coId ? [{ to: { id: coId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }] }] : []
      });

      setHsStatus(p => ({ ...p, [id]: "done" }));
      log("HS", "HubSpot", `Pushed ${item.company.name}: company + contact + deal`, "success");
    } catch (err) {
      const reason = err.message.includes("409") ? "Duplicate — already in HubSpot" :
        err.message.includes("401") ? "Invalid token — re-verify in settings" :
        err.message.includes("429") ? "Rate limit — wait 60s and retry" : err.message.slice(0, 100);
      setHsStatus(p => ({ ...p, [id]: "error" }));
      log("ERR", "HubSpot", `${item.company.name}: ${reason}`, "error");
    }
  };

  /* ══════════════════════════════════════════
     PHASE 1: SCAN + ICP QUALIFY

     ICP scoring model — 6 weighted factors:
     1. PHONE OPERATION INTENSITY — weight 25%
     2. INDUSTRY ALIGNMENT — weight 20%
     3. AI VOICE READINESS — weight 20%
     4. COMPANY SIZE fit — weight 15%
     5. BUDGET SIGNAL — weight 10%
     6. TIMING URGENCY — weight 10%
  ══════════════════════════════════════════ */
  const runScan = useCallback(async (input) => {
    if (running.current || runGuard) return;
    running.current = true;
    setRunGuard(true);
    abortRef.current = new AbortController();
    resetPipeline();
    setPhase("scanning");
    timerRef.current = setInterval(() => setElapsed(p => p + 1), 1000);

    try {
      const today = new Date().toLocaleDateString();
      log("SCAN", "System", "Starting web search for hiring signals...");

      const proseResult = await callClaude(
        `Hiring research agent. Today: ${today}. Search for mid-market companies (100-5K employees) in mortgage, lending, insurance, credit unions actively hiring call center/phone agents. For each: company name, industry, employee count, HQ location, job titles, openings count, job board source, posting date, URL. Prioritize last 14 days. NOT mega-corps (Wells Fargo, JPMorgan, Capital One, GEICO, BofA, Rocket Mortgage).`,
        `Search for: ${input}. Find 5-8 real companies with active job postings. Write a prose report — no JSON.`,
        true, 3
      );

      if (abortRef.current?.signal.aborted) throw new Error("Cancelled");

      log("WAIT", "System", "Cooling down 20s before parsing...");
      await countdownWait(20, log, "Cooldown —");

      if (abortRef.current?.signal.aborted) throw new Error("Cancelled");

      log("PARSE", "System", "Parsing results into structured data...");
      const s1 = await callClaude(
        "Convert the research report into a JSON object. Return ONLY valid JSON — no markdown, no backticks, no explanation. Start with { and key \"signals\".",
        `Convert this into JSON: {"signals":[{"company":"","role_title":"","location":"","num_openings":3,"industry":"","signal_strength":"high","days_ago":7,"source":"Indeed","job_url":"","posted_date":""}]}\n\nReport:\n${proseResult}`,
        false
      );

      let d1 = parseJSON(s1);
      if (!d1?.signals?.length) {
        try { for (const line of (s1 || "").split("\n")) { const a = parseJSON(line); if (a?.signals?.length) { d1 = a; break; } } } catch (e) {}
      }
      if (!d1?.signals?.length) throw new Error("No signals found — try again in 60s or adjust your query.");

      const fresh = d1.signals.filter(s => !s.days_ago || s.days_ago <= 14);
      const useSignals = fresh.length > 0 ? fresh : d1.signals;
      if (!useSignals.length) throw new Error("No signals found — try a different query.");
      setSignals(useSignals);

      if (fresh.length === 0 && d1.signals.length > 0) log("WARN", "System", "No freshness data — showing all results");

      useSignals.forEach(s => {
        log("SIG", "Signal", `${s.company} — ${s.num_openings || "?"}x ${s.role_title || "phone agent"} (${s.location || "US"}) via ${s.source || "web"}`);
      });

      log("ICP", "System", "Scoring companies against ICP model...");

      const aiVendorRegex = /vapi|retell|bland|synthflow|poly\.ai|replicant|parloa|five9.*ai|cognigy/i;
      const govRegex = /government|federal|state agency|municipal|county\s+of|city\s+of|dept\s+of/i;

      const companies = useSignals.map(s => {
        const r = (s.role_title || "") + " " + (s.company || "");
        const ind = s.industry || "";
        const fullText = r + " " + ind;
        const openings = s.num_openings || 3;
        const days = s.days_ago || 7;
        const empNum = parseNum(s.employee_count || s.employees);

        const coreInd = /mortgage|lending|loan|insurance|credit union|underwriting/i.test(fullText);
        const adjInd = /bank|fintech|financial|collection|servic/i.test(fullText);
        const industryScore = coreInd ? 2 : adjInd ? 1 : 0;

        const sizeScore = empNum >= 200 && empNum <= 2000 ? 2 : (empNum >= 100 && empNum <= 5000) ? 1 : empNum === 0 ? 1 : 0;

        const phoneRole = /call center|phone|customer service|collections|loan servicing|inbound|outbound|representative|agent/i.test(r);
        const phoneScore = phoneRole ? (openings >= 5 ? 2 : 1) : 0;

        const hasAiVoice = aiVendorRegex.test(fullText);
        const aiScore = hasAiVoice ? 0 : 1;

        const budgetScore = openings >= 5 ? 2 : openings >= 3 ? 1 : 0;

        const timingScore = days <= 7 ? (openings >= 5 ? 2 : 1) : 0;

        const weighted = (phoneScore * 25 + industryScore * 20 + aiScore * 20 + sizeScore * 15 + budgetScore * 10 + timingScore * 10) / 20;
        const score = Math.round(weighted * 10) / 10;

        let rejectReason = null;
        if (hasAiVoice) rejectReason = "Has AI voice vendor";
        if (govRegex.test(fullText)) rejectReason = "Government entity";
        if (empNum > 5000) rejectReason = ">5K employees";
        if (empNum > 0 && empNum < 50) rejectReason = "<50 employees";

        const empLabel = empNum > 0 ? `~${empNum.toLocaleString()}` : "200-2,000 (est.)";

        return {
          name: s.company, total_score: score, qualified: score >= 6.0 && !rejectReason,
          reject_reason: rejectReason, industry: ind, employees: empLabel,
          revenue: empNum > 1000 ? "Est. $100M-$1B" : empNum > 200 ? "Est. $50M-$500M" : "Unknown",
          estimated_contract_value: "$" + (openings * 15000).toLocaleString() + "/yr",
          reasoning: `${openings}x ${s.role_title || "phone"} roles in ${ind || "financial services"}`,
          scores: { industry: industryScore, size: sizeScore, phone_intensity: phoneScore, ai_readiness: aiScore, budget: budgetScore, timing: timingScore },
          evidence: {
            industry: coreInd ? `Core ${ind} vertical` : adjInd ? "Adjacent financial services" : "Non-target industry",
            size: empNum > 0 ? `${empNum.toLocaleString()} employees` : "Size not confirmed — defaulting mid-market",
            phone_intensity: `${openings} ${s.role_title || "phone"} openings found`,
            ai_readiness: hasAiVoice ? "AI voice vendor detected — disqualified" : "No existing AI voice vendor detected",
            budget: openings >= 5 ? `${openings} concurrent hires = strong budget signal` : openings >= 3 ? `${openings} hires = moderate budget` : "Few openings",
            timing: days <= 7 ? `Posted ~${days}d ago — urgent` : `Posted ~${days}d ago`
          }
        };
      });

      companies.sort((a, b) => b.total_score - a.total_score);
      setQualified(companies);

      companies.filter(c => c.qualified).forEach(c => log("PASS", "ICP", `${c.name} — ${c.total_score}/10`, "success"));
      companies.filter(c => !c.qualified).forEach(c => log("SKIP", "ICP", `${c.name} — ${c.total_score}/10${c.reject_reason ? ` (${c.reject_reason})` : " (below 6.0)"}`, "dim"));

      if (!companies.some(c => c.qualified)) throw new Error("No companies qualified — try a different vertical.");
      log("GATE", "System", "Awaiting your review — select companies below", "gate");
      setPhase("gate1"); clearInterval(timerRef.current);
    } catch (e) { setError(e.message); log("ERR", "System", e.message, "error"); clearInterval(timerRef.current); setPhase("idle"); }
    finally { running.current = false; setRunGuard(false); }
  }, [log, resetPipeline, runGuard]);

  /* ── PHASE 2: FIND DMS ── */
  const runEnrich = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    abortRef.current = new AbortController();
    setPhase("enriching"); timerRef.current = setInterval(() => setElapsed(p => p + 1), 1000);
    const picked = qualified.filter(c => c.qualified && approved1.has(c.name));
    try {
      const results = [];
      let _idx = 0;
      for (const co of picked) {
        try {
          if (abortRef.current?.signal.aborted) throw new Error("Cancelled");
          const sig = signals.find(s => s.company === co.name) || signals[0];
          log("DM", "System", `Searching for decision maker at ${co.name}...`);

          const s3 = await callClaude(
            "Contact research agent. Find ONE decision maker. Return ONLY valid JSON.",
            `Find the decision maker at ${co.name} (${co.employees} emp, ${co.industry || sig?.industry || ""}) who would buy AI voice software.\n\nTarget: VP Ops, COO, Dir Contact Center, VP CX, CTO. NOT recruiters/agents/CEO.\n\nReturn JSON:\n{"dm":{"name":"","title":"","linkedin_url":"","email_guess":"","confidence":"high/medium/low","why":"one line","background":"1-2 sentences for outreach personalization"}}`,
            true, 2
          );
          const d3 = parseJSON(s3);
          const dm = d3?.dm || { name: "N/A", title: "Ops Leader", confidence: "low", background: "" };

          if (dm.email_guess && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dm.email_guess)) {
            dm.email_guess = ""; dm.confidence = "low";
            log("WARN", "System", `Email for ${co.name} failed format check — removed`);
          }
          if (dm.linkedin_url && !dm.linkedin_url.startsWith("http")) {
            if (dm.linkedin_url.startsWith("linkedin.com") || dm.linkedin_url.startsWith("www.linkedin")) {
              dm.linkedin_url = "https://" + dm.linkedin_url;
            } else { dm.linkedin_url = ""; }
          }
          if (dm.email_guess) {
            const emailDomain = dm.email_guess.split("@")[1]?.toLowerCase() || "";
            const coWords = co.name.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
            const domainMatch = coWords.some(w => w.length > 3 && emailDomain.includes(w));
            if (!domainMatch && dm.confidence === "high") dm.confidence = "medium";
          }

          log("DM", "Result", `${dm.name} — ${dm.title} (${dm.confidence})`, "success");
          results.push({ company: co, signal: sig, dm });
          setEnriched([...results]);
          _idx++;
          if (_idx < picked.length) { log("WAIT", "System", "Waiting 10s between searches..."); await delay(10000); }
        } catch (err) { log("ERR", "System", `${co.name}: ${err.message} — skipping`, "error"); _idx++; }
      }
      if (results.length === 0) throw new Error("No contacts found.");
      log("GATE", "System", "Verify contacts — check LinkedIn before proceeding", "gate");
      setPhase("gate2"); clearInterval(timerRef.current);
    } catch (e) { setError(e.message); log("ERR", "System", e.message, "error"); clearInterval(timerRef.current); setPhase("idle"); }
    finally { running.current = false; }
  }, [qualified, approved1, signals, log]);

  /* ── PHASE 3: ROI + OUTREACH ── */
  const runOutreach = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    abortRef.current = new AbortController();
    setPhase("outreach"); timerRef.current = setInterval(() => setElapsed(p => p + 1), 1000);
    const picked = enriched.filter(e => approved2.has(e.company.name));
    try {
      log("WAIT", "System", "Waiting 15s before generation to reset rate limits...");
      await sleep(15000);
      const results = [];
      for (let idx = 0; idx < picked.length; idx++) {
        const item = picked[idx];
        try {
          if (abortRef.current?.signal.aborted) throw new Error("Cancelled");
          log("GEN", "System", `Generating ROI + outreach for ${item.company.name}...`);

          const bgContext = item.dm.background ? `\n\nDM BACKGROUND — use this to personalize:\n${item.dm.background}` : "";
          const s4 = await callClaude(
            "B2B sales copywriter at an AI voice startup called Feather. You write punchy, specific, human outreach that gets replies. No fluff, no buzzwords, no \"hope this finds you well.\" Lead with concrete numbers. Return ONLY valid JSON.",
            `Generate ROI analysis and outreach for ${item.company.name} (${item.company.employees} emp, ${item.company.industry || item.signal?.industry || "financial services"}).

CONTEXT: They're hiring ${item.signal?.num_openings || 8}x ${item.signal?.role_title || "phone agents"} in ${item.signal?.location || "US"}. Feather replaces phone agents with AI voice agents at $0.07/min.${bgContext}

DECISION MAKER: ${item.dm.name}, ${item.dm.title}

GENERATE:

1. ROI — be specific and realistic:
   - Current cost: ${item.signal?.num_openings || 8} agents x $45K avg salary x 1.3 (benefits) + $4K training each
   - Feather cost: 50 calls/agent/day x 5min avg x 250 days x $0.07/min
   - Show the delta

2. COLD EMAIL (under 80 words, ready to send):
   - Subject line under 50 chars — no clickbait
   - Open with their specific job posting for ${item.signal?.role_title || "phone agents"}
   - One sentence on the savings number
   - One sentence on Feather
   - Close with "15 mins this week?" — be specific
   - Sign as "Krish" from Feather
   - Tone: direct, peer-to-peer, no superlatives

3. LINKEDIN CONNECTION NOTE (under 280 chars):
   - Reference something specific about them (background, role, company)
   - No pitch — just a genuine reason to connect
   - Tone: casual, human

4. LINKEDIN FOLLOW-UP (under 120 words, sent after they accept):
   - Reference the hiring signal naturally
   - Share the savings number
   - Ask for 15 mins — make it easy to say yes

5. LINKEDIN POST (under 180 words):
   - Insight about AI in their industry (don't name the company)
   - Lead with a surprising stat or counterintuitive take
   - End with a question that drives comments
   - Tone: thought leader, not salesperson

Return JSON:
{"roi":{"hiring_annual":0,"feather_annual":0,"savings":0,"pct":0},"email":{"subject":"","body":""},"linkedin":{"note":"","followup":""},"post":""}`, false);
          const d4 = parseJSON(s4);
          if (d4?.roi) log("ROI", "Result", `${item.company.name}: $${Math.round((d4.roi.savings || 0) / 1000)}K/yr savings (${d4.roi.pct || 0}%)`, "success");
          results.push({ ...item, roi: d4?.roi || {}, outreach: { email: d4?.email, linkedin: d4?.linkedin, post: d4?.post } });
          setFinal([...results]);
          if (idx < picked.length - 1) { log("WAIT", "System", "Waiting 12s between companies..."); await sleep(12000); }
        } catch (err) { log("ERR", "System", `${item.company.name}: ${err.message} — skipping`, "error"); }
      }
      log("DONE", "System", `Pipeline complete — ${results.length} companies ready`, "success");
      setPhase("done"); clearInterval(timerRef.current);
    } catch (e) { setError(e.message); log("ERR", "System", e.message, "error"); clearInterval(timerRef.current); setPhase("idle"); }
    finally { running.current = false; }
  }, [enriched, approved2, log]);

  const isRunning = ["scanning", "enriching", "outreach"].includes(phase);
  const stageMap = { idle: -1, scanning: 0, gate1: 1, enriching: 2, gate2: 3, outreach: 4, done: 5 };
  const stageIdx = stageMap[phase] ?? -1;
  const STAGES = [
    { id: "scanning", label: "Scan" },
    { id: "gate1", label: "Review" },
    { id: "enriching", label: "Enrich" },
    { id: "gate2", label: "Verify" },
    { id: "outreach", label: "Generate" },
    { id: "done", label: "Done" },
  ];
  const costEst = (((_tokenAccum.input * 3 + _tokenAccum.output * 15) / 1000000) || 0).toFixed(3);
  const qualifiedList = qualified.filter(c => c.qualified);
  const pipelineValue = qualifiedList.reduce((sum, c) => sum + parseNum(c.estimated_contract_value?.replace(/[^0-9]/g, "")), 0);

  return (
    <div style={{ maxWidth: 1160, margin: "0 auto", padding: "28px 24px" }}>
      <div style={{ display: "flex", gap: 22 }}>
        {/* ── MAIN COLUMN ── */}
        <div style={{ flex: "1 1 0", minWidth: 0 }}>

          {/* ── SEARCH BAR ── */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, display: "flex", alignItems: "center", paddingLeft: 14, paddingRight: 4, transition: "border-color .2s", gap: 8 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                  <circle cx="11" cy="11" r="8" stroke={T.textDim} strokeWidth="2"/>
                  <path d="M21 21l-4.35-4.35" stroke={T.textDim} strokeWidth="2" strokeLinecap="round"/>
                </svg>
                <input value={query} onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && !isRunning && _apiKey && runScan(query)}
                  disabled={isRunning} placeholder="Describe your target vertical..."
                  style={{ flex: 1, background: "transparent", border: "none", color: T.text, fontSize: 14, padding: "12px 0", fontFamily: "inherit" }} />
                <button onClick={() => runScan(query)} disabled={isRunning || !query.trim() || !_apiKey} className="btn-primary" style={{ padding: "8px 20px", margin: "4px" }}>
                  {isRunning ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ width: 10, height: 10, border: "2px solid #fff6", borderTopColor: "#fff", borderRadius: "50%", animation: "spin .7s linear infinite", display: "inline-block" }} />
                      Running
                    </span>
                  ) : "Run pipeline"}
                </button>
              </div>
              {isRunning && (
                <button onClick={cancelPipeline} style={{
                  background: T.redDim, color: T.red, border: `1px solid #7f1d1d`,
                  borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap"
                }}>Stop</button>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {PRESETS.map(p => (
                <button key={p} onClick={() => { setQuery(p); if (!isRunning && _apiKey) runScan(p); }}
                  disabled={isRunning} className="btn-ghost"
                  style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6 }}>{p}</button>
              ))}
            </div>
          </div>

          {/* ── PROGRESS ── */}
          {stageIdx >= 0 && (
            <div className="card fu" style={{ padding: "14px 18px", marginBottom: 16 }}>
              {/* Stage labels */}
              <div style={{ display: "flex", marginBottom: 8 }}>
                {STAGES.map((s, i) => (
                  <div key={s.id} style={{ flex: 1, textAlign: "center" }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600,
                      color: i < stageIdx ? (phase === "done" ? T.green : T.blue) :
                        i === stageIdx ? (phase === "done" ? T.green : T.blue) : T.textDim,
                      textTransform: "uppercase", letterSpacing: ".04em"
                    }}>{s.label}</span>
                  </div>
                ))}
              </div>
              {/* Progress bar */}
              <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
                {STAGES.map((_, i) => (
                  <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, overflow: "hidden", background: T.bg }}>
                    <div style={{
                      height: "100%", borderRadius: 2,
                      background: i < stageIdx ? (phase === "done" ? T.green : T.blue) :
                        i === stageIdx ? (isRunning ? T.blue : phase === "done" ? T.green : T.orange) : "transparent",
                      transition: "background .4s",
                      width: i < stageIdx ? "100%" : i === stageIdx ? "100%" : "0%"
                    }} />
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {isRunning && <div style={{ width: 8, height: 8, border: `2px solid ${T.blue}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin .7s linear infinite" }} />}
                  {phase === "done" && <span style={{ color: T.green }}>&#10003;</span>}
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: phase === "done" ? T.green : (phase === "gate1" || phase === "gate2") ? T.orange : isRunning ? T.blue : T.textSecondary }}>
                    {phase === "gate1" ? "Select companies to enrich" :
                      phase === "gate2" ? "Verify contacts before generating outreach" :
                      phase === "done" ? "Pipeline complete" :
                      phase === "scanning" ? "Searching job boards and scoring..." :
                      phase === "enriching" ? "Finding decision makers..." :
                      phase === "outreach" ? "Generating personalized outreach..." : ""}
                  </span>
                </div>
                <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: T.textDim }}>
                  {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
                </span>
              </div>
            </div>
          )}

          {/* ── ERROR ── */}
          {error && (
            <div className="fu" style={{ background: T.redDim, border: `1px solid #7f1d1d`, borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke={T.red} strokeWidth="2"/><path d="M12 8v4M12 16h.01" stroke={T.red} strokeWidth="2" strokeLinecap="round"/></svg>
              <span style={{ color: "#fca5a5", fontSize: 13 }}>{error}</span>
            </div>
          )}

          {/* ── EMPTY STATE ── */}
          {phase === "idle" && !error && (
            <div className="fu" style={{ background: T.surface, border: `1px dashed ${T.border}`, borderRadius: 14, padding: "60px 32px", textAlign: "center", marginBottom: 16 }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: T.blueDim, margin: "0 auto 18px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                  <path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5L12 3Z" fill={T.blue} opacity=".9"/>
                  <path d="M8 16c2-5 5-8 9-10-2 3-3 5.5-3.5 8.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </div>
              <div style={{ fontSize: 17, fontWeight: 700, color: T.text, marginBottom: 8 }}>Ready to find buyers</div>
              <div style={{ fontSize: 13, color: T.textMuted, maxWidth: 420, margin: "0 auto 24px", lineHeight: 1.7 }}>
                Feather scans job boards for companies hiring phone agents — your best signal that AI voice can save them money. You stay in control at every step.
              </div>
              <div style={{ display: "flex", justifyContent: "center", gap: 0 }}>
                {["Scan signals", "ICP qualify", "Find DMs", "Generate outreach"].map((s, i, arr) => (
                  <span key={s} style={{ display: "flex", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: T.textMuted, background: T.bg, padding: "5px 12px", borderRadius: 6, border: `1px solid ${T.border}` }}>{s}</span>
                    {i < arr.length - 1 && <span style={{ color: T.textDim, margin: "0 4px", fontSize: 12 }}>&#8594;</span>}
                  </span>
                ))}
              </div>
              {!_apiKey && (
                <div style={{ marginTop: 20, fontSize: 12, color: T.orange, background: T.orangeDim, border: `1px solid ${T.orange}33`, borderRadius: 8, padding: "8px 16px", display: "inline-block" }}>
                  Add your Anthropic API key above to get started
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════
              GATE 1: COMPANY REVIEW
          ══════════════════════════════════════════ */}
          {phase === "gate1" && (
            <div className="fu" style={{ marginBottom: 16 }}>
              {/* Summary banner */}
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 18px", marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ display: "flex", gap: 24 }}>
                    <div>
                      <div style={{ fontSize: 10, color: T.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 2 }}>Scanned</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: T.text }}>{signals.length}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: T.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 2 }}>Qualified</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: T.green }}>{qualifiedList.length}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: T.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 2 }}>Selected</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: T.blue }}>{approved1.size}</div>
                    </div>
                    {pipelineValue > 0 && (
                      <div>
                        <div style={{ fontSize: 10, color: T.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 2 }}>Est. pipeline</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: T.orange }}>${Math.round(pipelineValue / 1000)}K</div>
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button onClick={() => {
                      const all = qualifiedList.map(c => c.name);
                      setApproved1(approved1.size === all.length ? new Set() : new Set(all));
                    }} className="btn-ghost" style={{ fontSize: 11, padding: "6px 12px" }}>
                      {approved1.size === qualifiedList.length ? "Deselect all" : "Select all"}
                    </button>
                    <button onClick={runEnrich} disabled={approved1.size === 0} className="btn-primary">
                      Find decision makers ({approved1.size}) &#8594;
                    </button>
                  </div>
                </div>
              </div>

              {/* Company cards */}
              <div style={{ display: "grid", gap: 10 }}>
                {qualifiedList.map((c, i) => {
                  const on = approved1.has(c.name);
                  const sig = signals.find(s => s.company === c.name);
                  const days = sig?.days_ago;
                  const freshColor = days == null ? T.textDim : days <= 3 ? T.green : days <= 7 ? T.orange : T.red;
                  const freshLabel = days != null ? (days <= 1 ? "Today" : `${days}d ago`) : sig?.posted_date || "Recent";
                  const scoreColor = c.total_score >= 8 ? T.green : c.total_score >= 6.5 ? T.blue : T.orange;

                  return (
                    <div key={i} className={`company-card ${on ? "selected" : ""}`}
                      onClick={() => { const n = new Set(approved1); on ? n.delete(c.name) : n.add(c.name); setApproved1(n); }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                        {/* Left: checkbox + info */}
                        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flex: 1, minWidth: 0 }}>
                          <div style={{
                            width: 20, height: 20, borderRadius: 6, flexShrink: 0, marginTop: 1,
                            border: `2px solid ${on ? T.blue : T.borderLight}`,
                            background: on ? T.blue : "transparent",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            transition: "all .15s"
                          }}>
                            {on && <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
                              <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{c.name}</span>
                              <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                                <span style={{ fontSize: 18, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>{c.total_score}</span>
                                <span style={{ fontSize: 10, color: T.textDim }}>/10</span>
                              </div>
                              <span style={{ fontSize: 10, fontWeight: 600, background: T.blueDim, color: T.blue, padding: "2px 8px", borderRadius: 4 }}>{c.estimated_contract_value}</span>
                            </div>
                            <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 6 }}>
                              {c.employees} employees &middot; {c.industry || "Financial services"} &middot; {c.reasoning}
                            </div>
                            {sig && (
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ fontSize: 11, fontWeight: 700, color: freshColor }}>{freshLabel}</span>
                                <span style={{ fontSize: 11, color: T.textDim }}>via {sig.source || "job board"}</span>
                                {sig.job_url && (
                                  <a href={sig.job_url} target="_blank" rel="noopener"
                                    onClick={e => e.stopPropagation()}
                                    style={{ fontSize: 11, color: T.blue, textDecoration: "none", display: "flex", alignItems: "center", gap: 3 }}>
                                    View posting
                                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6m0 0v6m0-6L10 14" stroke={T.blue} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                  </a>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        {/* Right: mini score badge */}
                        <div style={{ flexShrink: 0, textAlign: "right" }}>
                          <div style={{ fontSize: 10, color: on ? T.blue : T.textDim, fontWeight: 600, textTransform: "uppercase" }}>
                            {on ? "Selected" : "Click to select"}
                          </div>
                        </div>
                      </div>

                      {/* ICP Scorecard */}
                      {c.scores && (
                        <div style={{ marginTop: 12, marginLeft: 32, background: T.bg, borderRadius: 8, padding: "10px 14px" }}
                          onClick={e => e.stopPropagation()}>
                          <div style={{ fontSize: 9, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>ICP Scorecard</div>
                          <div style={{ display: "grid", gap: 5 }}>
                            {[
                              ["Phone intensity", "phone_intensity", 25],
                              ["Industry fit", "industry", 20],
                              ["AI readiness", "ai_readiness", 20],
                              ["Company size", "size", 15],
                              ["Budget signal", "budget", 10],
                              ["Timing urgency", "timing", 10],
                            ].map(([label, key, weight]) => {
                              const val = c.scores[key] || 0;
                              const pct = (val / 2) * 100;
                              const proof = c.evidence?.[key] || "";
                              const barColor = val === 2 ? T.green : val === 1 ? T.orange : T.redDim;
                              return (
                                <div key={key}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                                    <div style={{ width: 100, fontSize: 10, fontWeight: 500, color: T.textSecondary, flexShrink: 0 }}>
                                      {label} <span style={{ color: T.textDim }}>({weight}%)</span>
                                    </div>
                                    <div style={{ flex: 1, height: 4, background: T.border, borderRadius: 2, overflow: "hidden" }}>
                                      <div style={{ width: `${pct}%`, height: "100%", borderRadius: 2, background: barColor, transition: "width .4s" }} />
                                    </div>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: val === 2 ? T.green : val === 1 ? T.orange : T.red, width: 12, textAlign: "right" }}>{val}</span>
                                  </div>
                                  {proof && <div style={{ fontSize: 9, color: T.textDim, marginLeft: 108, lineHeight: 1.4 }}>{proof}</div>}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Rejected companies */}
              {qualified.filter(c => !c.qualified).length > 0 && (
                <div style={{ marginTop: 10, padding: "10px 14px", background: T.bg, borderRadius: 8, border: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: T.textDim, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Auto-rejected</div>
                  <div style={{ fontSize: 11, color: T.textDim, lineHeight: 1.7 }}>
                    {qualified.filter(c => !c.qualified).map(c => (
                      <span key={c.name} style={{ marginRight: 12 }}>
                        {c.name} <span style={{ color: T.red }}>({c.reject_reason || `${c.total_score}/10`})</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Bottom CTA */}
              <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
                <button onClick={runEnrich} disabled={approved1.size === 0} className="btn-primary">
                  Find decision makers for {approved1.size} {approved1.size === 1 ? "company" : "companies"} &#8594;
                </button>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════
              GATE 2: CONTACT VERIFICATION
          ══════════════════════════════════════════ */}
          {phase === "gate2" && (
            <div className="fu" style={{ marginBottom: 16 }}>
              {/* Warning banner */}
              <div style={{ background: T.orangeDim, border: `1px solid ${T.orange}44`, borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "flex-start", gap: 10 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
                  <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke={T.orange} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: T.orange, marginBottom: 2 }}>Verify before proceeding</div>
                  <div style={{ fontSize: 11, color: "#fcd34d", lineHeight: 1.5 }}>
                    AI-found contacts may be outdated. Click LinkedIn links to confirm job titles are current. Remove anyone whose role has changed before generating outreach.
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>
                    {enriched.length} contacts found
                  </span>
                  <span style={{ fontSize: 11, color: T.textDim }}>&middot; {approved2.size} selected</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => {
                    const all = enriched.map(e => e.company.name);
                    setApproved2(approved2.size === all.length ? new Set() : new Set(all));
                  }} className="btn-ghost" style={{ fontSize: 11, padding: "6px 12px" }}>
                    {approved2.size === enriched.length ? "Deselect all" : "Select all"}
                  </button>
                  <button onClick={runOutreach} disabled={approved2.size === 0} className="btn-primary">
                    Generate outreach ({approved2.size}) &#8594;
                  </button>
                </div>
              </div>

              <div style={{ display: "grid", gap: 10 }}>
                {enriched.map((e, i) => {
                  const on = approved2.has(e.company.name);
                  const confColor = e.dm.confidence === "high" ? T.green : e.dm.confidence === "medium" ? T.orange : T.red;
                  const confBg = e.dm.confidence === "high" ? T.greenDim : e.dm.confidence === "medium" ? T.orangeDim : T.redDim;
                  const initials = e.dm.name !== "N/A" ? e.dm.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() : "?";

                  return (
                    <div key={i} className={`company-card ${on ? "selected" : ""}`}
                      onClick={() => { const n = new Set(approved2); on ? n.delete(e.company.name) : n.add(e.company.name); setApproved2(n); }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                        {/* Checkbox + company info */}
                        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                          <div style={{
                            width: 20, height: 20, borderRadius: 6, flexShrink: 0, marginTop: 2,
                            border: `2px solid ${on ? T.blue : T.borderLight}`,
                            background: on ? T.blue : "transparent",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            transition: "all .15s"
                          }}>
                            {on && <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                          </div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{e.company.name}</div>
                            <div style={{ fontSize: 11, color: T.textMuted }}>{e.company.employees} employees &middot; {e.company.industry || "Financial services"}</div>
                            <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>{e.company.reasoning}</div>
                          </div>
                        </div>

                        {/* Contact card */}
                        <div style={{ flexShrink: 0, display: "flex", gap: 12, alignItems: "flex-start" }} onClick={ev => ev.stopPropagation()}>
                          {/* Avatar */}
                          <div style={{
                            width: 38, height: 38, borderRadius: "50%", background: T.purpleDim,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 13, fontWeight: 700, color: T.purple, flexShrink: 0
                          }}>{initials}</div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 1 }}>{e.dm.name}</div>
                            <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>{e.dm.title}</div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: confColor, background: confBg, padding: "2px 8px", borderRadius: 4 }}>
                                {e.dm.confidence} confidence
                              </span>
                              {e.dm.linkedin_url && e.dm.linkedin_url.startsWith("http") && (
                                <a href={e.dm.linkedin_url} target="_blank" rel="noopener"
                                  style={{ fontSize: 11, color: T.linkedIn, fontWeight: 600, textDecoration: "none", display: "flex", alignItems: "center", gap: 3, background: "#0077b522", padding: "2px 8px", borderRadius: 4 }}>
                                  LinkedIn
                                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6m0 0v6m0-6L10 14" stroke={T.linkedIn} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Background + email */}
                      {(e.dm.background || e.dm.email_guess || e.dm.why) && (
                        <div style={{ marginTop: 12, marginLeft: 30, display: "flex", flexDirection: "column", gap: 6 }} onClick={ev => ev.stopPropagation()}>
                          {e.dm.why && <div style={{ fontSize: 11, color: T.textMuted, fontStyle: "italic" }}>{e.dm.why}</div>}
                          {e.dm.background && (
                            <div style={{ fontSize: 11, color: T.textSecondary, background: T.bg, borderLeft: `3px solid ${T.purple}`, borderRadius: "0 6px 6px 0", padding: "8px 12px", lineHeight: 1.6 }}>
                              {e.dm.background}
                            </div>
                          )}
                          {e.dm.email_guess && e.dm.email_guess.includes("@") && (
                            <div style={{ fontSize: 11, color: T.textDim, display: "flex", alignItems: "center", gap: 6 }}>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke={T.textDim} strokeWidth="2"/><polyline points="22,6 12,13 2,6" stroke={T.textDim} strokeWidth="2"/></svg>
                              <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{e.dm.email_guess}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
                <button onClick={runOutreach} disabled={approved2.size === 0} className="btn-primary">
                  Generate outreach for {approved2.size} {approved2.size === 1 ? "contact" : "contacts"} &#8594;
                </button>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════
              RESULTS
          ══════════════════════════════════════════ */}
          <div style={{ display: "grid", gap: 10 }}>
            {final.map((item, i) => {
              const isExp = expanded === i;
              const tab = tabs[i] || "email";
              const hss = hsStatus[item.company.name];
              const confColor = item.dm.confidence === "high" ? T.green : item.dm.confidence === "medium" ? T.orange : T.red;

              return (
                <div key={i} className="card fu" style={{ overflow: "hidden" }}>
                  {/* Accordion header */}
                  <div onClick={() => setExpanded(isExp ? null : i)}
                    style={{ padding: "14px 18px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 14, flex: 1, minWidth: 0 }}>
                      {/* Company + DM */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 3 }}>
                          <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{item.company.name}</span>
                          {item.roi?.savings > 0 && (
                            <span style={{ fontSize: 14, fontWeight: 800, color: T.green }}>
                              ${Math.round(item.roi.savings / 1000)}K<span style={{ fontSize: 10, fontWeight: 400, color: T.textDim }}>/yr saved</span>
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: T.textMuted, display: "flex", alignItems: "center", gap: 6 }}>
                          <span>{item.dm.name}</span>
                          <span style={{ color: T.textDim }}>&middot;</span>
                          <span>{item.dm.title}</span>
                          {item.dm.confidence && (
                            <span style={{ fontSize: 10, fontWeight: 600, color: confColor }}>({item.dm.confidence})</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                      {hs && (
                        <button onClick={() => pushHS(item)} disabled={hss === "pushing" || hss === "done"}
                          style={{
                            padding: "6px 14px", borderRadius: 7, fontSize: 11, fontWeight: 600, border: "none",
                            background: hss === "done" ? T.greenDim : hss === "error" ? T.redDim : hss === "pushing" ? T.surface : T.orangeDim,
                            color: hss === "done" ? T.green : hss === "error" ? T.red : hss === "pushing" ? T.textDim : T.orange,
                            cursor: hss === "done" ? "default" : "pointer", transition: "all .15s",
                            display: "flex", alignItems: "center", gap: 5
                          }}>
                          {hss === "pushing" ? (
                            <><span style={{ width: 8, height: 8, border: `2px solid ${T.textDim}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin .7s linear infinite", display: "inline-block" }} />Pushing</>
                          ) : hss === "done" ? "&#10003; In HubSpot" : hss === "error" ? "Retry" : "Push to HubSpot"}
                        </button>
                      )}
                      <div onClick={() => setExpanded(isExp ? null : i)} style={{ cursor: "pointer", color: T.textDim, transform: isExp ? "rotate(90deg)" : "none", transition: "transform .2s", fontSize: 14 }}>&#9656;</div>
                    </div>
                  </div>

                  {/* Expanded content */}
                  {isExp && (
                    <div style={{ borderTop: `1px solid ${T.border}` }}>
                      {/* Tabs */}
                      <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, paddingLeft: 8 }}>
                        {[["email", "Cold Email"], ["linkedin", "LinkedIn"], ["post", "Post"], ["roi", "ROI"]].map(([id, l]) => (
                          <button key={id} className="tab-btn" onClick={() => setTabs(p => ({ ...p, [i]: id }))} style={{
                            color: tab === id ? T.blue : T.textMuted,
                            borderBottomColor: tab === id ? T.blue : "transparent",
                          }}>{l}</button>
                        ))}
                      </div>

                      <div style={{ padding: "18px 20px" }}>
                        {/* EMAIL TAB */}
                        {tab === "email" && item.outreach?.email && (
                          <div>
                            {/* Email card */}
                            <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
                              {/* Email header */}
                              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}` }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                                  <div style={{ flex: 1 }}>
                                    {item.dm.email_guess && item.dm.email_guess.includes("@") && (
                                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                                        <span style={{ fontSize: 10, fontWeight: 600, color: T.textDim, textTransform: "uppercase", letterSpacing: ".05em", width: 36 }}>To</span>
                                        <span style={{ fontSize: 12, color: T.textSecondary, fontFamily: "'JetBrains Mono',monospace" }}>{item.dm.email_guess}</span>
                                      </div>
                                    )}
                                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                      <span style={{ fontSize: 10, fontWeight: 600, color: T.textDim, textTransform: "uppercase", letterSpacing: ".05em", width: 36 }}>Re</span>
                                      <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{item.outreach.email.subject}</span>
                                    </div>
                                  </div>
                                  <div style={{ display: "flex", gap: 8, flexShrink: 0, marginLeft: 12 }}>
                                    <CopyBtn text={`Subject: ${item.outreach.email.subject}\n\n${item.outreach.email.body}`} label="Copy email" />
                                    {item.dm.email_guess && item.dm.email_guess.includes("@") && (
                                      <a href={`mailto:${item.dm.email_guess}?subject=${encodeURIComponent(item.outreach.email.subject || "")}&body=${encodeURIComponent(item.outreach.email.body || "")}`}
                                        className="btn-primary" style={{ padding: "6px 14px", fontSize: 11, textDecoration: "none", display: "flex", alignItems: "center", gap: 5 }}>
                                        Send
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6m0 0v6m0-6L10 14" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                      </a>
                                    )}
                                  </div>
                                </div>
                              </div>
                              {/* Email body */}
                              <div style={{ padding: "16px 20px" }}>
                                {(item.outreach.email.body || "").split("\n").map((line, li) => (
                                  <p key={li} style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.75, marginBottom: line ? 0 : 8, minHeight: line ? "auto" : 8 }}>{line || "\u00A0"}</p>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* LINKEDIN TAB */}
                        {tab === "linkedin" && item.outreach?.linkedin && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                            {/* Profile link */}
                            {item.dm.linkedin_url && item.dm.linkedin_url.startsWith("http") && (
                              <a href={item.dm.linkedin_url} target="_blank" rel="noopener"
                                style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#0077b5", color: "#fff", padding: "8px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, textDecoration: "none", width: "fit-content" }}>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="#fff"><path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6zM2 9h4v12H2z"/><circle cx="4" cy="4" r="2"/></svg>
                                Open {item.dm.name?.split(" ")[0]}'s LinkedIn
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6m0 0v6m0-6L10 14" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              </a>
                            )}

                            {/* Step 1: Connection note */}
                            <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
                              <div style={{ padding: "10px 16px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <div>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: T.text }}>Step 1 — Connection Request</span>
                                  <span style={{ fontSize: 10, color: T.textDim, marginLeft: 8 }}>Send when connecting</span>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                  <span style={{ fontSize: 10, color: (item.outreach.linkedin.note?.length || 0) > 280 ? T.red : T.textDim, fontFamily: "'JetBrains Mono',monospace" }}>
                                    {item.outreach.linkedin.note?.length || 0}/300
                                  </span>
                                  <CopyBtn text={item.outreach.linkedin.note} />
                                </div>
                              </div>
                              <div style={{ padding: "14px 18px", borderLeft: `3px solid ${T.linkedIn}` }}>
                                {(item.outreach.linkedin.note || "").split("\n").map((line, li) => (
                                  <p key={li} style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.75, marginBottom: line ? 0 : 6, minHeight: line ? "auto" : 6 }}>{line || "\u00A0"}</p>
                                ))}
                              </div>
                            </div>

                            {/* Step 2: Follow-up */}
                            <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
                              <div style={{ padding: "10px 16px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <div>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: T.text }}>Step 2 — Follow-up Message</span>
                                  <span style={{ fontSize: 10, color: T.textDim, marginLeft: 8 }}>Send after they accept</span>
                                </div>
                                <CopyBtn text={item.outreach.linkedin.followup} />
                              </div>
                              <div style={{ padding: "14px 18px", borderLeft: `3px solid ${T.purple}` }}>
                                {(item.outreach.linkedin.followup || "").split("\n").map((line, li) => (
                                  <p key={li} style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.75, marginBottom: line ? 0 : 6, minHeight: line ? "auto" : 6 }}>{line || "\u00A0"}</p>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* POST TAB */}
                        {tab === "post" && item.outreach?.post && (
                          <div>
                            {/* LinkedIn post preview */}
                            <div style={{ background: "#1b1f23", border: `1px solid #30363d`, borderRadius: 12, overflow: "hidden", maxWidth: 560, marginBottom: 10 }}>
                              {/* Post header */}
                              <div style={{ padding: "14px 16px 10px", display: "flex", gap: 10, alignItems: "flex-start" }}>
                                <div style={{ width: 40, height: 40, borderRadius: "50%", background: T.blueDim, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: T.blue, flexShrink: 0 }}>K</div>
                                <div>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: "#e6edf3" }}>Krish Desai</div>
                                  <div style={{ fontSize: 11, color: "#7d8590" }}>Founder at Feather &middot; Just now</div>
                                </div>
                              </div>
                              {/* Post body */}
                              <div style={{ padding: "0 16px 14px" }}>
                                {(item.outreach.post || "").split("\n").map((line, li) => (
                                  <p key={li} style={{ fontSize: 13, color: "#e6edf3", lineHeight: 1.75, marginBottom: line ? 0 : 8, minHeight: line ? "auto" : 8 }}>{line || "\u00A0"}</p>
                                ))}
                              </div>
                              {/* Engagement bar */}
                              <div style={{ borderTop: "1px solid #30363d", padding: "8px 16px", display: "flex", gap: 20 }}>
                                {["👍 Like", "💬 Comment", "🔁 Repost"].map(a => (
                                  <span key={a} style={{ fontSize: 11, color: "#7d8590" }}>{a}</span>
                                ))}
                              </div>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 10, color: T.textDim }}>{item.outreach.post?.length || 0} chars</span>
                              <CopyBtn text={item.outreach.post} label="Copy post" />
                            </div>
                          </div>
                        )}

                        {/* ROI TAB */}
                        {tab === "roi" && (
                          <div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto 1fr", gap: 8, alignItems: "center", marginBottom: 16 }}>
                              <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", borderTop: `3px solid ${T.red}` }}>
                                <div style={{ fontSize: 10, fontWeight: 600, color: T.textDim, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>Current cost</div>
                                <div style={{ fontSize: 24, fontWeight: 800, color: T.red }}>${Math.round((item.roi?.hiring_annual || 0) / 1000)}K</div>
                                <div style={{ fontSize: 10, color: T.textDim, marginTop: 3 }}>per year</div>
                              </div>
                              <div style={{ textAlign: "center", color: T.textDim, fontSize: 18 }}>&#8594;</div>
                              <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", borderTop: `3px solid ${T.blue}` }}>
                                <div style={{ fontSize: 10, fontWeight: 600, color: T.textDim, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>With Feather</div>
                                <div style={{ fontSize: 24, fontWeight: 800, color: T.blue }}>${Math.round((item.roi?.feather_annual || 0) / 1000)}K</div>
                                <div style={{ fontSize: 10, color: T.textDim, marginTop: 3 }}>per year</div>
                              </div>
                              <div style={{ textAlign: "center", color: T.green, fontSize: 18 }}>&#8594;</div>
                              <div style={{ background: T.greenDim, border: `1px solid #166534`, borderRadius: 10, padding: "14px 16px", borderTop: `3px solid ${T.green}` }}>
                                <div style={{ fontSize: 10, fontWeight: 600, color: T.green, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>Annual savings</div>
                                <div style={{ fontSize: 24, fontWeight: 800, color: T.green }}>${Math.round((item.roi?.savings || 0) / 1000)}K</div>
                                <div style={{ fontSize: 10, color: T.green, marginTop: 3, opacity: .8 }}>{item.roi?.pct || 0}% reduction</div>
                              </div>
                            </div>
                            <div style={{ fontSize: 11, color: T.textDim, lineHeight: 1.6, background: T.bg, borderRadius: 8, padding: "10px 14px", border: `1px solid ${T.border}` }}>
                              Based on {item.signal?.num_openings || 8} agents &times; $45K salary &times; 1.3 benefits + $4K training vs. Feather at $0.07/min for 50 calls/day/agent, 5min avg, 250 days/yr.
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── DONE STATE ── */}
          {phase === "done" && final.length > 0 && (
            <div className="fu" style={{ marginTop: 14 }}>
              <div style={{ background: T.greenDim, border: `1px solid #166534`, borderRadius: 12, padding: "16px 20px", marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.green, marginBottom: 2 }}>Pipeline complete</div>
                    <div style={{ fontSize: 11, color: T.green, opacity: .7 }}>{Math.floor(elapsed / 60)}m {elapsed % 60}s total &middot; ~${costEst} API cost</div>
                  </div>
                  {hs && (
                    <div style={{ fontSize: 11, color: T.green }}>
                      {Object.values(hsStatus).filter(s => s === "done").length} companies pushed to HubSpot
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: T.green, opacity: .7, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Scanned</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: T.text }}>{signals.length}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: T.green, opacity: .7, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Qualified</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: T.text }}>{qualifiedList.length}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: T.green, opacity: .7, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Outreach ready</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: T.text }}>{final.length}</div>
                  </div>
                  {final.reduce((s, e) => s + (e.roi?.savings || 0), 0) > 0 && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 600, color: T.green, opacity: .7, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Total addressable savings</div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: T.green }}>${Math.round(final.reduce((s, e) => s + (e.roi?.savings || 0), 0) / 1000)}K/yr</div>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button onClick={() => {
                  const esc = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
                  const rows = [["Company", "Industry", "Employees", "ICP Score", "DM Name", "DM Title", "DM Email", "DM LinkedIn", "Savings", "Savings %", "Email Subject", "Email Body", "LinkedIn Note", "LinkedIn Followup", "Post"].join(",")];
                  final.forEach(f => rows.push([
                    esc(f.company.name), esc(f.company.industry || f.signal?.industry || ""), esc(f.company.employees),
                    f.company.total_score || "", esc(f.dm.name), esc(f.dm.title), esc(f.dm.email_guess || ""), esc(f.dm.linkedin_url || ""),
                    f.roi?.savings || "", f.roi?.pct || "", esc(f.outreach?.email?.subject || ""), esc(f.outreach?.email?.body || ""),
                    esc(f.outreach?.linkedin?.note || ""), esc(f.outreach?.linkedin?.followup || ""), esc(f.outreach?.post || "")
                  ].join(",")));
                  const blob = new Blob(["\uFEFF" + rows.join("\n")], { type: "text/csv" });
                  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
                  a.download = `feather-pipeline-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
                }} className="btn-ghost" style={{ flex: 1, padding: "10px 0" }}>
                  Export CSV
                </button>
                <button onClick={() => {
                  const text = final.map(f =>
                    `## ${f.company.name}\nDM: ${f.dm.name} (${f.dm.title})\nEmail: ${f.dm.email_guess || "N/A"}\nLinkedIn: ${f.dm.linkedin_url || "N/A"}\nSavings: $${Math.round((f.roi?.savings || 0) / 1000)}K/yr\n\n### Cold Email\nSubject: ${f.outreach?.email?.subject || ""}\n\n${f.outreach?.email?.body || ""}\n\n### LinkedIn Note\n${f.outreach?.linkedin?.note || ""}\n\n### Follow-up\n${f.outreach?.linkedin?.followup || ""}\n\n### LinkedIn Post\n${f.outreach?.post || ""}\n\n---`
                  ).join("\n\n");
                  navigator.clipboard.writeText(text);
                }} className="btn-ghost" style={{ flex: 1, padding: "10px 0" }}>
                  Copy all outreach
                </button>
              </div>
              <button onClick={() => { resetPipeline(); setPhase("idle"); }} className="btn-ghost" style={{ width: "100%", padding: "10px 0" }}>
                Run new pipeline
              </button>
            </div>
          )}
        </div>

        {/* ── ACTIVITY LOG ── */}
        {stageIdx >= 0 && (
          <div style={{ width: 290, flexShrink: 0 }} className="fu">
            <div style={{ position: "sticky", top: 72 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: ".06em" }}>Activity</span>
                <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: T.textDim }}>
                  {logs.length} events{tokenCount.input > 0 && ` · $${costEst}`}
                </span>
              </div>
              <div className="card" style={{ maxHeight: "calc(100vh - 140px)", overflowY: "auto" }}>
                {logs.map((l, i) => (
                  <div key={i} className="si" style={{
                    padding: "6px 12px", borderBottom: `1px solid ${T.bg}`,
                    background: l.type === "success" ? `${T.green}11` :
                      l.type === "error" ? `${T.red}11` :
                      l.type === "gate" ? `${T.orange}11` :
                      l.type === "warn" ? `${T.orange}0a` : "transparent",
                    opacity: l.type === "dim" ? 0.45 : 1,
                  }}>
                    <div style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'JetBrains Mono',monospace", flexShrink: 0, marginTop: 2, lineHeight: 1.4 }}>{l.time}</span>
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", marginRight: 5,
                          color: l.type === "success" ? T.green : l.type === "error" ? T.red : l.type === "gate" ? T.orange : l.type === "warn" ? T.orange : T.textDim
                        }}>{l.src}</span>
                        <span style={{ fontSize: 11, color: l.type === "error" ? "#fca5a5" : l.type === "gate" ? "#fcd34d" : T.textSecondary, lineHeight: 1.5 }}>{l.msg}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {isRunning && (
                  <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 8, height: 8, border: `2px solid ${T.blue}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin .7s linear infinite" }} />
                    <span style={{ fontSize: 11, color: T.textDim }}>
                      {phase === "scanning" ? "Searching..." : phase === "enriching" ? "Finding contacts..." : "Generating outreach..."}
                    </span>
                  </div>
                )}
                <div ref={logEnd} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════ ARCHITECTURE ═══════════════ */
function Arch() {
  return (
    <div style={{ maxWidth: 660, margin: "0 auto", padding: "48px 24px" }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: T.text, marginBottom: 6 }}>How Feather works</h1>
        <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.7 }}>Three phases. Human approval between each. AI does the research — you make every decision.</p>
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 0, marginBottom: 36, borderRadius: 10, overflow: "hidden", border: `1px solid ${T.border}` }}>
        {[["5-10", "signals per run"], ["~40%", "ICP pass rate"], ["~$0.05", "per lead"], ["10-15 min", "your time"]].map(([v, l], i, arr) => (
          <div key={l} style={{ flex: 1, padding: "14px 16px", background: T.surface, borderRight: i < arr.length - 1 ? `1px solid ${T.border}` : "none" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: T.text, marginBottom: 2 }}>{v}</div>
            <div style={{ fontSize: 11, color: T.textMuted }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Steps */}
      {[
        {
          n: "01", title: "Discover", time: "~60s",
          desc: "Claude web searches job boards (Indeed, LinkedIn, ZipRecruiter) for companies actively hiring phone agents. Returns real postings with company name, location, openings count, and posting date.",
          tools: [["Claude web search", T.blue], ["6-factor ICP model", T.green]],
          gate: "You select which companies to enrich"
        },
        {
          n: "02", title: "Enrich", time: "~20s/company",
          desc: "Finds the right decision maker at each company — VP Ops, COO, Director of Contact Center. Validates email format, checks LinkedIn URL, and flags low-confidence contacts.",
          tools: [["Claude web search", T.blue], ["Email + LinkedIn validation", T.green]],
          gate: "You verify contacts before outreach"
        },
        {
          n: "03", title: "Activate", time: "~15s/company",
          desc: "Builds a real ROI model using actual salary data vs. Feather's $0.07/min pricing. Drafts a cold email, LinkedIn connection note, follow-up message, and thought leadership post — all personalized.",
          tools: [["ROI calculator", T.green], ["Personalized copy", T.purple]],
          gate: null
        },
      ].map((step, idx) => (
        <div key={step.n} style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: T.blueDim, border: `1px solid ${T.blue}44`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: T.blue }}>{step.n}</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>{step.title}</span>
                <span style={{ fontSize: 11, color: T.textDim }}>{step.time}</span>
              </div>
              <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.7, marginBottom: 8 }}>{step.desc}</p>
              <div style={{ display: "flex", gap: 12 }}>
                {step.tools.map(([name, c]) => (
                  <span key={name} style={{ fontSize: 11, color: c, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: c, display: "inline-block" }} />{name}
                  </span>
                ))}
              </div>
            </div>
          </div>
          {step.gate && (
            <div style={{ margin: "16px 0 0 50px", display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, height: 1, background: T.border }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: T.orange, background: T.orangeDim, padding: "3px 12px", borderRadius: 20, border: `1px solid ${T.orange}33`, whiteSpace: "nowrap" }}>
                &#9654; {step.gate}
              </span>
              <div style={{ flex: 1, height: 1, background: T.border }} />
            </div>
          )}
        </div>
      ))}

      {/* ICP model */}
      <div style={{ marginTop: 40 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 12, textTransform: "uppercase", letterSpacing: ".06em" }}>ICP Scoring Model</div>
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
          {[
            ["Phone intensity", "25%", "How many call center roles are open", T.blue],
            ["Industry fit", "20%", "Mortgage, insurance, credit union, lending", T.green],
            ["AI readiness", "20%", "No existing AI voice vendor detected", T.purple],
            ["Company size", "15%", "200-2,000 employees", T.cyan],
            ["Budget signal", "10%", "3+ concurrent hires", T.orange],
            ["Timing urgency", "10%", "Posted within 7 days", T.green],
          ].map(([name, w, desc, c], i, arr) => (
            <div key={name} style={{
              display: "flex", alignItems: "center", padding: "11px 16px",
              borderBottom: i < arr.length - 1 ? `1px solid ${T.border}` : "none",
              background: T.surface
            }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: c, marginRight: 10, flexShrink: 0 }} />
              <span style={{ width: 130, fontSize: 12, fontWeight: 600, color: T.textSecondary }}>{name}</span>
              <span style={{ width: 40, fontSize: 13, fontWeight: 800, color: c }}>{w}</span>
              <span style={{ flex: 1, fontSize: 11, color: T.textDim, marginLeft: 8 }}>{desc}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, padding: "0 4px" }}>
          <span style={{ fontSize: 11, color: T.green, fontWeight: 600 }}>Qualify threshold: 6.0 / 10</span>
          <span style={{ fontSize: 11, color: T.textDim }}>Auto-reject: AI vendor &middot; gov &middot; &gt;5K emp &middot; &lt;50 emp</span>
        </div>
      </div>

      <div style={{ marginTop: 36, padding: "14px 18px", background: T.surface, borderRadius: 10, border: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.7 }}>
          <strong style={{ color: T.text }}>Nothing sends automatically.</strong> Every email, LinkedIn message, and HubSpot push requires your explicit action. This tool finds and prepares — you decide what to send.
        </div>
      </div>
    </div>
  );
}

/* ═══ SHARED COMPONENTS ═══ */
function CopyBtn({ text, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={(e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }} className="btn-ghost" style={{ padding: "5px 12px", fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
      {copied ? (
        <><svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" stroke={T.green} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>Copied</>
      ) : (
        <><svg width="11" height="11" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke={T.textSecondary} strokeWidth="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke={T.textSecondary} strokeWidth="2"/></svg>{label || "Copy"}</>
      )}
    </button>
  );
}
