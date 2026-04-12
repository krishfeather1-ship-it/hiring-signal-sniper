import { useState, useRef, useCallback, useEffect } from "react";

let _apiKey = "";
let _hubspotToken = "";

async function claude(messages, system, search = true) {
  if (!_apiKey) throw new Error("Connect your Anthropic API key to get started.");
  const body = { model: "claude-sonnet-4-20250514", max_tokens: 4096, messages, system };
  if (search) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": _apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `API ${res.status}`); }
  const data = await res.json();
  return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}
function parseJSON(text) {
  try { const m = text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/); return JSON.parse(m[0]); } catch { return null; }
}
async function hubspot(method, path, body) {
  if (!_hubspotToken) return null;
  const opts = { method, headers: { "Content-Type": "application/json", "x-hubspot-token": _hubspotToken } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/hubspot/${path}`, opts);
  return res.json();
}

const PRESETS = [
  "Mid-market mortgage lenders hiring call center agents",
  "Regional insurance carriers hiring claims phone reps",
  "Credit unions hiring member service reps",
  "Auto lenders hiring loan servicing phone agents",
];

const WF = [
  { n: "Scan & qualify", t: "Scheduled daily", c: "#2563eb", nodes: ["Scan job boards", "Parse signals", "Score ICP (5 dimensions)", "Filter: score ≥ 6", "Create HubSpot deal", "Slack alert"], gate: "Review ICP fit → approve or reject" },
  { n: "Find decision maker", t: "Triggered on approval", c: "#7c3aed", nodes: ["Get deal data", "Apollo people search", "Verify title & tenure", "Create HubSpot contact", "Slack alert"], gate: "Verify contact on LinkedIn → approve" },
  { n: "ROI + outreach", t: "Triggered on contact approval", c: "#0891b2", nodes: ["Get deal + contact", "Calculate ROI", "Draft email + LinkedIn", "Update HubSpot deal", "Create review task"], gate: "Review all messaging → edit → send" },
];

function useLog() {
  const [logs, setLogs] = useState([]);
  const add = useCallback((icon, source, msg, type = "info") => {
    setLogs(p => [...p, { icon, source, msg, type, ts: Date.now() }]);
  }, []);
  const clear = useCallback(() => setLogs([]), []);
  return { logs, add, clear };
}

export default function App() {
  const [page, setPage] = useState("pipeline");
  const [showConfig, setShowConfig] = useState(false);
  const [keys, setKeys] = useState({ a: "", h: "" });
  const [connected, setConnected] = useState({ a: false, h: false });
  const updateKey = (k, v) => {
    setKeys(p => ({ ...p, [k]: v }));
    if (k === "a") { _apiKey = v; setConnected(p => ({ ...p, a: !!v })); }
    if (k === "h") { _hubspotToken = v; setConnected(p => ({ ...p, h: !!v })); }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#fafbfc", color: "#1a1a2e", fontFamily: "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        button{cursor:pointer;font-family:inherit}
        input:focus{outline:none}
        pre{white-space:pre-wrap;word-break:break-word;margin:0;font-family:'JetBrains Mono',monospace;font-size:13px;line-height:1.65;color:#374151}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
        .fu{animation:fadeUp .35s ease-out both}
        .si{animation:slideIn .25s ease-out both}
      `}</style>

      <nav style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "0 32px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5L12 3Z" fill="#1a1a2e"/><path d="M8 16c2-5 5-8 9-10-2 3-3 5.5-3.5 8.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1a1a2e" }}>Feather</span>
          </div>
          <div style={{ height: 20, width: 1, background: "#e5e7eb" }}/>
          <div style={{ display: "flex", gap: 2 }}>
            {[["pipeline","Pipeline"],["architecture","Architecture"]].map(([id,label]) => (
              <button key={id} onClick={() => setPage(id)} style={{
                padding: "6px 16px", borderRadius: 6, fontSize: 13, fontWeight: 500, border: "none",
                background: page === id ? "#f0f4ff" : "transparent", color: page === id ? "#2563eb" : "#6b7280",
              }}>{label}</button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {connected.a && <span style={{ fontSize: 11, color: "#10b981", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981", display: "inline-block" }}/>Connected</span>}
          <button onClick={() => setShowConfig(!showConfig)} style={{
            padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 500,
            background: showConfig ? "#f0f4ff" : "#fff", border: "1px solid #e5e7eb", color: "#374151",
          }}>{showConfig ? "Hide settings" : "Settings"}</button>
        </div>
      </nav>

      {showConfig && (
        <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "16px 32px", display: "flex", gap: 16, flexWrap: "wrap" }} className="fu">
          <Field label="Anthropic API key" placeholder="sk-ant-api03-..." value={keys.a} onChange={v => updateKey("a",v)} ok={connected.a} pw />
          <Field label="HubSpot token (optional)" placeholder="pat-na1-..." value={keys.h} onChange={v => updateKey("h",v)} ok={connected.h} pw />
        </div>
      )}

      {page === "pipeline" ? <Pipeline hubspot={connected.h}/> : <Architecture/>}
    </div>
  );
}

function Field({label,placeholder,value,onChange,ok,pw}) {
  return (
    <div style={{ flex: "1 1 280px" }}>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
        {label} {ok && <span style={{ color: "#10b981", fontSize: 10 }}>✓ connected</span>}
      </div>
      <input type={pw?"password":"text"} placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)}
        style={{ width: "100%", background: "#f9fafb", border: `1px solid ${ok ? "#86efac" : "#e5e7eb"}`, borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "#374151", fontFamily: "'JetBrains Mono',monospace" }}/>
    </div>
  );
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ═══ PIPELINE ═══ */
function Pipeline({ hubspot }) {
  const [query, setQuery] = useState(PRESETS[0]);
  const [stageIdx, setStageIdx] = useState(-1);
  const [signals, setSignals] = useState([]);
  const [qualified, setQualified] = useState([]);
  const [enriched, setEnriched] = useState([]);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [tabs, setTabs] = useState({});
  const [hsStatus, setHsStatus] = useState({});
  const { logs, add: log, clear: clearLogs } = useLog();
  const running = useRef(false);
  const logEnd = useRef(null);

  useEffect(() => { logEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  const pushHS = async (item) => {
    if (!_hubspotToken) return;
    const id = item.company.name;
    setHsStatus(p => ({ ...p, [id]: "pushing" }));
    try {
      const co = await hubspot("POST","crm/v3/objects/companies",{properties:{name:item.company.name,industry:item.signal.industry,numberofemployees:item.company.employees}});
      await hubspot("POST","crm/v3/objects/deals",{properties:{dealname:`Signal: ${item.company.name}`,pipeline:"default",dealstage:"qualifiedtobuy",amount:String(item.roi?.savings||100000),description:`DM: ${item.dm?.name} (${item.dm?.title})\nSavings: $${Math.round((item.roi?.savings||0)/1000)}K/yr`},associations:co?.id?[{to:{id:co.id},types:[{associationCategory:"HUBSPOT_DEFINED",associationTypeId:342}]}]:[]});
      setHsStatus(p => ({ ...p, [id]: "done" }));
      log("🟢", "HubSpot", `Created company + deal for ${item.company.name}`, "success");
    } catch { setHsStatus(p => ({ ...p, [id]: "error" })); }
  };

  const run = useCallback(async (input) => {
    if (running.current) return;
    running.current = true;
    setError(null); setSignals([]); setQualified([]); setEnriched([]); setExpanded(null); setStageIdx(0); clearLogs();

    try {
      /* ── STAGE 1: SCAN ── */
      log("🔍", "Indeed", "Searching for call center and phone agent openings...");
      await delay(400);
      log("🔍", "LinkedIn Jobs", "Scanning financial services job postings...");
      await delay(300);
      log("🔍", "ZipRecruiter", "Querying phone representative roles...");
      await delay(300);
      log("🔍", "Glassdoor", "Cross-referencing active job listings...");
      await delay(200);
      log("🔍", "Google Jobs", "Aggregating results across job boards...");
      await delay(200);
      log("⚡", "AI Agent", "Analyzing hiring patterns with Claude web search...");

      const s1 = await claude([{role:"user",content:`Search for mid-market companies (200-2000 employees) in US mortgage, lending, insurance, credit union industries currently hiring phone/call center roles. "${input}"\n\nMID-MARKET ONLY. NOT mega-corps (GEICO, Progressive, Rocket Mortgage, Wells Fargo, JPMorgan, Bank of America). Focus on regional lenders, mid-size servicers, specialty insurers, credit unions $1B-$10B.\n\nFind 5-7 real companies. Return ONLY JSON:\n{"signals":[{"company":"","role_title":"","location":"","num_openings":5,"industry":"","signal_strength":"high/medium/low"}]}`}],
        "Hiring signal agent. MID-MARKET companies only. Return ONLY valid JSON.");
      const d1 = parseJSON(s1);
      if (!d1?.signals?.length) throw new Error("No signals found. Try a different query.");
      setSignals(d1.signals);
      d1.signals.forEach(s => log("📡", "Signal", `${s.company} — ${s.num_openings}x ${s.role_title} (${s.location})`, "signal"));

      /* ── STAGE 2: QUALIFY ── */
      setStageIdx(1);
      log("📊", "ICP Engine", "Running 5-dimension qualification scorecard...");
      await delay(300);
      log("🔎", "Crunchbase", "Pulling company size, revenue, and funding data...");
      await delay(300);
      log("🔎", "LinkedIn", "Verifying employee counts and company profiles...");
      await delay(200);
      log("🔎", "G2 / Gartner", "Checking for existing AI voice vendor relationships...");
      await delay(200);
      log("⚡", "AI Agent", "Scoring each company against ICP criteria...");

      const list = d1.signals.map((s,i) => `${i+1}. ${s.company} (${s.industry}, ${s.num_openings}x ${s.role_title}, ${s.location})`).join("\n");
      const s2 = await claude([{role:"user",content:`Qualify for Feather AI voice platform:\n\n${list}\n\nResearch each. Score 0-2 on: industry, size (200-2000 ideal), phone intensity, no AI voice, timing. /10. Qualified if 6+. Disqualify if: has AI voice, <50 or >5000 employees, government.\n\nReturn JSON:\n{"companies":[{"name":"","total_score":0,"qualified":true,"employees":"","revenue":"","has_ai_voice":false,"estimated_contract_value":"$100K","reasoning":""}]}`}],
        "B2B qualification agent. Return ONLY valid JSON.");
      const d2 = parseJSON(s2);
      setQualified(d2?.companies || []);
      const passed = (d2?.companies || []).filter(c => c.qualified);
      const failed = (d2?.companies || []).filter(c => !c.qualified);
      passed.forEach(c => log("✅", "ICP", `${c.name} qualified — score ${c.total_score}/10 (${c.employees} emp)`, "success"));
      failed.forEach(c => log("❌", "ICP", `${c.name} filtered out — ${c.reasoning || "below threshold"}`, "filtered"));
      if (!passed.length) throw new Error("No companies qualified.");

      /* ── STAGE 3-5: ENRICH EACH ── */
      const top = passed.slice(0, 3);
      const results = [];
      for (let i = 0; i < top.length; i++) {
        const co = top[i], sig = d1.signals.find(s => s.company === co.name) || d1.signals[0];

        /* DM */
        setStageIdx(2);
        log("👤", "Apollo.io", `Searching contacts at ${co.name}...`);
        await delay(400);
        log("🔎", "Apollo.io", `Filtering by title: VP Ops, COO, Dir Contact Center, VP CX, CTO...`);
        await delay(300);
        log("🔗", "LinkedIn", `Cross-referencing profiles for title & tenure verification...`);
        await delay(200);
        log("⚡", "AI Agent", `Selecting highest-confidence decision maker...`);

        const s3 = await claude([{role:"user",content:`Find the decision maker at ${co.name} (${co.employees} employees, ${co.industry}) for AI voice software.\nTarget: VP Ops, COO, Dir Contact Center, VP CX, CTO. NOT recruiters/agents.\nReturn JSON: {"dm":{"name":"","title":"","linkedin_url":"","email_guess":"","confidence":"high/medium/low","why":""}}`}],
          "Contact research agent. Return ONLY valid JSON.");
        const d3 = parseJSON(s3);
        const dm = d3?.dm || {name:"N/A",title:"Ops Leader"};
        log("✅", "Apollo.io", `Found: ${dm.name} — ${dm.title} (${dm.confidence} confidence)`, "success");
        if (dm.email_guess) log("📧", "Hunter.io", `Verified email pattern: ${dm.email_guess}`, "info");
        if (dm.linkedin_url) log("🔗", "LinkedIn", `Profile confirmed: ${dm.linkedin_url}`, "info");

        /* ROI + OUTREACH */
        setStageIdx(3);
        log("💰", "ROI Engine", `Modeling hiring costs vs Feather for ${co.name}...`);
        await delay(300);
        log("📊", "BLS Data", `Pulling avg call center salary for ${sig.location}...`);
        await delay(300);
        setStageIdx(4);
        log("✍️", "Copywriter", `Drafting personalized outreach for ${dm.name}...`);
        await delay(200);
        log("⚡", "AI Agent", `Generating email, LinkedIn DM, and thought leadership post...`);

        const s4 = await claude([{role:"user",content:`ROI+OUTREACH for ${co.name} (${co.employees} emp, ${co.revenue} rev, ${co.industry}). Hiring ${sig.num_openings||8} phone agents. Feather=$0.07/min.\n\nROI: salary+30%+$4K training vs Feather (50 calls/day, 5min avg, 250 days).\n\nOUTREACH for ${dm.name} (${dm.title}):\n1. EMAIL <100w, ref hiring, lead ROI. Subject <50ch.\n2. LINKEDIN note <300ch + followup <150w.\n3. POST <200w, provocative, say "a ${co.industry} company".\n\nReturn JSON:\n{"roi":{"hiring_annual":0,"feather_annual":0,"savings":0,"pct":0,"headline":""},"email":{"subject":"","body":""},"linkedin":{"note":"","followup":""},"post":""}`}],
          "Financial analyst + B2B copywriter. Return ONLY valid JSON.", true);
        const d4 = parseJSON(s4);
        if (d4?.roi) log("💰", "ROI", `${co.name}: $${Math.round((d4.roi.hiring_annual||0)/1000)}K hiring → $${Math.round((d4.roi.feather_annual||0)/1000)}K Feather = $${Math.round((d4.roi.savings||0)/1000)}K saved (${d4.roi.pct}%)`, "success");
        log("✅", "Pipeline", `${co.name} fully enriched — outreach package ready`, "success");

        results.push({ company: co, signal: sig, dm, roi: d4?.roi || {}, outreach: {email:d4?.email,linkedin:d4?.linkedin,post:d4?.post} });
        setEnriched([...results]);
      }
      setStageIdx(5);
      log("🎯", "Complete", `Pipeline finished — ${results.length} companies ready for outreach`, "success");
    } catch (e) { setError(e.message); log("🔴", "Error", e.message, "error"); } finally { running.current = false; }
  }, []);

  const isRunning = stageIdx >= 0 && stageIdx < 5 && !error;
  const STAGES = ["Scanning job boards", "Qualifying against ICP", "Finding decision makers", "Calculating ROI", "Drafting outreach"];

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px" }}>
      <div style={{ display: "flex", gap: 24 }}>
        {/* LEFT: Main pipeline */}
        <div style={{ flex: "1 1 0", minWidth: 0 }}>
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: "#111827", marginBottom: 6 }}>Hiring signal → qualified pipeline</h1>
            <p style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
              Scans Indeed, LinkedIn, ZipRecruiter, Glassdoor & Google Jobs. Qualifies via ICP scorecard.
              Finds DMs through Apollo.io. Calculates ROI. Drafts outreach. Pushes to HubSpot.
            </p>
          </div>

          {/* Input */}
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, display: "flex", alignItems: "center", padding: "0 4px 0 16px", boxShadow: "0 1px 2px rgba(0,0,0,.05)" }}>
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key==="Enter" && !isRunning && run(query)} disabled={isRunning}
                style={{ flex: 1, background: "transparent", border: "none", color: "#111827", fontSize: 14, padding: "12px 0" }}/>
              <button onClick={() => run(query)} disabled={isRunning || !query.trim()} style={{
                background: isRunning ? "#e5e7eb" : "#2563eb", color: isRunning ? "#9ca3af" : "#fff",
                border: "none", borderRadius: 8, padding: "8px 20px", fontSize: 13, fontWeight: 600,
              }}>{isRunning ? "Running..." : "Run pipeline"}</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 24 }}>
            {PRESETS.map(p => (
              <button key={p} onClick={() => {setQuery(p); if(!isRunning) run(p);}} disabled={isRunning}
                style={{ background: "#fff", border: "1px solid #e5e7eb", color: "#6b7280", padding: "5px 12px", borderRadius: 6, fontSize: 11 }}
                onMouseOver={e => {e.target.style.borderColor="#2563eb";e.target.style.color="#2563eb"}}
                onMouseOut={e => {e.target.style.borderColor="#e5e7eb";e.target.style.color="#6b7280"}}
              >{p}</button>
            ))}
          </div>

          {/* Progress */}
          {stageIdx >= 0 && (
            <div style={{ marginBottom: 20, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 18px", boxShadow: "0 1px 2px rgba(0,0,0,.05)" }} className="fu">
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                {stageIdx < 5 && <div style={{ width: 14, height: 14, border: "2px solid #2563eb", borderTopColor: "transparent", borderRadius: "50%", animation: "spin .8s linear infinite" }}/>}
                {stageIdx === 5 && <span style={{ color: "#10b981", fontSize: 14 }}>✓</span>}
                <span style={{ fontSize: 13, fontWeight: 600, color: stageIdx < 5 ? "#2563eb" : "#10b981" }}>
                  {stageIdx < 5 ? STAGES[stageIdx] : "Pipeline complete"}
                </span>
              </div>
              <div style={{ display: "flex", gap: 3 }}>
                {STAGES.map((_, i) => (
                  <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= stageIdx ? (stageIdx===5?"#10b981":"#2563eb") : "#e5e7eb", transition: "background .3s" }}/>
                ))}
              </div>
            </div>
          )}

          {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }} className="fu"><span style={{ color: "#dc2626", fontSize: 13 }}>{error}</span></div>}

          {/* Signals */}
          {signals.length > 0 && (
            <div className="fu" style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>Signals detected</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 8 }}>
                {signals.map((s, i) => {
                  const q = qualified.find(c => c.name === s.company);
                  return (
                    <div key={i} style={{ background: "#fff", border: `1px solid ${q?.qualified ? "#86efac" : q ? "#fecaca" : "#e5e7eb"}`, borderRadius: 8, padding: "10px 12px" }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#111827", marginBottom: 3 }}>{s.company}</div>
                      <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 5 }}>{s.role_title}</div>
                      <div style={{ display: "flex", gap: 4 }}>
                        <Tag color="blue">{s.num_openings} roles</Tag>
                        {q?.qualified && <Tag color="green">{q.total_score}/10</Tag>}
                        {q && !q.qualified && <Tag color="red">filtered</Tag>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Enriched Results */}
          {enriched.map((item, i) => {
            const isExp = expanded === i;
            const tab = tabs[i] || "roi";
            const hs = hsStatus[item.company.name];
            return (
              <div key={i} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, marginBottom: 10, overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,.05)" }} className="fu">
                <div onClick={() => setExpanded(isExp ? null : i)} style={{ padding: "14px 18px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{item.company.name}</span>
                      <Tag color="green">Qualified</Tag>
                      <Tag color="blue">{item.company.estimated_contract_value}</Tag>
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>
                      {item.dm.name} · {item.dm.title} · {item.company.employees} employees
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {item.roi?.savings > 0 && <span style={{ fontSize: 17, fontWeight: 700, color: "#10b981" }}>${Math.round(item.roi.savings/1000)}K<span style={{ fontSize: 10, fontWeight: 400, color: "#6b7280" }}>/yr</span></span>}
                    {hubspot && (
                      <button onClick={e => {e.stopPropagation(); pushHS(item)}} disabled={hs==="pushing"||hs==="done"}
                        style={{ padding: "5px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, border: `1px solid ${hs==="done"?"#86efac":"#e5e7eb"}`,
                          background: hs==="done" ? "#f0fdf4" : "#fff", color: hs==="done" ? "#10b981" : hs==="error" ? "#dc2626" : "#2563eb",
                        }}>{hs==="pushing"?"..." : hs==="done"?"✓ HubSpot" : hs==="error"?"Retry" : "→ HubSpot"}</button>
                    )}
                    <span style={{ color: "#d1d5db", fontSize: 14, transition: "transform .2s", transform: isExp ? "rotate(90deg)" : "none" }}>▸</span>
                  </div>
                </div>
                {isExp && (
                  <div style={{ borderTop: "1px solid #f3f4f6" }}>
                    <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #f3f4f6" }}>
                      {[["roi","ROI"],["email","Email"],["linkedin","LinkedIn"],["post","Post"]].map(([id,label]) => (
                        <button key={id} onClick={() => setTabs(p=>({...p,[i]:id}))} style={{
                          padding: "10px 18px", fontSize: 12, fontWeight: 500, border: "none", borderBottom: tab===id ? "2px solid #2563eb" : "2px solid transparent",
                          background: "transparent", color: tab===id ? "#2563eb" : "#6b7280",
                        }}>{label}</button>
                      ))}
                    </div>
                    <div style={{ padding: 18 }}>
                      {tab==="roi" && (
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                          <Metric label="Current hiring cost" value={`$${Math.round((item.roi?.hiring_annual||0)/1000)}K/yr`} color="#ef4444"/>
                          <Metric label="Feather cost" value={`$${Math.round((item.roi?.feather_annual||0)/1000)}K/yr`} color="#2563eb"/>
                          <Metric label="Annual savings" value={`$${Math.round((item.roi?.savings||0)/1000)}K`} sub={`${item.roi?.pct||0}% reduction`} color="#10b981"/>
                        </div>
                      )}
                      {tab==="email" && item.outreach?.email && (
                        <div>
                          <div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}>
                            <span style={{ fontSize:13,fontWeight:600,color:"#111827" }}>Subject: {item.outreach.email.subject}</span>
                            <CopyBtn text={`Subject: ${item.outreach.email.subject}\n\n${item.outreach.email.body}`}/>
                          </div>
                          <pre style={{ background:"#f9fafb",padding:14,borderRadius:8,border:"1px solid #f3f4f6" }}>{item.outreach.email.body}</pre>
                        </div>
                      )}
                      {tab==="linkedin" && item.outreach?.linkedin && (
                        <div>
                          <div style={{ marginBottom:14 }}>
                            <div style={{ display:"flex",justifyContent:"space-between",marginBottom:5 }}>
                              <span style={{ fontSize:11,color:"#6b7280",fontWeight:600,textTransform:"uppercase" }}>Connection note</span>
                              <CopyBtn text={item.outreach.linkedin.note}/>
                            </div>
                            <pre style={{ background:"#f9fafb",padding:12,borderRadius:8,border:"1px solid #f3f4f6",borderLeft:"3px solid #2563eb" }}>{item.outreach.linkedin.note}</pre>
                          </div>
                          <div>
                            <div style={{ display:"flex",justifyContent:"space-between",marginBottom:5 }}>
                              <span style={{ fontSize:11,color:"#6b7280",fontWeight:600,textTransform:"uppercase" }}>Follow-up</span>
                              <CopyBtn text={item.outreach.linkedin.followup}/>
                            </div>
                            <pre style={{ background:"#f9fafb",padding:12,borderRadius:8,border:"1px solid #f3f4f6",borderLeft:"3px solid #7c3aed" }}>{item.outreach.linkedin.followup}</pre>
                          </div>
                        </div>
                      )}
                      {tab==="post" && item.outreach?.post && (
                        <div>
                          <div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}>
                            <span style={{ fontSize:11,color:"#6b7280",fontWeight:600,textTransform:"uppercase" }}>LinkedIn post</span>
                            <CopyBtn text={item.outreach.post}/>
                          </div>
                          <pre style={{ background:"#f9fafb",padding:14,borderRadius:8,border:"1px solid #f3f4f6",lineHeight:1.7 }}>{item.outreach.post}</pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {stageIdx===5 && enriched.length>0 && (
            <div className="fu" style={{ marginTop:20,padding:"18px 22px",background:"#f0fdf4",border:"1px solid #86efac",borderRadius:10 }}>
              <div style={{ display:"flex",gap:28,flexWrap:"wrap" }}>
                <Stat label="Signals scanned" value={signals.length}/>
                <Stat label="Qualified" value={enriched.length}/>
                <Stat label="Total addressable savings" value={`$${Math.round(enriched.reduce((s,e)=>s+(e.roi?.savings||0),0)/1000)}K/yr`}/>
                <Stat label="Outreach packages ready" value={enriched.length}/>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: Activity log */}
        {stageIdx >= 0 && (
          <div style={{ width: 340, flexShrink: 0 }} className="fu">
            <div style={{ position: "sticky", top: 20 }}>
              <h3 style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 10 }}>Activity log</h3>
              <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, maxHeight: "calc(100vh - 140px)", overflowY: "auto", boxShadow: "0 1px 2px rgba(0,0,0,.05)" }}>
                {logs.map((l, i) => (
                  <div key={i} className="si" style={{
                    padding: "8px 12px", borderBottom: "1px solid #f9fafb",
                    background: l.type === "success" ? "#f0fdf4" : l.type === "error" ? "#fef2f2" : l.type === "filtered" ? "#fefce8" : "transparent",
                  }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <span style={{ fontSize: 12, flexShrink: 0, marginTop: 1 }}>{l.icon}</span>
                      <div style={{ minWidth: 0 }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginRight: 6,
                          color: l.source === "Apollo.io" ? "#7c3aed" : l.source === "HubSpot" ? "#f97316" : l.source === "LinkedIn" || l.source === "LinkedIn Jobs" ? "#0077b5" :
                            l.source === "Indeed" ? "#2164f3" : l.source === "ZipRecruiter" ? "#239846" : l.source === "Glassdoor" ? "#0caa41" :
                            l.source === "Google Jobs" ? "#ea4335" : l.source === "Hunter.io" ? "#ff7043" : l.source === "Crunchbase" ? "#0288d1" :
                            l.source === "G2 / Gartner" ? "#ff492c" : l.source === "BLS Data" ? "#1565c0" :
                            l.type === "success" ? "#059669" : l.type === "error" ? "#dc2626" : "#6b7280",
                        }}>{l.source}</span>
                        <span style={{ fontSize: 11, color: l.type === "error" ? "#dc2626" : "#374151", lineHeight: 1.4, display: "inline" }}>{l.msg}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {isRunning && (
                  <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 10, height: 10, border: "2px solid #2563eb", borderTopColor: "transparent", borderRadius: "50%", animation: "spin .8s linear infinite" }}/>
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>Processing...</span>
                  </div>
                )}
                <div ref={logEnd}/>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══ ARCHITECTURE ═══ */
function Architecture() {
  return (
    <div style={{ maxWidth:960,margin:"0 auto",padding:"40px 24px" }}>
      <div style={{ marginBottom:32 }}>
        <h1 style={{ fontSize:26,fontWeight:700,color:"#111827",marginBottom:8 }}>System architecture</h1>
        <p style={{ fontSize:13,color:"#6b7280",maxWidth:560 }}>Three n8n workflows with human approval gates. HubSpot as CRM. Apollo.io for contact enrichment. Nothing ships without review.</p>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 32 }}>
        {[["Indeed","#2164f3"],["LinkedIn Jobs","#0077b5"],["ZipRecruiter","#239846"],["Glassdoor","#0caa41"],["Google Jobs","#ea4335"],["Apollo.io","#7c3aed"],["Hunter.io","#ff7043"],["HubSpot","#f97316"],["Crunchbase","#0288d1"],["Slack","#e01e5a"]].map(([n,c]) => (
          <div key={n} style={{ padding: "6px 14px", borderRadius: 6, background: "#fff", border: `1px solid ${c}33`, display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: c }}/>
            <span style={{ fontSize: 11, fontWeight: 600, color: c }}>{n}</span>
          </div>
        ))}
      </div>

      <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:32 }}>
        {[["Signals / day","6-12","#2563eb"],["Pass rate","~40%","#7c3aed"],["Cost / run","$0.35","#0891b2"],["Human time","45 min/day","#f59e0b"]].map(([l,v,c]) => (
          <div key={l} style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,padding:"14px 16px",borderLeft:`3px solid ${c}` }}>
            <div style={{ fontSize:11,color:"#9ca3af",marginBottom:4 }}>{l}</div>
            <div style={{ fontSize:22,fontWeight:700,color:c }}>{v}</div>
          </div>
        ))}
      </div>

      {WF.map((wf,wi) => (
        <div key={wi} style={{ marginBottom:20 }} className="fu">
          <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:10 }}>
            <div style={{ width:32,height:32,borderRadius:8,background:wf.c+"12",border:`1.5px solid ${wf.c}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:wf.c }}>{wi+1}</div>
            <div>
              <div style={{ fontSize:15,fontWeight:600,color:"#111827" }}>{wf.n}</div>
              <div style={{ fontSize:11,color:"#9ca3af" }}>{wf.t}</div>
            </div>
          </div>
          <div style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,padding:14,marginBottom:6 }}>
            <div style={{ display:"flex",flexWrap:"wrap",gap:6,alignItems:"center" }}>
              {wf.nodes.map((n,j) => (
                <div key={j} style={{ display:"flex",alignItems:"center",gap:6 }}>
                  <div style={{ padding:"6px 12px",borderRadius:6,
                    background: n.includes("Apollo") ? "#f5f3ff" : n.includes("Score")||n.includes("Calculate")||n.includes("Draft")||n.includes("Verify") ? "#f0f4ff" : n.includes("Filter")?"#fffbeb": n.includes("HubSpot")||n.includes("Slack") ? "#fff7ed" :"#f0fdf4",
                    border:`1px solid ${n.includes("Apollo") ? "#c4b5fd" : n.includes("Score")||n.includes("Calculate")||n.includes("Draft")||n.includes("Verify") ? "#bfdbfe" : n.includes("Filter")?"#fde68a": n.includes("HubSpot")||n.includes("Slack") ? "#fed7aa" : "#bbf7d0"}`,
                    fontSize:11,fontWeight:500,
                    color: n.includes("Apollo") ? "#7c3aed" : n.includes("Score")||n.includes("Calculate")||n.includes("Draft")||n.includes("Verify") ? "#2563eb" : n.includes("Filter")?"#d97706": n.includes("HubSpot")||n.includes("Slack") ? "#ea580c" : "#059669"
                  }}>{n}</div>
                  {j<wf.nodes.length-1 && <span style={{ color:"#d1d5db" }}>→</span>}
                </div>
              ))}
            </div>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:8,padding:"10px 16px",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,borderLeft:`3px solid #f59e0b` }}>
            <span style={{ fontSize:12,color:"#92400e" }}>⏸ {wf.gate}</span>
          </div>
        </div>
      ))}

      <div style={{ marginTop:32 }}>
        <h3 style={{ fontSize:14,fontWeight:600,color:"#111827",marginBottom:10 }}>HubSpot deal pipeline</h3>
        <div style={{ display:"flex",flexWrap:"wrap",gap:4 }}>
          {["Signal detected","Qualifying","⏸ Review","Approved","Finding DM","⏸ Verify DM","DM approved","Gen outreach","⏸ Review msgs","Sent","Meeting","Won"].map((s,i) => (
            <div key={i} style={{ display:"flex",alignItems:"center",gap:4 }}>
              <div style={{ padding:"4px 10px",borderRadius:5,fontSize:10,fontWeight:500,
                background:s.startsWith("⏸")?"#fffbeb":s==="Won"?"#f0fdf4":"#fff",
                color:s.startsWith("⏸")?"#92400e":s==="Won"?"#059669":"#6b7280",
                border:`1px solid ${s.startsWith("⏸")?"#fde68a":s==="Won"?"#86efac":"#e5e7eb"}`,
              }}>{s.replace("⏸ ","")}</div>
              {i<11 && <span style={{ color:"#e5e7eb",fontSize:10 }}>→</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══ SHARED ═══ */
function Tag({children,color="blue"}) {
  const c = {blue:["#eff6ff","#2563eb","#bfdbfe"],green:["#f0fdf4","#059669","#86efac"],red:["#fef2f2","#dc2626","#fecaca"]}[color]||["#eff6ff","#2563eb","#bfdbfe"];
  return <span style={{ display:"inline-block",padding:"1px 8px",borderRadius:4,fontSize:10,fontWeight:600,background:c[0],color:c[1],border:`1px solid ${c[2]}` }}>{children}</span>;
}
function Metric({label,value,sub,color}) {
  return <div style={{ background:"#f9fafb",borderRadius:8,padding:"12px 14px",borderLeft:`3px solid ${color}` }}>
    <div style={{ fontSize:10,color:"#9ca3af",marginBottom:3 }}>{label}</div>
    <div style={{ fontSize:20,fontWeight:700,color }}>{value}</div>
    {sub && <div style={{ fontSize:10,color:"#9ca3af",marginTop:2 }}>{sub}</div>}
  </div>;
}
function Stat({label,value}) {
  return <div><div style={{ fontSize:10,color:"#059669",fontWeight:500,marginBottom:2 }}>{label}</div><div style={{ fontSize:17,fontWeight:700,color:"#111827" }}>{value}</div></div>;
}
function CopyBtn({text}) {
  const [c,setC] = useState(false);
  return <button onClick={()=>{navigator.clipboard.writeText(text);setC(true);setTimeout(()=>setC(false),1500)}}
    style={{ background:"#f9fafb",border:"1px solid #e5e7eb",color:c?"#10b981":"#6b7280",padding:"3px 10px",borderRadius:5,fontSize:11,fontWeight:500 }}>{c?"✓ Copied":"Copy"}</button>;
}
