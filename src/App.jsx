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
  purple: '#8b5cf6', purpleDim: '#2e1065', cyan: '#06b6d4',
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
  const updateKey = (k, v) => {
    const clean = v.replace(/[^\x20-\x7E]/g, "").trim();
    setKeys(p => ({ ...p, [k]: clean }));
    if (k === "a") { _apiKey = clean; setConnected(p => ({ ...p, a: !!clean })); }
    if (k === "h") { _hubspotToken = clean; setConnected(p => ({ ...p, h: !!clean })); }
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Inter',-apple-system,BlinkMacSystemFont,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}button{cursor:pointer;font-family:inherit}input:focus{outline:none}
        pre{white-space:pre-wrap;word-break:break-word;margin:0;font-family:'JetBrains Mono',monospace;font-size:12.5px;line-height:1.7;color:${T.textSecondary}}
        ::selection{background:${T.blueDim};color:${T.text}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
        .fu{animation:fadeUp .3s ease-out both}.si{animation:slideIn .2s ease-out both}
        .card{background:${T.surface};border:1px solid ${T.border};border-radius:10px;transition:border-color .15s}
        .card:hover{border-color:${T.borderLight}}
        input[type=password],input[type=text]{background:${T.surface};border:1px solid ${T.border};border-radius:8px;padding:8px 12px;font-size:13px;color:${T.text};font-family:'JetBrains Mono',monospace;transition:border-color .15s}
        input[type=password]:focus,input[type=text]:focus{border-color:${T.blue}}
        .btn-primary{background:${T.blue};color:#fff;border:none;border-radius:8px;padding:8px 20px;font-size:13px;font-weight:600;transition:opacity .15s}
        .btn-primary:hover{opacity:.9}.btn-primary:disabled{opacity:.3;cursor:not-allowed}
        .btn-ghost{background:transparent;border:1px solid ${T.border};color:${T.textSecondary};border-radius:8px;padding:7px 16px;font-size:12px;font-weight:500;transition:all .15s}
        .btn-ghost:hover{border-color:${T.borderLight};color:${T.text}}
      `}</style>

      {/* NAV */}
      <nav style={{ background: T.bg, borderBottom: `1px solid ${T.border}`, padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 52 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5L12 3Z" fill={T.blue} /><path d="M8 16c2-5 5-8 9-10-2 3-3 5.5-3.5 8.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.03em", color: T.text }}>Feather</span>
          </div>
          <div style={{ height: 16, width: 1, background: T.border }} />
          {[["pipeline", "Pipeline"], ["architecture", "Architecture"]].map(([id, l]) => (
            <button key={id} onClick={() => setPage(id)} style={{
              padding: "6px 14px", borderRadius: 6, fontSize: 13, fontWeight: 500, border: "none",
              background: page === id ? T.blueDim : "transparent", color: page === id ? T.blue : T.textMuted
            }}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {connected.a && <span style={{ fontSize: 11, color: T.green, display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.green, display: "inline-block" }} />API connected
          </span>}
          {connected.h && <span style={{ fontSize: 11, color: T.orange, display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.orange, display: "inline-block" }} />HubSpot
          </span>}
        </div>
      </nav>

      {/* API KEY BAR — always visible until connected */}
      {(!connected.a || !connected.h) && (
        <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "14px 28px", display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }} className="fu">
          <div style={{ flex: "1 1 280px" }}>
            <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Anthropic API key {connected.a && <span style={{ color: T.green }}>&#10003;</span>}</div>
            <input type="password" placeholder="sk-ant-api03-..." value={keys.a} onChange={e => updateKey("a", e.target.value)} style={{ width: "100%", borderColor: connected.a ? T.green : T.border }} />
          </div>
          <div style={{ flex: "1 1 280px" }}>
            <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>HubSpot token (optional) {connected.h && <span style={{ color: T.green }}>&#10003;</span>}</div>
            <input type="password" placeholder="pat-na1-..." value={keys.h} onChange={e => updateKey("h", e.target.value)} style={{ width: "100%", borderColor: connected.h ? T.green : T.border }} />
          </div>
          {!connected.a && <div style={{ fontSize: 11, color: T.textDim, maxWidth: 300, lineHeight: 1.5, paddingBottom: 4 }}>
            Your key stays in memory only — never stored or logged.
          </div>}
        </div>
      )}

      {page === "pipeline" ? <Pipeline hs={connected.h} /> : <Arch />}
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
    log("STOP", "System", "Pipeline cancelled by user", "warn");
    setPhase("idle");
    setRunGuard(false);
  }, [log]);

  /* ── HUBSPOT PUSH (with dedup) ── */
  const pushHS = async (item) => {
    if (!_hubspotToken) return;
    const id = item.company.name;
    setHsStatus(p => ({ ...p, [id]: "pushing" }));
    try {
      const empCount = parseNum(item.company.employees);
      // Search for existing company first (avoid duplicates)
      let coId = null;
      try {
        const searchRes = await hubspot("POST", "crm/v3/objects/companies/search", {
          filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: item.company.name }] }], limit: 1
        });
        if (searchRes?.results?.length > 0) {
          coId = searchRes.results[0].id;
          log("HS", "HubSpot", `Found existing company: ${item.company.name}`, "info");
        }
      } catch (searchErr) { /* search failed, will create new */ }

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

      // Contact — associationTypeId:1 = Contact -> Company
      if (item.dm?.name && item.dm.name !== "N/A" && item.dm.email_guess && item.dm.email_guess.includes("@")) {
        const names = item.dm.name.trim().split(/\s+/);
        await hubspot("POST", "crm/v3/objects/contacts", {
          properties: {
            firstname: names[0] || "", lastname: names.slice(1).join(" ") || "",
            jobtitle: item.dm.title || "", company: item.company.name,
            email: item.dm.email_guess,
            hs_content_membership_notes: truncate(item.dm.background || "", 500),
          },
          associations: coId ? [{ to: { id: coId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId:1 }] }] : []
        });
      }

      // Deal — associationTypeId:5 = Deal -> Company
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
        associations: coId ? [{ to: { id: coId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId:5 }] }] : []
      });

      setHsStatus(p => ({ ...p, [id]: "done" }));
      log("HS", "HubSpot", `Pushed ${item.company.name}: company + contact + deal`, "success");
    } catch(err) {
      const reason = err.message.includes("409") ? "Duplicate record" :
        err.message.includes("401") ? "Invalid HubSpot token" :
        err.message.includes("429") ? "HubSpot rate limit — retry in 60s" : err.message;
      setHsStatus(p => ({ ...p, [id]: "error" }));
      log("ERR", "HubSpot", `Failed: ${item.company.name} — ${reason}`, "error");
    }
  };

  /* ══════════════════════════════════════════
     PHASE 1: SCAN + ICP QUALIFY

     ICP scoring model — 6 weighted factors:
     1. PHONE OPERATION INTENSITY — weight 25% — Evidence needed for score
     2. INDUSTRY ALIGNMENT — weight 20% — Do NOT guess, use data
     3. AI VOICE READINESS — weight 20% — Evidence needed for each score
     4. COMPANY SIZE fit — weight 15%
     5. BUDGET SIGNAL — weight 10%
     6. TIMING URGENCY — weight 10%
     Formula: (p*25 + i*20 + a*20 + s*15 + b*10 + t*10) / 20 = score out of 10
     Threshold: >= 6.0 to qualify. Kill: AI voice vendor, gov, >5K, <50 emp.
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

      // ── STEP 1: Web search → prose (Sonnet, max_uses: 3) ──
      const proseResult = await callClaude(
        `Hiring research agent. Today: ${today}. Search for mid-market companies (100-5K employees) in mortgage, lending, insurance, credit unions actively hiring call center/phone agents. For each: company name, industry, employee count, HQ location, job titles, openings count, job board source, posting date, URL. Prioritize last 14 days. NOT mega-corps (Wells Fargo, JPMorgan, Capital One, GEICO, BofA, Rocket Mortgage).`,
        `Search for: ${input}. Find 5-8 real companies with active job postings. Write a prose report — no JSON.`,
        true, 3
      );

      if (abortRef.current?.signal.aborted) throw new Error("Cancelled");

      // ── 20-second pause between Step 1 and Step 2 ──
      log("WAIT", "System", "Cooling down 20s before parsing...");
      await countdownWait(20, log, "Cooldown —");

      if (abortRef.current?.signal.aborted) throw new Error("Cancelled");

      // ── STEP 2: Parse prose → JSON (Haiku, no search) ──
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
      const list = fresh.map(s => s);
      const useSignals = list.length > 0 ? list : d1.signals;
      if (!useSignals.length) throw new Error("No signals found — try a different query.");
      setSignals(useSignals);

      if (list.length === 0 && d1.signals.length > 0) log("WARN", "System", "No freshness data — showing all results");

      useSignals.forEach(s => {
        log("SIG", "Signal", `${s.company} — ${s.num_openings || "?"}x ${s.role_title || "phone agent"} (${s.location || "US"}) via ${s.source || "web"}`);
      });

      log("ICP", "System", "Scoring companies against ICP model...");

      // ── LOCAL ICP SCORING — realistic, not inflated ──
      const aiVendorRegex = /vapi|retell|bland|synthflow|poly\.ai|replicant|parloa|five9.*ai|cognigy/i;
      const govRegex = /government|federal|state agency|municipal|county\s+of|city\s+of|dept\s+of/i;

      const companies = useSignals.map(s => {
        const r = (s.role_title || "") + " " + (s.company || "");
        const ind = s.industry || "";
        const fullText = r + " " + ind;
        const openings = s.num_openings || 3;
        const days = s.days_ago || 7;
        const empNum = parseNum(s.employee_count || s.employees);

        // 1. INDUSTRY ALIGNMENT (weight 20%)
        const coreInd = /mortgage|lending|loan|insurance|credit union|underwriting/i.test(fullText);
        const adjInd = /bank|fintech|financial|collection|servic/i.test(fullText);
        const industryScore = coreInd ? 2 : adjInd ? 1 : 0;

        // 2. COMPANY SIZE (weight 15%) — variable, not always 2
        const sizeScore = empNum >= 200 && empNum <= 2000 ? 2 : (empNum >= 100 && empNum <= 5000) ? 1 : empNum === 0 ? 1 : 0;

        // 3. PHONE OPERATION intensity (weight 25%)
        const phoneRole = /call center|phone|customer service|collections|loan servicing|inbound|outbound|representative|agent/i.test(r);
        const phoneScore = phoneRole ? (openings >= 5 ? 2 : 1) : 0;

        // 4. AI VOICE READINESS (weight 20%) — check for existing vendors
        const hasAiVoice = aiVendorRegex.test(fullText);
        const aiScore = hasAiVoice ? 0 : 1; // Default 1 (unknown), not 2

        // 5. BUDGET SIGNAL (weight 10%)
        const budgetScore = openings >= 5 ? 2 : openings >= 3 ? 1 : 0;

        // 6. TIMING URGENCY (weight 10%)
        const timingScore = days <= 7 ? (openings >= 5 ? 2 : 1) : 0;

        const weighted = (phoneScore * 25 + industryScore * 20 + aiScore * 20 + sizeScore * 15 + budgetScore * 10 + timingScore * 10) / 20;
        const score = Math.round(weighted * 10) / 10;

        // Auto-reject checks
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
            size: empNum > 0 ? `${empNum.toLocaleString()} employees` : "Size not confirmed — defaulting to mid-market estimate",
            phone_intensity: `${openings} ${s.role_title || "phone"} openings found`,
            ai_readiness: hasAiVoice ? "AI voice vendor detected — disqualified" : "No AI voice vendor detected (unverified)",
            budget: openings >= 5 ? `${openings} concurrent hires = strong budget signal` : openings >= 3 ? `${openings} hires = moderate budget` : "Few openings",
            timing: days <= 7 ? `Posted ~${days}d ago — urgent` : `Posted ~${days}d ago`
          }
        };
      });

      // Sort by score descending
      companies.sort((a, b) => b.total_score - a.total_score);
      setQualified(companies);

      companies.filter(c => c.qualified).forEach(c => log("PASS", "ICP", `${c.name} — ${c.total_score}/10`, "success"));
      companies.filter(c => !c.qualified).forEach(c => log("SKIP", "ICP", `${c.name} — ${c.total_score}/10${c.reject_reason ? ` (${c.reject_reason})` : " (below 6.0)"}`, "dim"));

      if (!companies.some(c => c.qualified)) throw new Error("No companies qualified — try a different vertical.");
      log("GATE", "System", "Awaiting your review — select companies below", "gate");
      setPhase("gate1"); clearInterval(timerRef.current);
    } catch(e) { setError(e.message); log("ERR", "System", e.message, "error"); clearInterval(timerRef.current); setPhase("idle"); }
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
      let _enrichIdx = 0;
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

          // Validate email format
          if (dm.email_guess && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dm.email_guess)) {
            dm.email_guess = ""; dm.confidence = "low";
            log("WARN", "System", `Email for ${co.name} failed format check — removed`);
          }
          // Validate LinkedIn URL
          if (dm.linkedin_url && !dm.linkedin_url.startsWith("http")) {
            if (dm.linkedin_url.startsWith("linkedin.com") || dm.linkedin_url.startsWith("www.linkedin")) {
              dm.linkedin_url = "https://" + dm.linkedin_url;
            } else { dm.linkedin_url = ""; }
          }
          // Check email domain vs company name
          if (dm.email_guess) {
            const emailDomain = dm.email_guess.split("@")[1]?.toLowerCase() || "";
            const coWords = co.name.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
            const domainMatch = coWords.some(w => w.length > 3 && emailDomain.includes(w));
            if (!domainMatch && dm.confidence === "high") {
              dm.confidence = "medium";
            }
          }

          log("DM", "Result", `${dm.name} — ${dm.title} (${dm.confidence})`, "success");
          results.push({ company: co, signal: sig, dm });
          setEnriched([...results]);
          _enrichIdx++;
          if (_enrichIdx < picked.length) { log("WAIT", "System", "Waiting 10s to avoid rate limits..."); await delay(10000); }
        } catch(err) { log("ERR", "System", `${co.name}: ${err.message} — skipping`, "error"); _enrichIdx++; }
      }
      if (results.length === 0) throw new Error("No contacts found.");
      log("GATE", "System", "Verify contacts below — check LinkedIn profiles before proceeding", "gate");
      setPhase("gate2"); clearInterval(timerRef.current);
    } catch(e) { setError(e.message); log("ERR", "System", e.message, "error"); clearInterval(timerRef.current); setPhase("idle"); }
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
      log("WAIT", "System", "Waiting 15s before outreach generation to reset rate limits...");
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
        } catch(err) { log("ERR", "System", `${item.company.name}: ${err.message} — skipping`, "error"); }
      }
      log("DONE", "System", `Pipeline complete — ${results.length} companies ready`, "success");
      setPhase("done"); clearInterval(timerRef.current);
    } catch(e) { setError(e.message); log("ERR", "System", e.message, "error"); clearInterval(timerRef.current); setPhase("idle"); }
    finally { running.current = false; }
  }, [enriched, approved2, log]);

  const isRunning = ["scanning", "enriching", "outreach"].includes(phase);
  const stageMap = { idle: -1, scanning: 0, gate1: 1, enriching: 2, gate2: 3, outreach: 4, done: 5 };
  const stageIdx = stageMap[phase] ?? -1;
  const STAGES = ["Scan", "Review", "Enrich", "Verify", "Outreach", "Done"];
  const costEst = (((_tokenAccum.input * 3 + _tokenAccum.output * 15) / 1000000) || 0).toFixed(3);

  return (
    <div style={{ maxWidth: 1140, margin: "0 auto", padding: "28px 24px" }}>
      <div style={{ display: "flex", gap: 20 }}>
        {/* MAIN */}
        <div style={{ flex: "1 1 0", minWidth: 0 }}>

          {/* Input */}
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, display: "flex", alignItems: "center", padding: "0 4px 0 14px" }}>
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && !isRunning && runScan(query)} disabled={isRunning}
                placeholder="Describe your target vertical..."
                style={{ flex: 1, background: "transparent", border: "none", color: T.text, fontSize: 14, padding: "11px 0" }} />
              <button onClick={() => runScan(query)} disabled={isRunning || !query.trim()} className="btn-primary">
                {isRunning ? "Running..." : "Run pipeline"}
              </button>
            </div>
            {isRunning && <button onClick={cancelPipeline} style={{
              background: "transparent", color: T.red, border: `1px solid ${T.redDim}`, borderRadius: 8,
              padding: "8px 14px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap"
            }}>Cancel</button>}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20 }}>
            {PRESETS.map(p => (
              <button key={p} onClick={() => { setQuery(p); if (!isRunning) runScan(p); }} disabled={isRunning} className="btn-ghost" style={{ fontSize: 11, padding: "4px 10px" }}>{p}</button>
            ))}
          </div>

          {/* Progress bar */}
          {stageIdx >= 0 && (
            <div className="card fu" style={{ padding: "10px 14px", marginBottom: 14 }}>
              <div style={{ display: "flex", gap: 2, marginBottom: 6 }}>
                {STAGES.map((_, i) => (<div key={i} style={{ flex: 1, height: 2, borderRadius: 1, background: i <= stageIdx ? (phase === "done" ? T.green : T.blue) : T.border, transition: "background .3s" }} />))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {isRunning && <div style={{ width: 10, height: 10, border: `2px solid ${T.blue}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin .8s linear infinite" }} />}
                  {phase === "done" && <span style={{ color: T.green, fontSize: 13 }}>&#10003;</span>}
                  <span style={{ fontSize: 12, fontWeight: 500, color: phase === "done" ? T.green : (phase === "gate1" || phase === "gate2") ? T.orange : T.blue }}>
                    {phase === "gate1" ? "Select companies to enrich" : phase === "gate2" ? "Verify contacts before generating outreach" : phase === "done" ? "Pipeline complete" :
                      phase === "scanning" ? "Searching and scoring..." : phase === "enriching" ? "Finding decision makers..." : phase === "outreach" ? "Generating outreach..." : STAGES[stageIdx]}
                  </span>
                </div>
                <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: T.textDim }}>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>
              </div>
            </div>
          )}

          {/* Empty state */}
          {phase === "idle" && !error && (
            <div style={{ background: T.surface, border: `1px dashed ${T.border}`, borderRadius: 12, padding: "56px 32px", textAlign: "center", marginBottom: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: T.blueDim, margin: "0 auto 16px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5L12 3Z" fill={T.blue} /><path d="M8 16c2-5 5-8 9-10-2 3-3 5.5-3.5 8.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, color: T.text, marginBottom: 6 }}>No pipeline running</div>
              <div style={{ fontSize: 13, color: T.textMuted, maxWidth: 440, margin: "0 auto", lineHeight: 1.6 }}>
                Find companies hiring phone agents, qualify against ICP, identify decision makers, and generate personalized outreach.
              </div>
              <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 20, fontSize: 12, color: T.textDim }}>
                {["Scan job boards", "ICP qualify", "Find DMs", "Generate outreach"].map((s, i) => (
                  <span key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}>{s}{i < 3 && <span style={{ color: T.blue }}>&#8594;</span>}</span>
                ))}
              </div>
            </div>
          )}

          {error && <div className="fu" style={{ background: T.redDim, border: `1px solid #7f1d1d`, borderRadius: 10, padding: "10px 14px", marginBottom: 14 }}><span style={{ color: "#fca5a5", fontSize: 13 }}>{error}</span></div>}

          {/* ═══ GATE 1 ═══ */}
          {phase === "gate1" && (
            <div className="fu" style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h3 style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>Qualified companies</h3>
                  <button onClick={() => { const all = qualified.filter(c => c.qualified).map(c => c.name); setApproved1(approved1.size === all.length ? new Set() : new Set(all)); }}
                    className="btn-ghost" style={{ fontSize: 10, padding: "2px 8px" }}>
                    {approved1.size === qualified.filter(c => c.qualified).length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <button onClick={runEnrich} disabled={approved1.size === 0} className="btn-primary" style={{ fontSize: 12 }}>
                  Find decision makers ({approved1.size}) &#8594;
                </button>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {qualified.filter(c => c.qualified).sort((a, b) => b.total_score - a.total_score).map((c, i) => {
                  const on = approved1.has(c.name);
                  const sig = signals.find(s => s.company === c.name);
                  const days = sig?.days_ago;
                  const freshColor = days==null ? T.textDim : days<=3 ? T.green : days<=7 ? T.orange : T.red;
                  const freshLabel = days!=null ? (days<=1 ? "Today" : days+"d ago") : sig?.posted_date || "Recent";
                  return (
                    <div key={i} onClick={() => { const n = new Set(approved1); on ? n.delete(c.name) : n.add(c.name); setApproved1(n); }}
                      style={{ background: T.surface, border: `2px solid ${on ? T.blue : T.border}`, borderRadius: 10, padding: "14px 16px", cursor: "pointer", transition: "border-color .15s" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <div style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${on ? T.blue : T.borderLight}`, background: on ? T.blue : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              {on && <svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 6l2 2 4-4" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" /></svg>}
                            </div>
                            <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{c.name}</span>
                            <span style={{ fontSize: 13, fontWeight: 700, color: c.total_score >= 8 ? T.green : c.total_score >= 6 ? T.blue : T.orange }}>{c.total_score}</span>
                            <span style={{ fontSize: 10, color: T.textDim }}>/10</span>
                            <Tag color="blue">{c.estimated_contract_value}</Tag>
                          </div>
                          <div style={{ fontSize: 11, color: T.textMuted, marginLeft: 26 }}>{c.employees} emp &middot; {c.industry || "Financial services"} &middot; {c.reasoning}</div>
                          {sig && <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 26, marginTop: 4 }}>
                            <span style={{ fontSize: 10, fontWeight: 600, color: freshColor }}>{freshLabel}</span>
                            <span style={{ fontSize: 10, color: T.textDim }}>{sig.source || "web"}</span>
                            {sig.job_url && <a href={sig.job_url} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} style={{ fontSize: 10, color: T.blue, textDecoration: "none" }}>View posting &#8599;</a>}
                          </div>}
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 600, color: on ? T.blue : T.textDim }}>{on ? "Selected" : "Click to select"}</span>
                      </div>
                      {/* ICP Scorecard */}
                      {c.scores && <div style={{ marginLeft: 26, background: T.bg, borderRadius: 8, padding: "10px 12px" }} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: 9, fontWeight: 600, color: T.textDim, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>ICP scorecard</div>
                        <div style={{ display: "grid", gap: 5 }}>
                          {[["Industry", "industry", 20], ["Size fit", "size", 15], ["Phone intensity", "phone_intensity", 25],
                            ["AI readiness", "ai_readiness", 20], ["Budget signal", "budget", 10], ["Timing", "timing", 10]
                          ].map(([label, key, weight]) => {
                            const val = c.scores[key] || 0;
                            const pct = (val / 2) * 100;
                            const proof = c.evidence?.[key] || "";
                            return (
                              <div key={key}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 1 }}>
                                  <div style={{ width: 85, fontSize: 10, fontWeight: 500, color: T.textSecondary, flexShrink: 0 }}>{label} <span style={{ color: T.textDim }}>({weight}%)</span></div>
                                  <div style={{ flex: 1, height: 4, background: T.border, borderRadius: 2, overflow: "hidden" }}>
                                    <div style={{ width: `${pct}%`, height: "100%", borderRadius: 2, background: val === 2 ? T.green : val === 1 ? T.orange : T.red, transition: "width .3s" }} />
                                  </div>
                                  <span style={{ fontSize: 10, fontWeight: 600, color: val === 2 ? T.green : val === 1 ? T.orange : T.red, width: 14, textAlign: "right" }}>{val}</span>
                                </div>
                                {proof && <div style={{ fontSize: 9, color: T.textDim, marginLeft: 91, lineHeight: 1.3 }}>{proof}</div>}
                              </div>
                            );
                          })}
                        </div>
                      </div>}
                    </div>
                  );
                })}
              </div>
              {qualified.filter(c => !c.qualified).length > 0 && (
                <div style={{ marginTop: 10, fontSize: 11, color: T.textDim }}>
                  Filtered: {qualified.filter(c => !c.qualified).map(c => `${c.name}${c.reject_reason ? ` (${c.reject_reason})` : ""}`).join(", ")}
                </div>
              )}
            </div>
          )}

          {/* ═══ GATE 2 ═══ */}
          {phase === "gate2" && (
            <div className="fu" style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h3 style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>Verify contacts</h3>
                  <button onClick={() => { const all = enriched.map(e => e.company.name); setApproved2(approved2.size === all.length ? new Set() : new Set(all)); }}
                    className="btn-ghost" style={{ fontSize: 10, padding: "2px 8px" }}>
                    {approved2.size === enriched.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <button onClick={runOutreach} disabled={approved2.size === 0} className="btn-primary" style={{ fontSize: 12 }}>
                  Generate outreach ({approved2.size}) &#8594;
                </button>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {enriched.map((e, i) => {
                  const on = approved2.has(e.company.name);
                  const confColor = e.dm.confidence === "high" ? T.green : e.dm.confidence === "medium" ? T.orange : T.red;
                  return (
                    <div key={i} onClick={() => { const n = new Set(approved2); on ? n.delete(e.company.name) : n.add(e.company.name); setApproved2(n); }}
                      style={{ background: T.surface, border: `2px solid ${on ? T.blue : T.border}`, borderRadius: 10, padding: "14px 16px", cursor: "pointer", transition: "border-color .15s" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                          <div style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${on ? T.blue : T.borderLight}`, background: on ? T.blue : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>
                            {on && <svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 6l2 2 4-4" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" /></svg>}
                          </div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{e.company.name}</div>
                            <div style={{ fontSize: 11, color: T.textMuted }}>{e.company.employees} emp &middot; {e.company.industry || ""}</div>
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: T.purple }}>{e.dm.name}</div>
                          <div style={{ fontSize: 11, color: T.textMuted }}>{e.dm.title}</div>
                          <div style={{ fontSize: 10, color: confColor, fontWeight: 500 }}>{e.dm.confidence} confidence</div>
                        </div>
                      </div>
                      {/* DM details */}
                      <div style={{ marginLeft: 26, marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                        {e.dm.why && <div style={{ fontSize: 11, color: T.textSecondary }}>{e.dm.why}</div>}
                        {e.dm.background && <div style={{ fontSize: 11, color: T.textMuted, padding: "6px 10px", background: T.bg, borderRadius: 6, borderLeft: `2px solid ${T.purple}`, lineHeight: 1.5 }}>{e.dm.background}</div>}
                        <div style={{ display: "flex", gap: 12, marginTop: 2 }}>
                          {e.dm.linkedin_url && e.dm.linkedin_url.startsWith("http") && <a href={e.dm.linkedin_url} target="_blank" rel="noopener" onClick={ev => ev.stopPropagation()} style={{ fontSize: 11, color: T.cyan, textDecoration: "none" }}>LinkedIn &#8599;</a>}
                          {e.dm.email_guess && e.dm.email_guess.includes("@") && <span style={{ fontSize: 11, color: T.textDim }}>{e.dm.email_guess}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ═══ RESULTS ═══ */}
          {final.map((item, i) => {
            const isExp = expanded === i; const tab = tabs[i] || "roi"; const hss = hsStatus[item.company.name];
            return (
              <div key={i} className="card fu" style={{ marginBottom: 8, overflow: "hidden" }}>
                <div onClick={() => setExpanded(isExp ? null : i)} style={{ padding: "12px 16px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{item.company.name}</span>
                      {item.roi?.savings > 0 && <span style={{ fontSize: 13, fontWeight: 700, color: T.green }}>${Math.round(item.roi.savings / 1000)}K<span style={{ fontSize: 10, fontWeight: 400, color: T.textDim }}>/yr</span></span>}
                    </div>
                    <div style={{ fontSize: 11, color: T.textMuted }}>{item.dm.name} &middot; {item.dm.title}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {hs && <button onClick={e => { e.stopPropagation(); pushHS(item); }} disabled={hss === "pushing" || hss === "done"} style={{
                      padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, border: "none",
                      background: hss === "done" ? T.greenDim : hss === "error" ? T.redDim : hss === "pushing" ? T.border : T.blueDim,
                      color: hss === "done" ? T.green : hss === "error" ? T.red : hss === "pushing" ? T.textDim : T.blue, cursor: hss === "done" ? "default" : "pointer"
                    }}>{hss === "pushing" ? "Pushing..." : hss === "done" ? "&#10003; In HubSpot" : hss === "error" ? "&#10007; Retry" : "&#8594; HubSpot"}</button>}
                    <span style={{ color: T.textDim, fontSize: 12, transition: "transform .2s", transform: isExp ? "rotate(90deg)" : "none" }}>&#9656;</span>
                  </div>
                </div>
                {isExp && (
                  <div style={{ borderTop: `1px solid ${T.border}` }}>
                    <div style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}>
                      {[["roi", "ROI"], ["email", "Email"], ["linkedin", "LinkedIn"], ["post", "Post"]].map(([id, l]) => (
                        <button key={id} onClick={() => setTabs(p => ({ ...p, [i]: id }))} style={{
                          padding: "9px 16px", fontSize: 12, fontWeight: 500, border: "none",
                          borderBottom: tab === id ? `2px solid ${T.blue}` : "2px solid transparent",
                          background: "transparent", color: tab === id ? T.blue : T.textMuted
                        }}>{l}</button>
                      ))}
                    </div>
                    <div style={{ padding: 16 }}>
                      {tab === "roi" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                        <MetricCard l="Current hiring cost" v={`$${Math.round((item.roi?.hiring_annual || 0) / 1000)}K/yr`} c={T.red} />
                        <MetricCard l="Feather cost" v={`$${Math.round((item.roi?.feather_annual || 0) / 1000)}K/yr`} c={T.blue} />
                        <MetricCard l="Annual savings" v={`$${Math.round((item.roi?.savings || 0) / 1000)}K`} s={`${item.roi?.pct || 0}% reduction`} c={T.green} />
                      </div>}
                      {tab === "email" && item.outreach?.email && <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Subject: {item.outreach.email.subject}</span>
                          <div style={{ display: "flex", gap: 6 }}>
                            <CopyBtn text={`Subject: ${item.outreach.email.subject}\n\n${item.outreach.email.body}`} />
                            {item.dm.email_guess && item.dm.email_guess.includes("@") && <a href={`mailto:${item.dm.email_guess || ""}?subject=${encodeURIComponent(item.outreach.email.subject || "")}&body=${encodeURIComponent(item.outreach.email.body || "")}`}
                              className="btn-primary" style={{ padding: "3px 12px", fontSize: 11, textDecoration: "none", display: "inline-block" }}>Send &#8599;</a>}
                          </div>
                        </div>
                        {item.dm.email_guess && <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 8 }}>To: {item.dm.email_guess}</div>}
                        <pre style={{ background: T.bg, padding: 14, borderRadius: 8, border: `1px solid ${T.border}` }}>{item.outreach.email.body}</pre>
                      </div>}
                      {tab === "linkedin" && item.outreach?.linkedin && <div>
                        {item.dm.linkedin_url && item.dm.linkedin_url.startsWith("http") && <div style={{ marginBottom: 14 }}>
                          <a href={item.dm.linkedin_url} target="_blank" rel="noopener" style={{ background: "#0077b5", color: "#fff", padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
                            Open {item.dm.name.split(" ")[0]}'s profile &#8599;
                          </a>
                        </div>}
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                            <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 600, textTransform: "uppercase" }}>Connection note</span>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 10, color: (item.outreach.linkedin.note?.length || 0) > 300 ? T.red : T.textDim }}>{item.outreach.linkedin.note?.length || 0}/300</span>
                              <CopyBtn text={item.outreach.linkedin.note} />
                            </div>
                          </div>
                          <pre style={{ background: T.bg, padding: 12, borderRadius: 8, border: `1px solid ${T.border}`, borderLeft: `3px solid #0077b5` }}>{item.outreach.linkedin.note}</pre>
                        </div>
                        <div>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                            <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 600, textTransform: "uppercase" }}>Follow-up message</span>
                            <CopyBtn text={item.outreach.linkedin.followup} />
                          </div>
                          <pre style={{ background: T.bg, padding: 12, borderRadius: 8, border: `1px solid ${T.border}`, borderLeft: `3px solid ${T.purple}` }}>{item.outreach.linkedin.followup}</pre>
                        </div>
                      </div>}
                      {tab === "post" && item.outreach?.post && <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 600, textTransform: "uppercase" }}>LinkedIn post</span>
                          <div style={{ display: "flex", gap: 6 }}>
                            <span style={{ fontSize: 10, color: T.textDim }}>{item.outreach.post?.length || 0} chars</span>
                            <CopyBtn text={item.outreach.post} />
                          </div>
                        </div>
                        <pre style={{ background: T.bg, padding: 14, borderRadius: 8, border: `1px solid ${T.border}`, lineHeight: 1.7 }}>{item.outreach.post}</pre>
                      </div>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* ═══ COMPLETE ═══ */}
          {phase === "done" && final.length > 0 && (
            <div className="fu" style={{ marginTop: 12 }}>
              <div style={{ padding: "14px 18px", background: T.greenDim, border: `1px solid #166534`, borderRadius: 10, marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: T.green }}>Pipeline complete</span>
                  <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: T.green }}>{Math.floor(elapsed / 60)}m {elapsed % 60}s &middot; ~${costEst} API cost</span>
                </div>
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                  <Stat l="Scanned" v={signals.length} /><Stat l="Qualified" v={qualified.filter(c => c.qualified).length} /><Stat l="Outreach ready" v={final.length} /><Stat l="Total savings" v={`$${Math.round(final.reduce((s, e) => s + (e.roi?.savings || 0), 0) / 1000)}K/yr`} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button onClick={() => {
                  const esc = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
                  const rows = [["Company", "Industry", "Employees", "ICP Score", "DM Name", "DM Title", "DM Email", "DM LinkedIn", "Savings", "Savings %", "Email Subject", "Email Body", "LinkedIn Note", "LinkedIn Followup", "Post"].join(",")];
                  final.forEach(f => rows.push([esc(f.company.name), esc(f.company.industry || f.signal?.industry || ""), esc(f.company.employees),
                    f.company.total_score || "", esc(f.dm.name), esc(f.dm.title), esc(f.dm.email_guess || ""), esc(f.dm.linkedin_url || ""),
                    f.roi?.savings || "", f.roi?.pct || "", esc(f.outreach?.email?.subject || ""), esc(f.outreach?.email?.body || ""),
                    esc(f.outreach?.linkedin?.note || ""), esc(f.outreach?.linkedin?.followup || ""), esc(f.outreach?.post || "")
                  ].join(",")));
                  const blob = new Blob(["\uFEFF" + rows.join("\n")], { type: "text/csv" });
                  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `feather-pipeline-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
                }} className="btn-ghost" style={{ flex: 1 }}>Export CSV</button>
                <button onClick={() => {
                  const text = final.map(f => `## ${f.company.name}\nDM: ${f.dm.name} (${f.dm.title})\nEmail: ${f.dm.email_guess || "N/A"}\nLinkedIn: ${f.dm.linkedin_url || "N/A"}\nSavings: $${Math.round((f.roi?.savings || 0) / 1000)}K/yr\n\n### Email\nSubject: ${f.outreach?.email?.subject || ""}\n${f.outreach?.email?.body || ""}\n\n### LinkedIn Note\n${f.outreach?.linkedin?.note || ""}\n\n### Follow-up\n${f.outreach?.linkedin?.followup || ""}\n\n### Post\n${f.outreach?.post || ""}\n\n---`).join("\n\n");
                  navigator.clipboard.writeText(text);
                }} className="btn-ghost" style={{ flex: 1 }}>Copy all outreach</button>
              </div>
              <button onClick={() => { resetPipeline(); setPhase("idle"); }} className="btn-ghost" style={{ width: "100%" }}>Run new pipeline</button>
            </div>
          )}
        </div>

        {/* ═══ ACTIVITY LOG ═══ */}
        {stageIdx >= 0 && (
          <div style={{ width: 300, flexShrink: 0 }} className="fu">
            <div style={{ position: "sticky", top: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <h3 style={{ fontSize: 11, fontWeight: 600, color: T.textDim, textTransform: "uppercase", letterSpacing: ".05em" }}>Activity</h3>
                <span style={{ fontSize: 10, color: T.textDim }}>
                  {logs.length} events{tokenCount.input > 0 && ` · ~$${costEst}`}
                </span>
              </div>
              <div className="card" style={{ maxHeight: "calc(100vh - 120px)", overflowY: "auto", fontSize: 11 }}>
                {logs.map((l, i) => (
                  <div key={i} className="si" style={{
                    padding: "5px 10px", borderBottom: `1px solid ${T.bg}`,
                    background: l.type === "success" ? T.greenDim : l.type === "error" ? T.redDim : l.type === "gate" ? T.orangeDim : l.type === "warn" ? T.orangeDim : "transparent",
                    opacity: l.type === "dim" ? 0.5 : 1
                  }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                      <span style={{ fontSize: 9, color: T.textDim, fontFamily: "'JetBrains Mono',monospace", flexShrink: 0, marginTop: 1 }}>{l.time}</span>
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", marginRight: 4,
                          color: l.type === "success" ? T.green : l.type === "error" ? T.red : l.type === "gate" ? T.orange : l.type === "warn" ? T.orange : T.textDim
                        }}>{l.src}</span>
                        <span style={{ color: l.type === "error" ? "#fca5a5" : l.type === "gate" ? "#fcd34d" : T.textSecondary, lineHeight: 1.4, display: "inline" }}>{l.msg}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {isRunning && <div style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 8, height: 8, border: `2px solid ${T.blue}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin .8s linear infinite" }} />
                  <span style={{ fontSize: 11, color: T.textDim }}>
                    {phase === "scanning" ? "Searching..." : phase === "enriching" ? "Finding contacts..." : "Generating..."}
                  </span>
                </div>}
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
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: T.text, marginBottom: 4 }}>How it works</h1>
      <p style={{ fontSize: 13, color: T.textMuted, marginBottom: 32 }}>Three phases. Human approval between each. Nothing sends without your sign-off.</p>

      <div style={{ display: "flex", gap: 20, marginBottom: 36, padding: "12px 0", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>
        {[["5-10", "signals/run"], ["~30-50%", "pass ICP"], ["~$0.05", "API cost/lead"], ["10-15 min", "your time"]].map(([v, l]) => (
          <div key={l}><span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>{v}</span><span style={{ fontSize: 11, color: T.textMuted, marginLeft: 6 }}>{l}</span></div>
        ))}
      </div>

      {[
        { n: "1", title: "Discover", time: "~45s", desc: "Uses Claude web search to find companies actively hiring phone agents from public job boards. Scores each against a 6-factor weighted ICP model.", tools: [["Claude web search", T.blue], ["ICP scoring", T.green]] },
        { n: "2", title: "Enrich", time: "~20s/company", desc: "Uses Claude web search to find the right decision maker — VP Ops, COO, or Director of Contact Center. Validates email format and LinkedIn URL.", tools: [["Claude web search", T.blue], ["Email validation", T.green]] },
        { n: "3", title: "Activate", time: "~15s/company", desc: "Generates ROI analysis using salary benchmarks vs Feather's $0.07/min pricing. Drafts personalized cold email, LinkedIn messages, and thought leadership post.", tools: [["ROI engine", T.green], ["Copy generation", T.purple]] },
      ].map((step, idx) => (
        <div key={step.n}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{ width: 24, height: 24, borderRadius: "50%", background: T.blue, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff" }}>{step.n}</div>
            <span style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{step.title}</span>
            <span style={{ fontSize: 11, color: T.textDim }}>{step.time}</span>
          </div>
          <div style={{ marginLeft: 34, marginBottom: 12 }}>
            <p style={{ fontSize: 13, color: T.textMuted, marginBottom: 8, lineHeight: 1.5 }}>{step.desc}</p>
            <div style={{ display: "flex", gap: 10 }}>
              {step.tools.map(([name, c]) => <span key={name} style={{ fontSize: 11, color: c, fontWeight: 500 }}>{name}</span>)}
            </div>
          </div>
          {idx < 2 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 10, margin: "8px 0" }}>
              <div style={{ flex: 1, height: 1, background: T.border }} />
              <span style={{ fontSize: 10, fontWeight: 600, color: T.orange, background: T.orangeDim, padding: "2px 10px", borderRadius: 4 }}>You approve</span>
              <div style={{ flex: 1, height: 1, background: T.border }} />
            </div>
          )}
        </div>
      ))}

      {/* ICP model */}
      <div style={{ marginTop: 32, marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 10 }}>ICP scoring model</h2>
        <div style={{ borderTop: `1px solid ${T.border}` }}>
          {[["Phone intensity", "25%", "How many call center roles are open"], ["Industry fit", "20%", "Mortgage, insurance, credit union, lending"],
            ["AI readiness", "20%", "No existing AI voice vendor detected"], ["Company size", "15%", "200-2,000 employees"],
            ["Budget signal", "10%", "3+ concurrent hires"], ["Timing urgency", "10%", "Posted within 7 days"]
          ].map(([name, w, desc]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ width: 120, fontSize: 12, fontWeight: 500, color: T.textSecondary }}>{name}</span>
              <span style={{ width: 36, fontSize: 12, fontWeight: 600, color: T.blue, textAlign: "right" }}>{w}</span>
              <span style={{ flex: 1, fontSize: 11, color: T.textDim, marginLeft: 14 }}>{desc}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11 }}>
          <span style={{ color: T.green, fontWeight: 600 }}>Qualify: &ge; 6.0 / 10</span>
          <span style={{ color: T.textDim }}>Auto-reject: AI voice vendor &middot; government &middot; &gt;5K emp &middot; &lt;50 emp</span>
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16, fontSize: 12, color: T.textDim, lineHeight: 1.6 }}>
        Three gates. Zero autopilot. AI does the research. You make the decisions.
      </div>
    </div>
  );
}

/* ═══ SHARED COMPONENTS ═══ */
function Tag({ children, color = "blue" }) {
  const c = { blue: [T.blueDim, T.blue], green: [T.greenDim, T.green], red: [T.redDim, T.red] }[color] || [T.blueDim, T.blue];
  return <span style={{ display: "inline-block", padding: "1px 7px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: c[0], color: c[1] }}>{children}</span>;
}
function MetricCard({ l, v, s, c }) {
  return <div style={{ background: T.bg, borderRadius: 8, padding: "12px 14px", borderLeft: `3px solid ${c}` }}>
    <div style={{ fontSize: 10, color: T.textDim, marginBottom: 3 }}>{l}</div>
    <div style={{ fontSize: 18, fontWeight: 700, color: c }}>{v}</div>
    {s && <div style={{ fontSize: 10, color: T.textDim, marginTop: 2 }}>{s}</div>}
  </div>;
}
function Stat({ l, v }) { return <div><div style={{ fontSize: 10, color: T.green, fontWeight: 500, marginBottom: 1 }}>{l}</div><div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>{v}</div></div>; }
function CopyBtn({ text, label }) {
  const [c, setC] = useState(false);
  return <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setC(true); setTimeout(() => setC(false), 1500); }}
    className="btn-ghost" style={{ padding: "3px 10px", fontSize: 11 }}>{c ? "Copied" : label || "Copy"}</button>;
}
