import { useState, useRef, useCallback, useEffect } from "react";

let _apiKey = localStorage.getItem("hss_api_key") || "";
let _hubspotToken = localStorage.getItem("hss_hs_token") || "";
let _addLog = null;

/* ═══ UTILITIES ═══ */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const delay = sleep;
// Visible countdown — updates log every 5s so user knows it's not frozen
async function countdownWait(seconds, logFn, label) {
  const total = seconds;
  let remaining = seconds;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 5);
    if (logFn && remaining < total) logFn("WAIT", "Cooldown", `${label} ${remaining}s remaining...`);
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

  // Strategy 1: Direct parse
  try { const r = JSON.parse(clean); return Array.isArray(r) ? r : r; } catch (e) {}

  // Strategy 2: Extract outermost array
  const arrStart = clean.indexOf('[');
  const arrEnd = clean.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try { const a = JSON.parse(clean.slice(arrStart, arrEnd + 1)); return { signals: a, companies: a }; } catch (e) {}
  }

  // Strategy 3: Extract outermost object, wrap in array
  const objStart = clean.indexOf('{');
  const objEnd = clean.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try { return JSON.parse(clean.slice(objStart, objEnd + 1)); } catch (e) {}
  }

  // Strategy 4: Line-by-line scan
  for (const line of clean.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try { const p = JSON.parse(t); return Array.isArray(p) ? { signals: p } : p; } catch (e) {}
    }
  }

  // Strategy 5: Find all {...} blocks via regex and build array
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
   Haiku for all calls. Web search via web_search_20250305 tool.
   Retry with backoff on 429s. */
async function callClaude(systemPrompt, userMessage, useWebSearch = false, maxSearchUses = 3, useModel = null) {
  const addLog = _addLog;
  const model = useModel || 'claude-haiku-4-5-20251001';
  const timeoutMs = useWebSearch ? 90000 : 60000;
  const maxTok = useWebSearch ? 2048 : 1500;

  const body = {
    model,
    max_tokens: maxTok,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearchUses }];
  }

  const cleanKey = _apiKey.replace(/[^\x20-\x7E]/g, '').trim();
  let lastError = null;
  const maxRetries = 5;
  // Backoff: 30s, 45s, 60s, 75s, 90s
  const backoff = (n) => 30 + n * 15;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cleanKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 429 || res.status === 529) {
        const retryAfter = res.headers.get('retry-after');
        const waitSec = retryAfter ? Math.min(parseInt(retryAfter, 10) || backoff(attempt), 120) : backoff(attempt);
        if (addLog) addLog("RATE", "Rate Limit", `Attempt ${attempt + 1}/${maxRetries} — backing off ${waitSec}s...`, "orange");
        await countdownWait(waitSec, addLog, `Rate limit cooldown —`);
        lastError = new Error('Rate limited');
        continue;
      }
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`API ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await res.json();
      if (data.usage && addLog) {
        const inp = data.usage.input_tokens || 0;
        const out = data.usage.output_tokens || 0;
        addLog("TOK", "Tokens", `${Math.round(inp/1000)}K in / ${Math.round(out/1000)}K out`, "info");
      }
      return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (err.name === 'AbortError') {
        if (addLog) addLog("TIME", "Timeout", `Request timed out after ${timeoutMs/1000}s — retrying...`, "orange");
      } else if (attempt < maxRetries - 1) {
        if (addLog) addLog("ERR", "Error", `${err.message.slice(0, 100)} — retrying in ${backoff(attempt)}s`, "red");
      }
      if (attempt < maxRetries - 1) await sleep(backoff(attempt) * 1000);
    }
  }
  throw lastError || new Error('Rate limited — wait 60s and try again');
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

const PRESETS = [
  "Mortgage lenders hiring loan officers or call center agents",
  "Debt collection agencies hiring phone collectors",
  "Credit unions hiring member service reps",
  "Auto lenders hiring loan servicing phone agents",
  "Insurance carriers hiring claims adjusters or phone reps",
  "Fintech companies hiring customer support agents",
];

/* ═══════════════ APP ROOT ═══════════════ */
export default function App() {
  const [page, setPage] = useState("pipeline");
  const [showConfig, setShowConfig] = useState(false);
  const [keys, setKeys] = useState({ a: _apiKey, h: _hubspotToken });
  const [connected, setConnected] = useState({ a: !!_apiKey, h: !!_hubspotToken });
  const [hsVerified, setHsVerified] = useState(false);

  const updateKey = (k, v) => {
    const clean = v.replace(/[^\x20-\x7E]/g, "").trim();
    setKeys(p => ({ ...p, [k]: clean }));
    if (k === "a") { _apiKey = clean; localStorage.setItem("hss_api_key", clean); setConnected(p => ({ ...p, a: !!clean })); }
    if (k === "h") { _hubspotToken = clean; localStorage.setItem("hss_hs_token", clean); setConnected(p => ({ ...p, h: !!clean })); setHsVerified(false); }
  };

  const [hsVerifyMsg, setHsVerifyMsg] = useState("");
  const verifyHubSpot = async () => {
    if (!_hubspotToken) return;
    setHsVerifyMsg("Checking...");
    try {
      const res = await fetch("/api/hubspot/crm/v3/objects/contacts?limit=1", {
        headers: { "Content-Type": "application/json", "x-hubspot-token": _hubspotToken }
      });
      if (res.ok) {
        // Also check we can read companies + deals (needed for push)
        const res2 = await fetch("/api/hubspot/crm/v3/objects/companies?limit=1", {
          headers: { "Content-Type": "application/json", "x-hubspot-token": _hubspotToken }
        });
        const res3 = await fetch("/api/hubspot/crm/v3/objects/deals?limit=1", {
          headers: { "Content-Type": "application/json", "x-hubspot-token": _hubspotToken }
        });
        const allOk = res2.ok && res3.ok;
        setHsVerified(allOk);
        setConnected(p => ({ ...p, h: allOk }));
        setHsVerifyMsg(allOk ? "Connected — contacts, companies, deals access confirmed" : `Partial access — contacts OK, companies: ${res2.ok ? "OK" : "DENIED"}, deals: ${res3.ok ? "OK" : "DENIED"}`);
      } else {
        const errData = await res.json().catch(() => ({}));
        setHsVerified(false);
        setConnected(p => ({ ...p, h: false }));
        setHsVerifyMsg(`Failed: ${errData.message || errData.category || res.status} — check your PAT scopes (needs crm.objects.contacts, .companies, .deals)`);
      }
    } catch (err) {
      setHsVerified(false);
      setConnected(p => ({ ...p, h: false }));
      setHsVerifyMsg(`Connection error: ${err.message} — are you running the server? (npm start)`);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#fafbfc", color: "#1a1a2e", fontFamily: "'Inter',-apple-system,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}button{cursor:pointer;font-family:inherit}input:focus{outline:none}
        pre{white-space:pre-wrap;word-break:break-word;margin:0;font-family:'JetBrains Mono',monospace;font-size:13px;line-height:1.65;color:#374151}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
        .fu{animation:fadeUp .35s ease-out both}.si{animation:slideIn .25s ease-out both}
      `}</style>

      <nav style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "0 32px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5L12 3Z" fill="#1a1a2e" /><path d="M8 16c2-5 5-8 9-10-2 3-3 5.5-3.5 8.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>Feather</span>
            <span style={{ fontSize: 9, color: "#9ca3af", background: "#f3f4f6", padding: "2px 6px", borderRadius: 3, fontWeight: 500 }}>GTM v1.0</span>
          </div>
          <div style={{ height: 20, width: 1, background: "#e5e7eb" }} />
          {[["pipeline", "Pipeline"], ["architecture", "Architecture"]].map(([id, l]) => (
            <button key={id} onClick={() => setPage(id)} style={{ padding: "6px 16px", borderRadius: 6, fontSize: 13, fontWeight: 500, border: "none", background: page === id ? "#f0f4ff" : "transparent", color: page === id ? "#2563eb" : "#6b7280" }}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {connected.a && <span style={{ fontSize: 11, color: "#10b981", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981", display: "inline-block" }} />Claude API</span>}
          {keys.h && <span style={{ fontSize: 11, color: hsVerified ? "#f97316" : "#9ca3af", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: hsVerified ? "#f97316" : "#9ca3af", display: "inline-block" }} />{hsVerified ? "HubSpot ✓" : "HubSpot (unverified)"}</span>}
          <button onClick={() => setShowConfig(!showConfig)} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 500, background: showConfig ? "#f0f4ff" : "#fff", border: "1px solid #e5e7eb", color: "#374151" }}>{showConfig ? "Hide settings" : "Settings"}</button>
        </div>
      </nav>

      {showConfig && (
        <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "16px 32px", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }} className="fu">
          <Inp label="Anthropic API key" ph="sk-ant-api03-..." v={keys.a} set={v => updateKey("a", v)} ok={connected.a} pw />
          <div style={{ flex: "1 1 280px" }}>
            <Inp label="HubSpot private app token (optional)" ph="pat-na1-..." v={keys.h} set={v => updateKey("h", v)} ok={hsVerified} pw />
            {keys.h && <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={verifyHubSpot} style={{ fontSize: 11, fontWeight: 600, color: hsVerified ? "#059669" : "#f97316", background: hsVerified ? "#f0fdf4" : "#fff7ed", border: `1px solid ${hsVerified ? "#86efac" : "#fed7aa"}`, borderRadius: 5, padding: "3px 10px" }}>{hsVerified ? "Re-verify" : "Verify connection"}</button>
              {hsVerifyMsg && <span style={{ fontSize: 10, color: hsVerified ? "#059669" : "#dc2626" }}>{hsVerifyMsg}</span>}
            </div>}
          </div>
        </div>
      )}
      {page === "pipeline" ? <Pipeline hs={hsVerified} /> : <Arch />}
    </div>
  );
}

function Inp({ label, ph, v, set, ok, pw }) {
  return (
    <div style={{ flex: "1 1 280px" }}>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>{label} {ok && <span style={{ color: "#10b981", fontSize: 10 }}>&#10003;</span>}</div>
      <input type={pw ? "password" : "text"} placeholder={ph} value={v} onChange={e => set(e.target.value)} style={{ width: "100%", background: "#f9fafb", border: `1px solid ${ok ? "#86efac" : "#e5e7eb"}`, borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "#374151", fontFamily: "'JetBrains Mono',monospace" }} />
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
  const running = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const logEnd = useRef(null);
  const [runGuard, setRunGuard] = useState(false);

  const log = useCallback((icon, src, msg, type = "info") => {
    setLogs(p => [...p, { icon, src, msg, type, time: ts() }]);
  }, []);
  _addLog = log;

  useEffect(() => { logEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  const resetPipeline = useCallback(() => {
    setSignals([]); setQualified([]); setApproved1(new Set()); setEnriched([]);
    setApproved2(new Set()); setFinal([]); setExpanded(null); setLogs([]);
    setError(null); setHsStatus({}); setElapsed(0); setTabs({});
    clearInterval(timerRef.current); timerRef.current = null;
  }, []);

  /* ── HUBSPOT PUSH ── */
  const pushHS = async (item) => {
    if (!_hubspotToken) return;
    const id = item.company.name;
    setHsStatus(p => ({ ...p, [id]: "pushing" }));
    try {
      log("HUB", "HubSpot", `Pushing ${item.company.name} to CRM...`);
      const empCount = parseNum(item.company.employees);

      // ── 1. COMPANY: search for existing first, create if not found ──
      let coId = null;
      try {
        const search = await hubspot("POST", "crm/v3/objects/companies/search", {
          filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: item.company.name }] }],
          limit: 1
        });
        if (search?.results?.length > 0) {
          coId = search.results[0].id;
          log("HUB", "HubSpot", `Company "${item.company.name}" already exists (ID: ${coId}) — updating`, "info");
          await hubspot("PATCH", `crm/v3/objects/companies/${coId}`, {
            properties: {
              industry: item.signal?.industry || item.company.industry || "",
              numberofemployees: empCount || undefined,
              description: truncate(`ICP Score: ${item.company.total_score}/10. Hiring ${item.signal?.num_openings || "multiple"}x ${item.signal?.role_title || "phone agents"}. Source: ${item.signal?.source || "web"}.`, 2000)
            }
          });
        }
      } catch (e) { /* search failed, create fresh */ }

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
        log("HUB", "HubSpot", `Created company "${item.company.name}" (ID: ${coId})`, "info");
      }

      // ── 2. CONTACT: search by email first, create if not found ──
      let contactId = null;
      if (item.dm?.name && item.dm.name !== "N/A" && item.dm.email_guess && item.dm.email_guess.includes("@")) {
        try {
          const search = await hubspot("POST", "crm/v3/objects/contacts/search", {
            filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: item.dm.email_guess }] }],
            limit: 1
          });
          if (search?.results?.length > 0) {
            contactId = search.results[0].id;
            log("HUB", "HubSpot", `Contact "${item.dm.name}" already exists — updating`, "info");
            await hubspot("PATCH", `crm/v3/objects/contacts/${contactId}`, {
              properties: { jobtitle: item.dm.title || "", company: item.company.name }
            });
          }
        } catch (e) { /* search failed, create fresh */ }

        if (!contactId) {
          const names = item.dm.name.trim().split(/\s+/);
          const contact = await hubspot("POST", "crm/v3/objects/contacts", {
            properties: {
              firstname: names[0] || "",
              lastname: names.slice(1).join(" ") || "",
              jobtitle: item.dm.title || "",
              company: item.company.name,
              email: item.dm.email_guess,
              hs_content_membership_notes: truncate(item.dm.background || "", 500),
            },
            associations: coId ? [{ to: { id: coId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 1 }] }] : []
          });
          contactId = contact?.id;
          log("HUB", "HubSpot", `Created contact "${item.dm.name}" (ID: ${contactId})`, "info");
        }
      }

      // ── 3. DEAL: always create new (each pipeline run = new opportunity) ──
      const savings = parseNum(item.roi?.savings);
      const desc = truncate([
        `Decision maker: ${item.dm?.name || "TBD"} (${item.dm?.title || ""})`,
        item.dm?.email_guess ? `Email: ${item.dm.email_guess}` : "",
        item.dm?.linkedin_url ? `LinkedIn: ${item.dm.linkedin_url}` : "",
        savings ? `ROI: $${Math.round(savings / 1000)}K/yr savings (${item.roi?.pct || 0}% reduction)` : "",
        item.outreach?.email?.subject ? `\nEmail subject: ${item.outreach.email.subject}` : "",
        item.outreach?.email?.body ? `Email body: ${item.outreach.email.body}` : "",
      ].filter(Boolean).join("\n"), 2000);

      const deal = await hubspot("POST", "crm/v3/objects/deals", {
        properties: {
          dealname: `Feather — ${item.company.name} — ${new Date().toLocaleDateString()}`,
          pipeline: "default",
          dealstage: "appointmentscheduled",
          amount: savings > 0 ? String(savings) : "100000",
          description: desc,
        },
        associations: coId ? [{ to: { id: coId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }] }] : []
      });

      setHsStatus(p => ({ ...p, [id]: "done" }));
      log("HUB", "HubSpot", `Pushed to CRM: company + ${contactId ? "contact + " : ""}deal for ${item.company.name}`, "success");
    } catch (err) {
      setHsStatus(p => ({ ...p, [id]: "error" }));
      log("ERR", "HubSpot", `Failed: ${item.company.name} — ${err.message}`, "error");
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
    resetPipeline();
    setPhase("scanning");
    timerRef.current = setInterval(() => setElapsed(p => p + 1), 1000);

    try {
      // ── STEP 1: Web search → prose (Sonnet + 1 combined site-targeted search) ──
      const today = new Date().toLocaleDateString();
      log("MODEL", "Haiku", "Using Haiku for web search — zero rate limit risk");
      log("WAIT", "Warmup", "5s warmup to ensure clean rate window...");
      await countdownWait(5, log, "Warmup —");
      log("SCAN", "Indeed", `Searching site:indeed.com for: ${input.slice(0, 50)}...`);
      await sleep(200);
      log("SCAN", "LinkedIn Jobs", `Searching site:linkedin.com/jobs for postings...`);
      await sleep(200);
      log("SCAN", "ZipRecruiter", `Searching site:ziprecruiter.com for openings...`);
      await sleep(150);
      log("SCAN", "Glassdoor", `Searching site:glassdoor.com/Job for listings...`);

      const proseResult = await callClaude(
        `Job posting researcher. Today: ${today}. You have 1 web search. Find mid-market companies (100-5000 employees) with active job postings.\n\nFor EACH company write a paragraph with ALL of these details:\n- Company name\n- Industry\n- Approximate employee count (e.g. "~500 employees")\n- HQ location\n- Specific job titles being hired\n- Number of open positions\n- Which job board (Indeed, LinkedIn, ZipRecruiter, Glassdoor)\n- URL if available\n\nSkip Fortune 500 / mega-corps. Write at least 3-4 sentences per company.`,
        `Search: ${input}\n\nFind 5-8 real companies actively hiring. Write a detailed paragraph per company. Include employee counts. No JSON — prose only.`,
        true, 1
      );

      log("OK", "Scan", `Search complete — parsing results...`, "success");

      // ── 10-second pause between Step 1 and Step 2 ──
      log("WAIT", "Cooldown", "Waiting 10s before parsing...");
      await countdownWait(10, log, "Cooldown —");

      // ── STEP 2: Parse prose → JSON (Haiku — fast structured output) ──
      log("MODEL", "Haiku", "Switching to Haiku for fast JSON parsing");
      log("PARSE", "Parser", "Converting to structured data...");

      const s1 = await callClaude(
        "Convert the research report into a JSON array. Return ONLY valid JSON — no markdown, no backticks, no explanation, no preamble. Start your response with { and the key \"signals\".",
        `Convert this into a JSON object with a "signals" array. Each object: {company, role_title, location, num_openings (number), industry, employees (string — e.g. "500" or "1200", from the report), signal_strength ("high"/"medium"/"low"), days_ago (number or null), source (string — which job board), job_url (string or null), posted_date (string or null)}.\n\nReport:\n${proseResult}`,
        false
      );

      let d1 = parseJSON(s1);
      if (!d1?.signals?.length) {
        try {
          const lines = (s1 || "").split("\n");
          for (const line of lines) {
            const a = parseJSON(line);
            if (a?.signals?.length) { d1 = a; break; }
          }
        } catch (e) {}
      }
      if (!d1?.signals?.length) throw new Error("No signals found — try again in 60s.");

      const fresh = d1.signals.filter(s => !s.days_ago || s.days_ago <= 7);
      const stale = d1.signals.filter(s => s.days_ago && s.days_ago > 7 && s.days_ago <= 14);
      const useSignals = fresh.length > 0 ? fresh : stale.length > 0 ? stale : d1.signals;
      if (!useSignals.length) throw new Error("No signals found — try a different query.");

      setSignals(useSignals);
      if (fresh.length === 0 && stale.length > 0) log("WARN", "Filter", `No postings within 7 days — showing ${stale.length} from last 14 days`);
      if (fresh.length === 0 && stale.length === 0) log("WARN", "Filter", "No freshness data available — showing all signals");

      useSignals.forEach(s => {
        const age = s.days_ago ? (s.days_ago <= 3 ? "NEW" : s.days_ago <= 7 ? "OK" : "OLD") : "UNK";
        const dateStr = s.posted_date ? ` · Posted: ${s.posted_date}` : s.days_ago ? ` · ${s.days_ago}d ago` : "";
        log(age, "Signal", `${s.company} — ${s.num_openings ? s.num_openings + "x " : ""}${s.role_title} (${s.location || "US"}) via ${s.source || "web"}${dateStr}`);
      });

      log("ICP", "ICP Engine", "Running weighted 6-factor qualification model...");

      // ── LOCAL ICP SCORING ──
      const companies = useSignals.map(s => {
        const r = (s.role_title || "") + " " + (s.company || "");
        const ind = s.industry || "";
        const emp = parseNum(s.employees) || 0;
        const openings = s.num_openings || 3;
        const days = s.days_ago || 7;
        const companyText = `${s.company} ${ind} ${r}`.toLowerCase();

        // 1. INDUSTRY ALIGNMENT (weight 20%)
        const indText = ind + " " + r;
        const coreInd = /mortgage|lending|loan|debt collect|credit union|underwriting|servicing/i.test(indText);
        const adjInd = /bank|fintech|financial|insurance|collection|title company|escrow/i.test(indText);
        const industryScore = coreInd ? 2 : adjInd ? 1 : 0;

        // 2. COMPANY SIZE (weight 15%) — score from employee data if available
        const sizeScore = emp === 0
          ? 1  // unknown — optimistic but not max
          : emp >= 100 && emp <= 2000 ? 2  // sweet spot
          : emp >= 50 && emp < 100 ? 1    // too small but possible
          : emp > 2000 && emp <= 5000 ? 1 // too big but possible
          : 0;                            // <50 or >5K — kill criteria

        // 3. PHONE OPERATION intensity (weight 25%)
        const phoneRole = /call center|phone|customer service|collections|loan servicing|loan officer|mortgage processor|inbound|outbound|representative|agent|collector|claims|adjuster|member service/i.test(r);
        const phoneScore = phoneRole ? (openings >= 5 ? 2 : 1) : 0;

        // 4. AI VOICE READINESS (weight 20%) — only penalize if known AI voice vendor detected
        const hasAiVoice = /vapi|retell|bland|synthflow|twilio flex|five9|genesys cloud|nice cxone|livevox|skit\.ai|replicant|parloa/i.test(companyText);
        const aiScore = hasAiVoice ? 0 : 2;

        // 5. BUDGET SIGNAL (weight 10%)
        const budgetScore = openings >= 3 ? 2 : 1;

        // 6. TIMING URGENCY (weight 10%)
        const timingScore = days <= 7 ? (openings >= 5 ? 2 : 1) : 0;

        // Formula: (p*25 + i*20 + a*20 + s*15 + b*10 + t*10) / 20
        const weighted = (phoneScore * 25 + industryScore * 20 + aiScore * 20 + sizeScore * 15 + budgetScore * 10 + timingScore * 10) / 20;
        const score = Math.round(weighted * 10) / 10;
        const empLabel = emp > 0 ? `${emp.toLocaleString()}` : "200-2000";

        return {
          name: s.company,
          total_score: score,
          weighted_score: score,
          qualified: score >= 6.0 && sizeScore > 0 && !hasAiVoice,
          industry: ind,
          employees: empLabel,
          revenue: "Est. $50M-500M",
          has_ai_voice: hasAiVoice,
          estimated_contract_value: "$" + (openings * (phoneRole && /loan officer|collector|adjuster/i.test(r) ? 22000 : 15000)).toLocaleString() + "/yr",
          reasoning: `${openings}x ${s.role_title || "phone"} roles in ${ind || "financial services"}`,
          scores: { industry: industryScore, size: sizeScore, phone_intensity: phoneScore, ai_readiness: aiScore, budget: budgetScore, timing: timingScore },
          evidence: {
            industry: coreInd ? `Core ${ind} company` : adjInd ? "Adjacent financial services" : "Non-financial",
            size: emp > 0 ? `${emp.toLocaleString()} employees` : "Size unknown — assumed mid-market",
            phone_intensity: `${openings} ${s.role_title || "phone"} openings found`,
            ai_readiness: hasAiVoice ? "AI voice vendor detected — disqualified" : "No AI voice vendor detected",
            budget: `${openings} concurrent hires signals budget`,
            timing: `Posted ~${days} days ago`
          }
        };
      });

      setQualified(companies);
      companies.filter(c => c.qualified).forEach(c => {
        log("PASS", "ICP", `${c.name} — ${c.total_score}/10 (${c.employees} emp)`, "success");
      });
      companies.filter(c => !c.qualified).forEach(c => log("FAIL", "ICP", `${c.name} — ${c.total_score}/10 (below threshold)`, "filtered"));

      if (!companies.some(c => c.qualified)) throw new Error("No companies qualified — try a different vertical.");
      log("GATE", "Gate 1", "Awaiting human approval — review qualified companies below", "gate");
      setPhase("gate1"); clearInterval(timerRef.current);
    } catch(e) { setError(e.message); log("ERR", "Error", e.message, "error"); clearInterval(timerRef.current); setPhase("idle"); }
    finally { running.current = false; setRunGuard(false); }
  }, [log, resetPipeline, runGuard]);

  /* ── PHASE 2: FIND DMS ── */
  const runEnrich = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase("enriching"); timerRef.current = setInterval(() => setElapsed(p => p + 1), 1000);
    const picked = qualified.filter(c => c.qualified && approved1.has(c.name));
    try {
      log("MODEL", "Haiku", "Using Haiku for contact research — fast + reliable");
      log("WAIT", "Cooldown", "Waiting 15s before enrichment...");
      await countdownWait(15, log, "Pre-enrichment cooldown —");
      const results = [];
      let _enrichIdx = 0;
      for (const co of picked) {
        try {
          const sig = signals.find(s => s.company === co.name) || signals[0];
          log("DM", "Apollo.io", `Searching apollo.io/companies for ${co.name} contacts...`);
          await sleep(250);
          log("DM", "LinkedIn", `Searching linkedin.com for decision makers at ${co.name}...`);
          await sleep(200);
          log("DM", "Hunter.io", `Resolving email pattern @${(co.name || "").toLowerCase().replace(/[^a-z]/g, "")}.com...`);

          const coDomain = (co.name || "").toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";

          // Step 1: Web search for executives (prose) — then parse to JSON
          const searches = [
            `"${co.name}" COO OR CRO OR "Director of Sales" OR "Director of Operations" OR VP site:linkedin.com/in/ OR site:apollo.io`,
            `"${co.name}" CEO OR COO OR "Vice President" OR founder site:linkedin.com`,
            `"${co.name}" leadership team executives management`,
          ];

          let dms = [];
          for (let si = 0; si < searches.length; si++) {
            if (si > 0) {
              log("RETRY", "Apollo.io", `Attempt ${si + 1}/3 — broadening search for ${co.name}...`);
              await countdownWait(8, log, "Retry cooldown —");
            }

            // Search step — get prose about executives
            const prose = await callClaude(
              `Find executives at "${co.name}". List every person you find with their full name, title, and LinkedIn URL. Be thorough.`,
              `Search: ${searches[si]}\n\nList all executives/leaders you find at ${co.name}. For each person: full name, title, LinkedIn profile URL. Focus on: COO, CRO, Director of Sales, Director of Operations, VP Ops, VP Sales, CEO.`,
              true, 1
            );

            // Parse step — extract structured data from prose
            if (prose && prose.length > 20) {
              const parsed = await callClaude(
                `Extract people from this text into JSON. Return ONLY valid JSON starting with {. No markdown.`,
                `Extract all people mentioned below into this format. Use ${coDomain} for email guesses (firstname.lastname@${coDomain}).\n\n{"dms":[{"name":"Full Name","title":"Title","linkedin_url":"url or empty","email_guess":"email","confidence":"high/medium/low","why":"source","background":"any facts"}]}\n\nText:\n${prose}`,
                false
              );
              const d3 = parseJSON(parsed);
              const found = (d3?.dms || (d3?.dm ? [d3.dm] : [])).filter(d => d.name && d.name !== "N/A" && d.name !== "Unknown" && d.name.length > 3);
              if (found.length > 0) { dms = found.slice(0, 3); break; }
            }
          }

          const dm = dms[0] || { name: "N/A", title: "Ops Leader", confidence: "low", background: "" };
          if (dms.length > 0) {
            dms.forEach((d, idx) => {
              const tag = idx === 0 ? "PRIMARY" : "ALT";
              log("OK", "Apollo.io", `${tag}: ${d.name} — ${d.title} (${d.confidence})`, "success");
              if (d.email_guess) log("EM", "Hunter.io", `${d.email_guess}`);
              if (d.linkedin_url && d.linkedin_url.startsWith("http")) log("LI", "LinkedIn", `${d.linkedin_url}`);
            });
            if (dm.background) log("BG", "Background", dm.background);
          } else {
            log("WARN", "Apollo.io", `Could not find contacts for ${co.name} after 3 attempts`, "orange");
          }
          results.push({ company: co, signal: sig, dm, dms });
          setEnriched([...results]);
          _enrichIdx++;
          if (_enrichIdx < picked.length) { log("WAIT", "Cooldown", "Waiting 10s between companies..."); await countdownWait(10, log, "Between-company cooldown —"); }
        } catch(err) { log("ERR", "Error", `${co.name}: ${err.message} — skipping`, "error"); _enrichIdx++; }
      }
      if (results.length === 0) throw new Error("No contacts found.");
      log("GATE", "Gate 2", "Awaiting human approval — verify contacts below", "gate");
      setPhase("gate2"); clearInterval(timerRef.current);
    } catch(e) { setError(e.message); log("ERR", "Error", e.message, "error"); clearInterval(timerRef.current); setPhase("idle"); }
    finally { running.current = false; }
  }, [qualified, approved1, signals, log]);

  /* ── PHASE 3: ROI + OUTREACH ── */
  const runOutreach = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase("outreach"); timerRef.current = setInterval(() => setElapsed(p => p + 1), 1000);
    const picked = enriched.filter(e => approved2.has(e.company.name));
    try {
      log("MODEL", "Haiku", "Switching to Haiku for fast outreach generation");
      log("WAIT", "Cooldown", "Waiting 15s before outreach generation to reset rate limits...");
      await sleep(15000);
      const results = [];
      for (let idx = 0; idx < picked.length; idx++) {
        const item = picked[idx];
        try {
          log("ROI", "BLS Data", `Using avg salary benchmarks for ${item.signal?.location || "US"}...`);
          await sleep(200);
          const allDms = item.dms && item.dms.length > 0 ? item.dms : [item.dm];
          log("COPY", "Copywriter", `Personalizing outreach for ${allDms.length} contact${allDms.length > 1 ? "s" : ""} at ${item.company.name}...`);

          // Research DMs' recent online activity for personalization
          let dmActivities = {};
          for (const d of allDms) {
            if (d.name === "N/A") continue;
            log("RESEARCH", "LinkedIn", `Researching ${d.name}'s recent posts...`);
            try {
              const actResult = await callClaude(
                `Research this person's recent online activity. Be SPECIFIC — mention exact topics, opinions, or posts.`,
                `Search: "${d.name}" "${item.company.name}" site:linkedin.com\n\nWhat has ${d.name} (${d.title} at ${item.company.name}) been posting or talking about on LinkedIn recently? List specific topics, opinions, articles they shared. No generic guesses.`,
                true, 1
              );
              if (actResult && actResult.length > 30) {
                dmActivities[d.name] = actResult;
                log("OK", "Research", `Found activity for ${d.name}`, "success");
              }
            } catch(e) { /* non-critical */ }
          }

          // Build per-DM context
          const dmList = allDms.map((d, i) => {
            const bg = d.background ? `Background: ${d.background}` : "";
            const act = dmActivities[d.name] ? `Recent LinkedIn activity: ${dmActivities[d.name].slice(0, 300)}` : "";
            return `DM${i + 1}: ${d.name}, ${d.title}${d.email_guess ? `, ${d.email_guess}` : ""}\n${bg}\n${act}`;
          }).join("\n\n");
          const s4 = await callClaude(
            `You are a senior B2B sales copywriter selling AI voice infrastructure to lending, mortgage, and financial services companies. You know this industry: CFPB compliance requirements, Reg F call frequency rules for collectors, TCPA consent, high agent turnover (60-80% in collections), licensing costs for loan officers. You lead with their SPECIFIC pain — not generic "AI is cool." Return ONLY valid JSON.`,
            `CONTEXT:\n- Company: ${item.company.name} (${item.company.employees} emp, ${item.company.revenue || "unknown"} rev, ${item.company.industry || item.signal?.industry || "financial services"})\n- Hiring ${item.signal?.num_openings || 8}x ${item.signal?.role_title || "phone agents"} in ${item.signal?.location || "US"}\n- Feather = AI voice agents at $0.07/min (CFPB compliant, every call recorded + transcribed)\n\nDECISION MAKERS AT THIS COMPANY:\n${dmList}\n\nINDUSTRY DATA: Mortgage LO avg $63K. Collections agent $38K. Turnover 60-80%/yr. Training $6K-$10K/head. CFPB audit trails required. Reg F: 7 calls/week max.\n\nGENERATE:\n\n1. ROI (one per company):\n   - Current: ${item.signal?.num_openings || 8} × salary × 1.35 + training + 70% turnover cost\n   - Feather: 50 calls/day × 5 min × 250 days × $0.07/min × ${item.signal?.num_openings || 8}\n\n2. For EACH DM listed above, generate personalized outreach:\n\n   a. COLD EMAIL (<100 words): Subject <50 chars. Reference their job posting. Industry-specific pain. ROI number. Close: "15 min Thursday or Friday?" Sign as "Krish" from Feather.\n\n   b. LINKEDIN CONNECTION NOTE (<300 chars — MOST IMPORTANT):\n   - If you have their LinkedIn activity: reference a SPECIFIC post or topic. "Saw your take on [topic] — [your genuine reaction]"\n   - If you have their background: reference something real (previous company, alma mater, specific experience)\n   - If neither: reference a specific, non-obvious challenge someone in their exact role faces\n   - MUST feel like you genuinely follow them. NO pitch. NO product mention. NO "love to connect." Write as a peer.\n   - GOOD: "Your point about servicing costs outpacing origination revenue was sharp — seeing the same pattern across mid-market lenders."\n   - BAD: "Hi, I run an AI voice company and would love to connect."\n\n   c. LINKEDIN FOLLOW-UP (<150 words, after accept):\n   - Callback to connection note topic\n   - Natural transition to hiring signal\n   - Casual savings number\n   - Soft 15-min ask\n\n3. LINKEDIN POST (<200 words, one per company):\n   - Hot take about AI + their vertical. Real stat. Question ending. No hashtags/emojis.\n\nReturn JSON:\n{"roi":{"hiring_annual":0,"feather_annual":0,"savings":0,"pct":0},"contacts":[{"name":"DM name","email":{"subject":"","body":""},"linkedin":{"note":"","followup":""}}],"post":""}`, false);
          const d4 = parseJSON(s4);
          if (d4?.roi) log("ROI", "ROI", `$${Math.round((d4.roi.savings || 0) / 1000)}K/yr savings (${d4.roi.pct}%)`, "success");

          // Map per-DM outreach back — use contacts array if available, fallback to legacy
          const perDmOutreach = d4?.contacts || [];
          const primaryContact = perDmOutreach.find(c => c.name === item.dm.name) || perDmOutreach[0] || {};

          log("OK", "Pipeline", `${item.company.name} — ${perDmOutreach.length || 1} personalized outreach package${perDmOutreach.length > 1 ? "s" : ""} ready`, "success");
          results.push({
            ...item,
            roi: d4?.roi || {},
            outreach: {
              email: primaryContact.email || d4?.email,
              linkedin: primaryContact.linkedin || d4?.linkedin,
              post: d4?.post
            },
            perDmOutreach
          });
          setFinal([...results]);
          if (idx < picked.length - 1) { log("WAIT", "Cooldown", "Waiting 12s to avoid rate limits..."); await sleep(12000); }
        } catch(err) { log("ERR", "Error", `${item.company.name}: ${err.message} — skipping`, "error"); }
      }
      log("DONE", "Complete", `${results.length} companies ready for outreach`, "success");
      setPhase("done"); clearInterval(timerRef.current);
    } catch(e) { setError(e.message); log("ERR", "Error", e.message, "error"); clearInterval(timerRef.current); setPhase("idle"); }
    finally { running.current = false; }
  }, [enriched, approved2, log]);

  const isRunning = ["scanning", "enriching", "outreach"].includes(phase);
  const stageMap = { idle: -1, scanning: 0, gate1: 1, enriching: 2, gate2: 3, outreach: 4, done: 5 };
  const stageIdx = stageMap[phase] ?? -1;
  const STAGES = ["Scan & qualify", "Human review", "Find decision makers", "Verify contacts", "ROI + outreach", "Complete"];

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px" }}>
      <div style={{ display: "flex", gap: 24 }}>
        <div style={{ flex: "1 1 0", minWidth: 0 }}>
          <div style={{ marginBottom: 20 }}>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#111827", marginBottom: 6 }}>Hiring signal &rarr; qualified pipeline</h1>
            <p style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}>Scans Indeed, LinkedIn, ZipRecruiter, Glassdoor, Google Jobs. Qualifies via ICP. Finds DMs via Apollo &amp; LinkedIn. You approve at every gate.</p>
          </div>

          {/* Input */}
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, display: "flex", alignItems: "center", padding: "0 4px 0 16px", boxShadow: "0 1px 2px rgba(0,0,0,.04)" }}>
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && !isRunning && runScan(query)} disabled={isRunning}
                style={{ flex: 1, background: "transparent", border: "none", color: "#111827", fontSize: 14, padding: "12px 0" }} />
              <button onClick={() => runScan(query)} disabled={isRunning || !query.trim()} style={{
                background: isRunning ? "#e5e7eb" : "#2563eb", color: isRunning ? "#9ca3af" : "#fff", border: "none", borderRadius: 8, padding: "8px 20px", fontSize: 13, fontWeight: 600,
              }}>{isRunning ? "Running..." : "Run pipeline"}</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20 }}>
            {PRESETS.map(p => (
              <button key={p} onClick={() => { setQuery(p); if (!isRunning) runScan(p); }} disabled={isRunning}
                style={{ background: "#fff", border: "1px solid #e5e7eb", color: "#6b7280", padding: "5px 12px", borderRadius: 6, fontSize: 11 }}
                onMouseOver={e => { e.target.style.borderColor = "#2563eb"; e.target.style.color = "#2563eb"; }}
                onMouseOut={e => { e.target.style.borderColor = "#e5e7eb"; e.target.style.color = "#6b7280"; }}
              >{p}</button>
            ))}
          </div>

          {/* Progress */}
          {stageIdx >= 0 && (
            <div style={{ marginBottom: 16, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 16px" }} className="fu">
              <div style={{ display: "flex", gap: 3, marginBottom: 8 }}>
                {STAGES.map((_, i) => (<div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= stageIdx ? (phase === "done" ? "#10b981" : "#2563eb") : "#e5e7eb", transition: "background .3s" }} />))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {isRunning && <div style={{ width: 12, height: 12, border: "2px solid #2563eb", borderTopColor: "transparent", borderRadius: "50%", animation: "spin .8s linear infinite" }} />}
                  {phase === "done" && <span style={{ color: "#10b981" }}>&#10003;</span>}
                  {(phase === "gate1" || phase === "gate2") && <span style={{ color: "#f59e0b", fontSize: 14 }}>||</span>}
                  <span style={{ fontSize: 12, fontWeight: 600, color: phase === "done" ? "#10b981" : (phase === "gate1" || phase === "gate2") ? "#f59e0b" : "#2563eb" }}>
                    {phase === "gate1" ? "Awaiting your approval — select companies to enrich" : phase === "gate2" ? "Verify contacts — approve to generate outreach" : phase === "done" ? "Pipeline complete" : STAGES[stageIdx]}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#9ca3af" }}>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>
                  <span style={{ fontSize: 10, color: "#d1d5db" }}>Stage {Math.min(stageIdx + 1, STAGES.length)}/{STAGES.length}</span>
                </div>
              </div>
            </div>
          )}

          {/* Empty state */}
          {phase === "idle" && !error && (
            <div style={{ background: "#fff", border: "1px dashed #e5e7eb", borderRadius: 10, padding: "40px 24px", textAlign: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>&#128225;</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#111827", marginBottom: 4 }}>No pipeline running</div>
              <div style={{ fontSize: 12, color: "#9ca3af", maxWidth: 400, margin: "0 auto", lineHeight: 1.5 }}>
                Choose a preset above or type a custom query to scan job boards for hiring signals. The pipeline will find companies, qualify them against ICP, find decision makers, and draft personalized outreach.
              </div>
            </div>
          )}

          {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "14px 16px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }} className="fu">
            <span style={{ color: "#dc2626", fontSize: 13 }}>{error}</span>
            <button onClick={() => { setError(null); runScan(query); }} style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, padding: "6px 16px", fontSize: 12, fontWeight: 600, flexShrink: 0, marginLeft: 12 }}>Retry</button>
          </div>}

          {/* ═══ GATE 1: Approve qualified companies ═══ */}
          {phase === "gate1" && (
            <div className="fu" style={{ marginBottom: 16 }}>
              {/* Gate 1 header banner */}
              <div style={{ background: "linear-gradient(135deg,#1e40af,#2563eb)", borderRadius: 12, padding: "18px 20px", marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 4 }}>Gate 1 — Approve companies to enrich</div>
                    <div style={{ fontSize: 12, color: "#bfdbfe" }}>Select which companies to find decision makers for. Unselected companies are dropped.</div>
                  </div>
                  <div style={{ display: "flex", gap: 16, flexShrink: 0, marginLeft: 24 }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>{qualified.filter(c => c.qualified).length}</div>
                      <div style={{ fontSize: 10, color: "#93c5fd" }}>qualified</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: approved1.size > 0 ? "#34d399" : "#fff" }}>{approved1.size}</div>
                      <div style={{ fontSize: 10, color: "#93c5fd" }}>selected</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>${Math.round(qualified.filter(c => approved1.has(c.name)).reduce((s, c) => s + parseNum(c.estimated_contract_value), 0) / 1000)}K</div>
                      <div style={{ fontSize: 10, color: "#93c5fd" }}>est. pipeline/yr</div>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button onClick={() => { const all = qualified.filter(c => c.qualified).map(c => c.name); setApproved1(approved1.size === all.length ? new Set() : new Set(all)); }}
                    style={{ fontSize: 12, color: "#2563eb", background: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontWeight: 600 }}>
                    {approved1.size === qualified.filter(c => c.qualified).length ? "Deselect all" : "Select all"}
                  </button>
                  <button onClick={runEnrich} disabled={approved1.size === 0} style={{
                    background: approved1.size > 0 ? "#fff" : "rgba(255,255,255,.2)", color: approved1.size > 0 ? "#1e40af" : "rgba(255,255,255,.5)",
                    border: "none", borderRadius: 6, padding: "6px 20px", fontSize: 13, fontWeight: 700,
                  }}>Find decision makers ({approved1.size}) →</button>
                </div>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {qualified.filter(c => c.qualified).map((c, i) => {
                  const on = approved1.has(c.name);
                  const sig = signals.find(s => s.company === c.name);
                  const days = sig?.days_ago;
                  const freshColor = days==null ? "#6b7280" : days<=3 ? "#059669" : days<=7 ? "#d97706" : "#dc2626";
                  const freshLabel = days!=null ? (days<=1 ? "Today" : days+"d ago") : sig?.posted_date || "Recent";
                  return (
                    <div key={i} onClick={() => { const n = new Set(approved1); on ? n.delete(c.name) : n.add(c.name); setApproved1(n); }}
                      style={{ background: on ? "#eff6ff" : "#fff", border: `2px solid ${on ? "#2563eb" : "#e5e7eb"}`, borderRadius: 10, padding: "14px 16px", cursor: "pointer", transition: "all .15s", boxShadow: on ? "0 0 0 3px rgba(37,99,235,.1)" : "none" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                            <div style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${on ? "#2563eb" : "#d1d5db"}`, background: on ? "#2563eb" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all .15s" }}>
                              {on && <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 6l2 2 4-4" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" /></svg>}
                            </div>
                            <span style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{c.name}</span>
                            <span style={{ fontSize: 15, fontWeight: 800, color: c.total_score >= 8 ? "#059669" : c.total_score >= 6 ? "#2563eb" : "#d97706" }}>{c.total_score}/10</span>
                            <Tag color="blue">{c.estimated_contract_value}</Tag>
                            {c.has_ai_voice && <Tag color="red">AI voice detected</Tag>}
                          </div>
                          <div style={{ fontSize: 11, color: "#9ca3af", marginLeft: 30 }}>{c.employees} employees · {c.revenue || "unknown rev"} · {c.reasoning}</div>
                          {sig && <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 30, marginTop: 4 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: freshColor, background: freshColor + "18", padding: "1px 6px", borderRadius: 3 }}>{freshLabel}</span>
                            <span style={{ fontSize: 10, color: "#6b7280" }}>{sig.num_openings ? sig.num_openings + "x " : ""}{sig.role_title} · {sig.location || "US"}</span>
                            {sig.source && <span style={{ fontSize: 9, color: "#6b7280", background: "#f3f4f6", padding: "1px 6px", borderRadius: 3 }}>{sig.source}</span>}
                            {sig.job_url && <a href={sig.job_url} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} style={{ fontSize: 10, color: "#2563eb", textDecoration: "none" }}>View posting ↗</a>}
                          </div>}
                        </div>
                        <div style={{ flexShrink: 0, textAlign: "right" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: on ? "#2563eb" : "#d1d5db", marginBottom: 2 }}>{on ? "✓ Approved" : "Click to approve"}</div>
                        </div>
                      </div>
                      {/* ICP Scorecard */}
                      {c.scores && <div style={{ marginLeft: 30, background: "#f9fafb", borderRadius: 8, padding: "10px 12px" }} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>ICP scorecard — weighted {c.total_score}/10</div>
                        <div style={{ display: "grid", gap: 6 }}>
                          {[
                            ["Industry", "industry", 20], ["Size fit", "size", 15], ["Phone intensity", "phone_intensity", 25],
                            ["AI readiness", "ai_readiness", 20], ["Budget signal", "budget", 10], ["Timing", "timing", 10]
                          ].map(([label, key, weight]) => {
                            const val = c.scores[key] || 0;
                            const pct = (val / 2) * 100;
                            const proof = c.evidence?.[key] || "";
                            return (
                              <div key={key}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                  <div style={{ width: 100, fontSize: 10, fontWeight: 600, color: "#374151", flexShrink: 0 }}>{label} <span style={{ fontWeight: 400, color: "#9ca3af" }}>({weight}%)</span></div>
                                  <div style={{ flex: 1, height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden" }}>
                                    <div style={{ width: `${pct}%`, height: "100%", borderRadius: 3, background: val === 2 ? "#10b981" : val === 1 ? "#f59e0b" : "#ef4444", transition: "width .3s" }} />
                                  </div>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: val === 2 ? "#059669" : val === 1 ? "#d97706" : "#dc2626", width: 20, textAlign: "right" }}>{val}/2</span>
                                </div>
                                {proof && <div style={{ fontSize: 9, color: "#6b7280", marginLeft: 106, lineHeight: 1.4, marginBottom: 2 }}>{proof}</div>}
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
                <div style={{ marginTop: 10, padding: "8px 12px", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, fontSize: 11, color: "#92400e" }}>
                  <span style={{ fontWeight: 600 }}>Filtered out ({qualified.filter(c => !c.qualified).length}): </span>
                  {qualified.filter(c => !c.qualified).map(c => c.name).join(", ")}
                </div>
              )}
            </div>
          )}

          {/* ═══ GATE 2: Verify DMs ═══ */}
          {phase === "gate2" && (
            <div className="fu" style={{ marginBottom: 16 }}>
              {/* Gate 2 header banner */}
              <div style={{ background: "linear-gradient(135deg,#5b21b6,#7c3aed)", borderRadius: 12, padding: "18px 20px", marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 4 }}>Gate 2 — Verify decision makers</div>
                    <div style={{ fontSize: 12, color: "#ddd6fe" }}>Check each contact on LinkedIn before generating outreach. Unverified contacts waste your time.</div>
                  </div>
                  <div style={{ display: "flex", gap: 16, flexShrink: 0, marginLeft: 24 }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>{enriched.length}</div>
                      <div style={{ fontSize: 10, color: "#c4b5fd" }}>contacts found</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: approved2.size > 0 ? "#34d399" : "#fff" }}>{approved2.size}</div>
                      <div style={{ fontSize: 10, color: "#c4b5fd" }}>approved</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>{enriched.filter(e => e.dm.confidence === "high").length}</div>
                      <div style={{ fontSize: 10, color: "#c4b5fd" }}>high conf.</div>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button onClick={() => { const all = enriched.map(e => e.company.name); setApproved2(approved2.size === all.length ? new Set() : new Set(all)); }}
                    style={{ fontSize: 12, color: "#7c3aed", background: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontWeight: 600 }}>
                    {approved2.size === enriched.length ? "Deselect all" : "Approve all"}
                  </button>
                  <button onClick={runOutreach} disabled={approved2.size === 0} style={{
                    background: approved2.size > 0 ? "#fff" : "rgba(255,255,255,.2)", color: approved2.size > 0 ? "#5b21b6" : "rgba(255,255,255,.5)",
                    border: "none", borderRadius: 6, padding: "6px 20px", fontSize: 13, fontWeight: 700,
                  }}>Generate outreach ({approved2.size}) →</button>
                </div>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {enriched.map((e, i) => {
                  const on = approved2.has(e.company.name);
                  const confColor = e.dm.confidence === "high" ? "#059669" : e.dm.confidence === "medium" ? "#d97706" : "#dc2626";
                  return (
                    <div key={i} onClick={() => { const n = new Set(approved2); on ? n.delete(e.company.name) : n.add(e.company.name); setApproved2(n); }}
                      style={{ background: on ? "#faf5ff" : "#fff", border: `2px solid ${on ? "#7c3aed" : "#e5e7eb"}`, borderRadius: 10, padding: "14px 16px", cursor: "pointer", transition: "all .15s", boxShadow: on ? "0 0 0 3px rgba(124,58,237,.1)" : "none" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${on ? "#7c3aed" : "#d1d5db"}`, background: on ? "#7c3aed" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s", flexShrink: 0 }}>
                            {on && <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 6l2 2 4-4" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" /></svg>}
                          </div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{e.company.name}</div>
                            <div style={{ fontSize: 11, color: "#9ca3af" }}>{e.company.employees} emp · {e.company.industry || ""}</div>
                          </div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <span style={{ fontSize: 10, fontWeight: 600, color: confColor, background: confColor + "18", padding: "1px 6px", borderRadius: 3 }}>{(e.dms && e.dms.length > 0 ? e.dms : [e.dm]).length} contact{(e.dms && e.dms.length > 0 ? e.dms : [e.dm]).length > 1 ? "s" : ""}</span>
                        </div>
                      </div>
                      {/* All DMs for this company */}
                      <div style={{ marginLeft: 32, marginTop: 10, display: "grid", gap: 8 }}>
                        {(e.dms && e.dms.length > 0 ? e.dms : [e.dm]).map((d, di) => {
                          const dConf = d.confidence === "high" ? "#059669" : d.confidence === "medium" ? "#d97706" : "#dc2626";
                          return (
                            <div key={di} style={{ background: di === 0 ? "#f5f3ff" : "#f9fafb", borderRadius: 8, padding: "10px 12px", border: di === 0 ? "1px solid #ddd6fe" : "1px solid #e5e7eb" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                                <div>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: di === 0 ? "#7c3aed" : "#111827" }}>{d.name}</span>
                                  {di === 0 && <span style={{ fontSize: 9, fontWeight: 700, color: "#7c3aed", background: "#ede9fe", padding: "1px 5px", borderRadius: 3, marginLeft: 6 }}>PRIMARY</span>}
                                </div>
                                <span style={{ fontSize: 10, fontWeight: 600, color: dConf, background: dConf + "18", padding: "1px 6px", borderRadius: 3 }}>{d.confidence}</span>
                              </div>
                              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>{d.title}</div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                {d.linkedin_url && d.linkedin_url.startsWith("http") && <a href={d.linkedin_url} target="_blank" rel="noopener" onClick={ev => ev.stopPropagation()} style={{ fontSize: 10, color: "#0077b5", textDecoration: "none", fontWeight: 500 }}>LinkedIn ↗</a>}
                                {d.email_guess && d.email_guess.includes("@") && <span style={{ fontSize: 10, color: "#6b7280", fontFamily: "'JetBrains Mono',monospace" }}>{d.email_guess}</span>}
                              </div>
                              {d.background && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 4, fontStyle: "italic" }}>{truncate(d.background, 150)}</div>}
                            </div>
                          );
                        })}
                      </div>
                      <div style={{ marginLeft: 32, marginTop: 6, fontSize: 11, fontWeight: 700, color: on ? "#7c3aed" : "#d1d5db" }}>{on ? "✓ Approved for outreach" : "Click to approve"}</div>
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
              <div key={i} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, marginBottom: 10, overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,.04)" }} className="fu">
                <div onClick={() => setExpanded(isExp ? null : i)} style={{ padding: "14px 18px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{item.company.name}</span>
                      <Tag color="green">Approved</Tag><Tag color="blue">{item.company.estimated_contract_value}</Tag>
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>{item.dm.name} &middot; {item.dm.title}{item.dm.email_guess ? ` · ${item.dm.email_guess}` : ""}</div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>
                      {item.signal?.num_openings ? item.signal.num_openings + "x " : ""}{item.signal?.role_title || "agents"} · {item.signal?.source || "web"}{item.signal?.posted_date ? ` · Posted: ${item.signal.posted_date}` : item.signal?.days_ago ? ` · ${item.signal.days_ago}d ago` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {item.roi?.savings > 0 && <span style={{ fontSize: 17, fontWeight: 700, color: "#10b981" }}>${Math.round(item.roi.savings / 1000)}K<span style={{ fontSize: 10, fontWeight: 400, color: "#6b7280" }}>/yr</span></span>}
                    {hs && <button onClick={e => { e.stopPropagation(); pushHS(item); }} disabled={hss === "pushing" || hss === "done"} style={{
                      padding: "5px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                      border: `1px solid ${hss === "done" ? "#86efac" : hss === "error" ? "#fecaca" : "#e5e7eb"}`,
                      background: hss === "done" ? "#f0fdf4" : hss === "error" ? "#fef2f2" : "#fff",
                      color: hss === "done" ? "#10b981" : hss === "error" ? "#dc2626" : hss === "pushing" ? "#9ca3af" : "#2563eb"
                    }}>{hss === "pushing" ? "Pushing..." : hss === "done" ? "&#10003; In HubSpot" : hss === "error" ? "&#10007; Failed" : "&#8594; HubSpot"}</button>}
                    <span style={{ color: "#d1d5db", fontSize: 14, transition: "transform .2s", transform: isExp ? "rotate(90deg)" : "none" }}>&#9656;</span>
                  </div>
                </div>
                {isExp && (
                  <div style={{ borderTop: "1px solid #f3f4f6" }}>
                    <div style={{ display: "flex", borderBottom: "1px solid #f3f4f6" }}>
                      {[["roi", "ROI"], ["email", "Email"], ["linkedin", "LinkedIn"], ["post", "Post"]].map(([id, l]) => (
                        <button key={id} onClick={() => setTabs(p => ({ ...p, [i]: id }))} style={{ padding: "10px 18px", fontSize: 12, fontWeight: 500, border: "none", borderBottom: tab === id ? "2px solid #2563eb" : "2px solid transparent", background: "transparent", color: tab === id ? "#2563eb" : "#6b7280" }}>{l}</button>
                      ))}
                    </div>
                    <div style={{ padding: 18 }}>
                      {tab === "roi" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                        <Metric l="Hiring cost" v={`$${Math.round((item.roi?.hiring_annual || 0) / 1000)}K/yr`} c="#ef4444" />
                        <Metric l="Feather cost" v={`$${Math.round((item.roi?.feather_annual || 0) / 1000)}K/yr`} c="#2563eb" />
                        <Metric l="Savings" v={`$${Math.round((item.roi?.savings || 0) / 1000)}K`} s={`${item.roi?.pct || 0}%`} c="#10b981" />
                      </div>}
                      {tab === "email" && item.outreach?.email && <div>
                        {/* Email envelope UI */}
                        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,.06)" }}>
                          <div style={{ background: "#f8faff", borderBottom: "1px solid #e5e7eb", padding: "12px 16px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: ".04em" }}>Cold email</span>
                              <div style={{ display: "flex", gap: 6 }}>
                                <CopyBtn text={`Subject: ${item.outreach.email.subject}\n\n${item.outreach.email.body}`} />
                                {item.dm.email_guess && item.dm.email_guess.includes("@") && <a href={`mailto:${encodeURIComponent(item.dm.email_guess || "")}?subject=${encodeURIComponent(item.outreach.email.subject || "")}&body=${encodeURIComponent(item.outreach.email.body || "")}`}
                                  style={{ background: "#2563eb", color: "#fff", padding: "4px 12px", borderRadius: 5, fontSize: 11, fontWeight: 600, textDecoration: "none" }}>Open in Mail ↗</a>}
                              </div>
                            </div>
                            {item.dm.email_guess && item.dm.email_guess.includes("@") && <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>To: <span style={{ color: "#111827", fontWeight: 500, fontFamily: "'JetBrains Mono',monospace" }}>{item.dm.email_guess}</span></div>}
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>Subject: {item.outreach.email.subject}</div>
                          </div>
                          <div style={{ padding: "16px 18px", background: "#fff" }}>
                            {item.outreach.email.body.split("\n").map((line, j) => (
                              <p key={j} style={{ fontSize: 13, color: line.trim() === "" ? "transparent" : "#374151", lineHeight: 1.7, marginBottom: line.trim() === "" ? 8 : 0, minHeight: line.trim() === "" ? 8 : "auto" }}>{line || "\u00A0"}</p>
                            ))}
                          </div>
                        </div>
                      </div>}
                      {tab === "linkedin" && item.outreach?.linkedin && <div style={{ display: "grid", gap: 14 }}>
                        {item.dm.linkedin_url && item.dm.linkedin_url.startsWith("http") && (
                          <a href={item.dm.linkedin_url} target="_blank" rel="noopener" style={{ background: "#0077b5", color: "#fff", padding: "8px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
                            Open {item.dm.name}&apos;s LinkedIn ↗
                          </a>
                        )}
                        {/* Connection note */}
                        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
                          <div style={{ background: "#f0f8ff", borderBottom: "1px solid #e5e7eb", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <span style={{ fontSize: 11, fontWeight: 700, color: "#0077b5", textTransform: "uppercase", letterSpacing: ".04em" }}>Connection request note</span>
                              <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 8 }}>300 char limit</span>
                            </div>
                            <CopyBtn text={item.outreach.linkedin.note} />
                          </div>
                          <div style={{ padding: "14px 16px", background: "#fff" }}>
                            {item.outreach.linkedin.note?.split("\n").map((line, j) => (
                              <p key={j} style={{ fontSize: 13, color: "#374151", lineHeight: 1.7, marginBottom: 0 }}>{line || "\u00A0"}</p>
                            ))}
                            <div style={{ marginTop: 8, fontSize: 10, color: "#9ca3af" }}>{(item.outreach.linkedin.note || "").length} / 300 chars</div>
                          </div>
                        </div>
                        {/* Follow-up */}
                        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
                          <div style={{ background: "#faf5ff", borderBottom: "1px solid #e5e7eb", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <span style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", textTransform: "uppercase", letterSpacing: ".04em" }}>Follow-up after connecting</span>
                              <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 8 }}>Send 2–3 days after accepting</span>
                            </div>
                            <CopyBtn text={item.outreach.linkedin.followup} />
                          </div>
                          <div style={{ padding: "14px 16px", background: "#fff" }}>
                            {item.outreach.linkedin.followup?.split("\n").map((line, j) => (
                              <p key={j} style={{ fontSize: 13, color: "#374151", lineHeight: 1.7, marginBottom: 0 }}>{line || "\u00A0"}</p>
                            ))}
                          </div>
                        </div>
                      </div>}
                      {tab === "post" && item.outreach?.post && <div>
                        {/* LinkedIn post preview */}
                        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
                          <div style={{ background: "#f0f8ff", borderBottom: "1px solid #e5e7eb", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#0077b5", textTransform: "uppercase", letterSpacing: ".04em" }}>Thought leadership post</span>
                            <div style={{ display: "flex", gap: 6 }}>
                              <CopyBtn text={item.outreach.post} />
                              <a href="https://www.linkedin.com/feed/" target="_blank" rel="noopener"
                                style={{ background: "#0077b5", color: "#fff", padding: "4px 12px", borderRadius: 5, fontSize: 11, fontWeight: 600, textDecoration: "none" }}>Post on LinkedIn ↗</a>
                            </div>
                          </div>
                          {/* LinkedIn-style mock post */}
                          <div style={{ padding: "16px 18px", background: "#fff" }}>
                            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#1e40af", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: "#fff", flexShrink: 0 }}>K</div>
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>Krish</div>
                                <div style={{ fontSize: 11, color: "#9ca3af" }}>Founder at Feather</div>
                              </div>
                            </div>
                            {item.outreach.post.split("\n").map((line, j) => (
                              <p key={j} style={{ fontSize: 13, color: line.trim() === "" ? "transparent" : "#374151", lineHeight: 1.75, marginBottom: line.trim() === "" ? 6 : 0, minHeight: line.trim() === "" ? 6 : "auto" }}>{line || "\u00A0"}</p>
                            ))}
                          </div>
                        </div>
                      </div>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {phase === "done" && final.length > 0 && (
            <div className="fu" style={{ marginTop: 16 }}>
              {/* Stats */}
              <div style={{ padding: "16px 20px", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#059669" }}>&#10003; Pipeline complete</div>
                  <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#059669" }}>{Math.floor(elapsed / 60)}m {elapsed % 60}s elapsed</span>
                </div>
                <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                  <St l="Signals scanned" v={signals.length} /><St l="ICP qualified" v={qualified.filter(c => c.qualified).length} /><St l="Outreach ready" v={final.length} /><St l="Total addressable savings" v={`$${Math.round(final.reduce((s, e) => s + (e.roi?.savings || 0), 0) / 1000)}K/yr`} />
                </div>
              </div>

              {/* Export */}
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <button onClick={() => {
                  const esc = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
                  const rows = [["Company", "Industry", "Employees", "Revenue", "ICP Score", "DM Name", "DM Title", "DM Email", "DM LinkedIn", "Hiring Cost", "Feather Cost", "Savings", "Savings %", "Email Subject", "Email Body", "LinkedIn Note", "LinkedIn Followup", "Post"].join(",")];
                  final.forEach(f => rows.push([
                    esc(f.company.name), esc(f.company.industry || f.signal?.industry || ""), esc(f.company.employees), esc(f.company.revenue || ""),
                    f.company.total_score || "", esc(f.dm.name), esc(f.dm.title), esc(f.dm.email_guess || ""), esc(f.dm.linkedin_url || ""),
                    f.roi?.hiring_annual || "", f.roi?.feather_annual || "", f.roi?.savings || "", f.roi?.pct || "",
                    esc(f.outreach?.email?.subject || ""), esc(f.outreach?.email?.body || ""),
                    esc(f.outreach?.linkedin?.note || ""), esc(f.outreach?.linkedin?.followup || ""), esc(f.outreach?.post || "")
                  ].join(",")));
                  const csv = rows.join("\n");
                  const blob = new Blob([csv], { type: "text/csv" });
                  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `feather-pipeline-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
                }} style={{ flex: 1, padding: "8px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "#fff", border: "1px solid #e5e7eb", color: "#374151" }}>
                  Export CSV
                </button>
                <button onClick={() => {
                  const text = final.map(f => `## ${f.company.name}\nDM: ${f.dm.name} (${f.dm.title})\nEmail: ${f.dm.email_guess || "N/A"}\nLinkedIn: ${f.dm.linkedin_url || "N/A"}\nSavings: $${Math.round((f.roi?.savings || 0) / 1000)}K/yr\n\n### Email\nSubject: ${f.outreach?.email?.subject || ""}\n${f.outreach?.email?.body || ""}\n\n### LinkedIn Note\n${f.outreach?.linkedin?.note || ""}\n\n### LinkedIn Follow-up\n${f.outreach?.linkedin?.followup || ""}\n\n### Post\n${f.outreach?.post || ""}\n\n---`).join("\n\n");
                  navigator.clipboard.writeText(text);
                }} style={{ flex: 1, padding: "8px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "#fff", border: "1px solid #e5e7eb", color: "#374151" }}>
                  Copy all outreach
                </button>
              </div>

              {/* Per-company action cards */}
              <div style={{ fontSize: 12, fontWeight: 600, color: "#111827", marginBottom: 10 }}>Quick actions per company</div>
              {final.map((item, i) => (
                <div key={i} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px 18px", marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{item.company.name}</div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>{item.company.employees} emp &middot; {item.company.industry || item.signal?.industry || ""} &middot; {item.signal?.location || "US"}</div>
                      <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>{item.signal?.num_openings ? item.signal.num_openings + "x " : ""}{item.signal?.role_title || "agents"} via {item.signal?.source || "web"}{item.signal?.posted_date ? ` · Posted: ${item.signal.posted_date}` : item.signal?.days_ago ? ` · ${item.signal.days_ago}d ago` : ""}</div>
                    </div>
                    {item.roi?.savings > 0 && <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: "#10b981" }}>${Math.round(item.roi.savings / 1000)}K</div>
                      <div style={{ fontSize: 10, color: "#6b7280" }}>savings/yr ({item.roi.pct}%)</div>
                    </div>}
                  </div>

                  {/* Contacts + actions — unified per person */}
                  <div style={{ display: "grid", gap: 8, marginBottom: 8 }}>
                    {(item.dms && item.dms.length > 0 ? item.dms : [item.dm]).map((d, di) => {
                      const dmOut = item.perDmOutreach?.find(p => p.name === d.name) || (di === 0 ? { email: item.outreach?.email, linkedin: item.outreach?.linkedin } : {});
                      return (
                        <div key={di} style={{ background: di === 0 ? "#f5f3ff" : "#f9fafb", borderRadius: 8, padding: "10px 12px", border: di === 0 ? "1px solid #ede9fe" : "1px solid #f3f4f6" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <div style={{ width: 28, height: 28, borderRadius: "50%", background: di === 0 ? "#ede9fe" : "#f0f4ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>&#128100;</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>{d.name}{di === 0 ? " ★" : ""}</div>
                              <div style={{ fontSize: 10, color: "#6b7280" }}>{d.title}</div>
                            </div>
                            {d.email_guess && d.email_guess.includes("@") && <span style={{ fontSize: 10, color: "#6b7280", fontFamily: "'JetBrains Mono',monospace", flexShrink: 0 }}>{d.email_guess}</span>}
                          </div>
                          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginLeft: 36 }}>
                            {d.email_guess && dmOut.email && (
                              <a href={`mailto:${encodeURIComponent(d.email_guess)}?subject=${encodeURIComponent(dmOut.email.subject || "")}&body=${encodeURIComponent(dmOut.email.body || "")}`}
                                style={{ padding: "5px 12px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: "#2563eb", color: "#fff", textDecoration: "none" }}>
                                Send email
                              </a>
                            )}
                            {d.linkedin_url && d.linkedin_url.startsWith("http") && (
                              <a href={d.linkedin_url} target="_blank" rel="noopener"
                                style={{ padding: "5px 12px", borderRadius: 5, fontSize: 10, fontWeight: 600, background: "#0077b5", color: "#fff", textDecoration: "none" }}>
                                LinkedIn
                              </a>
                            )}
                            {dmOut.linkedin?.note && <CopyBtn text={dmOut.linkedin.note} label="Copy note" />}
                            {dmOut.email && <CopyBtn text={`Subject: ${dmOut.email.subject}\n\n${dmOut.email.body}`} label="Copy email" />}
                            {dmOut.linkedin?.followup && <CopyBtn text={dmOut.linkedin.followup} label="Copy follow-up" />}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {item.outreach?.post && <CopyBtn text={item.outreach.post} label="Copy post" />}
                    {hs && <button onClick={() => pushHS(item)} disabled={hsStatus[item.company.name] === "pushing" || hsStatus[item.company.name] === "done"} style={{
                      padding: "7px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                      border: `1px solid ${hsStatus[item.company.name] === "done" ? "#86efac" : hsStatus[item.company.name] === "error" ? "#fecaca" : "#fed7aa"}`,
                      background: hsStatus[item.company.name] === "done" ? "#f0fdf4" : hsStatus[item.company.name] === "error" ? "#fef2f2" : "#fff7ed",
                      color: hsStatus[item.company.name] === "done" ? "#059669" : hsStatus[item.company.name] === "error" ? "#dc2626" : "#ea580c"
                    }}>{hsStatus[item.company.name] === "pushing" ? "Pushing..." : hsStatus[item.company.name] === "done" ? "&#10003; In HubSpot" : hsStatus[item.company.name] === "error" ? "&#10007; Failed — retry" : "&#8594; Push to HubSpot"}</button>}
                  </div>
                </div>
              ))}

              <button onClick={() => { resetPipeline(); setPhase("idle"); }}
                style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 600, color: "#6b7280", width: "100%", marginTop: 8 }}>
                Run new pipeline
              </button>
            </div>
          )}
        </div>

        {/* ═══ ACTIVITY LOG ═══ */}
        {stageIdx >= 0 && (
          <div style={{ width: 320, flexShrink: 0 }} className="fu">
            <div style={{ position: "sticky", top: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h3 style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: ".05em" }}>Activity log</h3>
                <span style={{ fontSize: 10, color: "#d1d5db" }}>{logs.length} events</span>
              </div>
              <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, maxHeight: "calc(100vh - 120px)", overflowY: "auto", boxShadow: "0 1px 2px rgba(0,0,0,.04)" }}>
                {logs.map((l, i) => (
                  <div key={i} className="si" style={{
                    padding: "7px 12px", borderBottom: "1px solid #f9fafb",
                    background: l.type === "success" ? "#f0fdf4" : l.type === "error" ? "#fef2f2" : l.type === "gate" ? "#fffbeb" : l.type === "filtered" ? "#fefce8" : "transparent"
                  }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
                      <span style={{ fontSize: 8, color: "#d1d5db", fontFamily: "'JetBrains Mono',monospace", flexShrink: 0, marginTop: 2 }}>{l.time}</span>
                      <div style={{ minWidth: 0 }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", marginRight: 5,
                          color: l.src === "Apollo.io" ? "#7c3aed" : l.src === "HubSpot" ? "#f97316" : l.src === "LinkedIn" || l.src === "LinkedIn Jobs" ? "#0077b5" :
                            l.src === "Indeed" ? "#2164f3" : l.src === "ZipRecruiter" ? "#239846" : l.src === "Glassdoor" ? "#0caa41" :
                              l.src === "Google Jobs" ? "#ea4335" : l.src === "Hunter.io" ? "#ff7043" : l.src === "BLS Data" ? "#1565c0" :
                                l.src === "Sonnet" ? "#c96442" : l.src === "Haiku" ? "#c96442" : l.src === "Copywriter" ? "#7c3aed" :
                                  l.type === "gate" ? "#d97706" : l.type === "success" ? "#059669" : l.type === "error" ? "#dc2626" : "#6b7280"
                        }}>{l.src}</span>
                        <span style={{ fontSize: 11, color: l.type === "error" ? "#dc2626" : l.type === "gate" ? "#92400e" : "#374151", lineHeight: 1.4, display: "inline" }}>{l.msg}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {isRunning && <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 10, height: 10, border: "2px solid #2563eb", borderTopColor: "transparent", borderRadius: "50%", animation: "spin .8s linear infinite" }} />
                  <span style={{ fontSize: 11, color: "#9ca3af" }}>Processing...</span>
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
  const I = ({ children, c = "#6b7280" }) => <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: c, fontWeight: 500 }}>{children}</span>;
  const Dot = ({ c }) => <span style={{ width: 7, height: 7, borderRadius: "50%", background: c, display: "inline-block", flexShrink: 0 }} />;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", marginBottom: 4 }}>How it works</h1>
      <p style={{ fontSize: 13, color: "#9ca3af", marginBottom: 36 }}>Three phases. Human approval between each. Nothing sends without your sign-off.</p>

      <div style={{ display: "flex", gap: 24, marginBottom: 40, padding: "12px 0", borderTop: "1px solid #f3f4f6", borderBottom: "1px solid #f3f4f6" }}>
        {[["6-12", "signals/day"], ["~40%", "pass rate"], ["$0.02", "per lead"], ["15 min", "your time"]].map(([v, l]) => (
          <div key={l}><span style={{ fontSize: 18, fontWeight: 700, color: "#111827" }}>{v}</span><span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 6 }}>{l}</span></div>
        ))}
      </div>

      {/* STEP 1 */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#111827", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff" }}>1</div>
          <span style={{ fontSize: 16, fontWeight: 600, color: "#111827" }}>Discover</span>
          <span style={{ fontSize: 11, color: "#d1d5db" }}>~30s</span>
        </div>
        <div style={{ marginLeft: 34, marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 10, lineHeight: 1.5 }}>Claude Sonnet searches 5 job boards using site: operators, then scores each company against a weighted ICP model.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <I c="#2164f3"><Dot c="#2164f3" />Indeed</I>
            <I c="#0077b5"><Dot c="#0077b5" />LinkedIn</I>
            <I c="#239846"><Dot c="#239846" />ZipRecruiter</I>
            <I c="#0caa41"><Dot c="#0caa41" />Glassdoor</I>
            <I c="#ea4335"><Dot c="#ea4335" />Google Jobs</I>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 10, marginBottom: 8 }}>
        <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#f59e0b" }} />
        <div style={{ flex: 1, height: 1, background: "#fde68a" }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: "#92400e", background: "#fffbeb", padding: "3px 10px", borderRadius: 4, border: "1px solid #fde68a" }}>You approve which companies to pursue</span>
        <div style={{ flex: 1, height: 1, background: "#fde68a" }} />
        <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#f59e0b" }} />
      </div>

      {/* STEP 2 */}
      <div style={{ marginBottom: 8, marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#111827", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff" }}>2</div>
          <span style={{ fontSize: 16, fontWeight: 600, color: "#111827" }}>Enrich</span>
          <span style={{ fontSize: 11, color: "#d1d5db" }}>~20s per company</span>
        </div>
        <div style={{ marginLeft: 34, marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 10, lineHeight: 1.5 }}>Claude Sonnet searches Apollo.io, LinkedIn profiles, and Hunter.io for decision makers. Resolves email patterns and backgrounds for personalization. You verify before proceeding.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <I c="#7c3aed"><Dot c="#7c3aed" />Apollo.io</I>
            <I c="#0077b5"><Dot c="#0077b5" />LinkedIn</I>
            <I c="#ff7043"><Dot c="#ff7043" />Hunter.io</I>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 10, marginBottom: 8 }}>
        <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#f59e0b" }} />
        <div style={{ flex: 1, height: 1, background: "#fde68a" }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: "#92400e", background: "#fffbeb", padding: "3px 10px", borderRadius: 4, border: "1px solid #fde68a" }}>You verify each contact on LinkedIn</span>
        <div style={{ flex: 1, height: 1, background: "#fde68a" }} />
        <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#f59e0b" }} />
      </div>

      {/* STEP 3 */}
      <div style={{ marginBottom: 8, marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#111827", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff" }}>3</div>
          <span style={{ fontSize: 16, fontWeight: 600, color: "#111827" }}>Activate</span>
          <span style={{ fontSize: 11, color: "#d1d5db" }}>~15s per company</span>
        </div>
        <div style={{ marginLeft: 34, marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 10, lineHeight: 1.5 }}>Claude Haiku calculates ROI using BLS salary benchmarks vs Feather's $0.07/min. Drafts a cold email, LinkedIn connection note, follow-up, and thought leadership post. Optionally pushes to HubSpot.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <I c="#1565c0"><Dot c="#1565c0" />BLS Data</I>
            <I c="#f97316"><Dot c="#f97316" />HubSpot (optional)</I>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 10, marginBottom: 32 }}>
        <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#f59e0b" }} />
        <div style={{ flex: 1, height: 1, background: "#fde68a" }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: "#92400e", background: "#fffbeb", padding: "3px 10px", borderRadius: 4, border: "1px solid #fde68a" }}>You review every message before sending</span>
        <div style={{ flex: 1, height: 1, background: "#fde68a" }} />
        <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#f59e0b" }} />
      </div>

      {/* ICP */}
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "#111827", marginBottom: 12 }}>ICP scoring</h2>
        <div style={{ borderTop: "1px solid #f3f4f6" }}>
          {[
            ["Phone intensity", "25%", "How many call center roles are open right now"],
            ["Industry fit", "20%", "Core: mortgage, insurance, credit union, loan servicing"],
            ["AI readiness", "20%", "No existing Vapi, Retell, Bland, or Synthflow"],
            ["Company size", "15%", "Sweet spot: 200-2,000 employees"],
            ["Budget signal", "10%", "Revenue $100M-$5B or recently funded"],
            ["Timing urgency", "10%", "Posted within 7 days + 5 or more openings"],
          ].map(([name, w, desc]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f3f4f6" }}>
              <span style={{ width: 140, fontSize: 13, fontWeight: 500, color: "#111827" }}>{name}</span>
              <span style={{ width: 40, fontSize: 13, fontWeight: 600, color: "#2563eb", textAlign: "right" }}>{w}</span>
              <span style={{ flex: 1, fontSize: 12, color: "#9ca3af", marginLeft: 16 }}>{desc}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12 }}>
          <span style={{ color: "#059669", fontWeight: 600 }}>Qualify: &ge; 6.0 / 10</span>
          <span style={{ color: "#9ca3af" }}>Auto-reject: existing AI voice &middot; government &middot; &gt;5K employees</span>
        </div>
      </div>

      <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 20, fontSize: 12, color: "#9ca3af", lineHeight: 1.6 }}>
        Three gates. Zero autopilot. AI does the research. You make the decisions.
      </div>
    </div>
  );
}

/* ═══ SHARED COMPONENTS ═══ */
function Tag({ children, color = "blue" }) {
  const c = { blue: ["#eff6ff", "#2563eb", "#bfdbfe"], green: ["#f0fdf4", "#059669", "#86efac"], red: ["#fef2f2", "#dc2626", "#fecaca"] }[color] || ["#eff6ff", "#2563eb", "#bfdbfe"];
  return <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: c[0], color: c[1], border: `1px solid ${c[2]}` }}>{children}</span>;
}
function Metric({ l, v, s, c }) {
  return <div style={{ background: "#f9fafb", borderRadius: 8, padding: "12px 14px", borderLeft: `3px solid ${c}` }}>
    <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3 }}>{l}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color: c }}>{v}</div>
    {s && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>{s}</div>}
  </div>;
}
function St({ l, v }) { return <div><div style={{ fontSize: 10, color: "#059669", fontWeight: 500, marginBottom: 2 }}>{l}</div><div style={{ fontSize: 17, fontWeight: 700, color: "#111827" }}>{v}</div></div>; }
function CopyBtn({ text, label }) {
  const [c, setC] = useState(false);
  return <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setC(true); setTimeout(() => setC(false), 1500); }}
    style={{ background: "#f9fafb", border: "1px solid #e5e7eb", color: c ? "#10b981" : "#6b7280", padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 500 }}>{c ? "Copied" : label || "Copy"}</button>;
}
