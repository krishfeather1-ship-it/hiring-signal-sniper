import { useState, useRef, useCallback } from "react";

let _apiKey = "";
let _hubspotToken = "";
let _n8nUrl = "http://localhost:5678";

/* ═══ API ═══ */
async function claude(messages, system, search = true) {
  if (!_apiKey) throw new Error("Set your Anthropic API key in the config panel.");
  const body = { model: "claude-sonnet-4-20250514", max_tokens: 4096, messages, system };
  if (search) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": _apiKey, "anthropic-version": "2023-06-01" },
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

/* ═══ CONSTANTS ═══ */
const STAGES = [
  { id: "detect", label: "Scan" }, { id: "qualify", label: "Qualify" },
  { id: "contact", label: "DM" }, { id: "roi", label: "ROI" }, { id: "outreach", label: "Outreach" },
];
const PRESETS = [
  "Mid-market mortgage lenders hiring call center agents",
  "Regional insurance carriers hiring claims phone reps",
  "Credit unions ($1B-10B) hiring member service reps",
  "Specialty auto lenders hiring loan servicing phone agents",
];
const WORKFLOWS = [
  { id: 1, name: "Scan & qualify", trigger: "Daily schedule", color: "#22c55e",
    nodes: ["Claude: scan jobs", "Parse signals", "Claude: ICP score", "IF: score ≥ 6?", "HubSpot: create deal", "Slack: notify"],
    gate: "Review ICP fit in HubSpot → approve or reject" },
  { id: 2, name: "Find decision maker", trigger: "HubSpot webhook → ICP approved", color: "#a78bfa",
    nodes: ["HubSpot: get deal", "Apollo: people search", "Claude: verify DM", "HubSpot: create contact", "Slack: notify"],
    gate: "Verify contact on LinkedIn → approve" },
  { id: 3, name: "ROI + outreach", trigger: "HubSpot webhook → contact approved", color: "#60a5fa",
    nodes: ["HubSpot: get deal+contact", "Claude: ROI analysis", "Claude: draft outreach", "HubSpot: update deal", "HubSpot: create task"],
    gate: "Review all messaging → edit → send manually" },
];

/* ═══ FEATHER LOGO ═══ */
function FeatherMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="#111"/>
      <path d="M10 22c2.5-6 6.5-10 12-12.5-2.5 3.5-4 6.5-4.5 10" stroke="#22c55e" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M13 22.5c1.8-4.5 4.5-8 9-10.5" stroke="#22c55e" strokeWidth="1.2" strokeLinecap="round" opacity=".5"/>
    </svg>
  );
}

/* ═══ BRACKET CORNERS (Feather design element) ═══ */
function Brackets({ children, color = "#22c55e", style = {} }) {
  const s = { position: "absolute", width: 12, height: 12 };
  return (
    <div style={{ position: "relative", ...style }}>
      <svg style={{ ...s, top: -1, left: -1 }} viewBox="0 0 12 12"><path d="M1 8V2h6" fill="none" stroke={color} strokeWidth="1.2"/></svg>
      <svg style={{ ...s, top: -1, right: -1 }} viewBox="0 0 12 12"><path d="M11 8V2h-6" fill="none" stroke={color} strokeWidth="1.2"/></svg>
      <svg style={{ ...s, bottom: -1, left: -1 }} viewBox="0 0 12 12"><path d="M1 4V10h6" fill="none" stroke={color} strokeWidth="1.2"/></svg>
      <svg style={{ ...s, bottom: -1, right: -1 }} viewBox="0 0 12 12"><path d="M11 4V10h-6" fill="none" stroke={color} strokeWidth="1.2"/></svg>
      {children}
    </div>
  );
}

/* ═══ APP ═══ */
export default function App() {
  const [page, setPage] = useState("pipeline");
  const [configOpen, setConfigOpen] = useState(false);
  const [keys, setKeys] = useState({ anthropic: "", hubspot: "", n8n: "http://localhost:5678" });
  const [keysSet, setKeysSet] = useState({ anthropic: false, hubspot: false });

  const updateKey = (k, v) => {
    setKeys(p => ({ ...p, [k]: v }));
    if (k === "anthropic") { _apiKey = v; setKeysSet(p => ({ ...p, anthropic: !!v })); }
    if (k === "hubspot") { _hubspotToken = v; setKeysSet(p => ({ ...p, hubspot: !!v })); }
    if (k === "n8n") { _n8nUrl = v; }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#050507", color: "#d4d4d4", fontFamily: "'IBM Plex Sans',system-ui,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
        .fi{animation:fadeIn .4s ease-out both}
        .shim{background:linear-gradient(90deg,#0a0a0d 0%,#141418 50%,#0a0a0d 100%);background-size:200% 100%;animation:shimmer 1.8s ease-in-out infinite}
        *{box-sizing:border-box;margin:0;padding:0}
        button{cursor:pointer;font-family:inherit}
        input:focus{outline:none}
        pre{white-space:pre-wrap;word-break:break-word;margin:0;font-family:'IBM Plex Mono',monospace;font-size:12.5px;line-height:1.65;color:#a0a0a0}
      `}</style>

      {/* ═══ NAV ═══ */}
      <nav style={{ borderBottom: "1px solid #111", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, background: "#050507" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <FeatherMark />
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", letterSpacing: "-.01em", lineHeight: 1.2 }}>Hiring Signal Sniper</div>
            <div style={{ fontSize: 10, color: "#444" }}>A GTM automation by <span style={{ color: "#22c55e" }}>Krish Desai</span> for Feather</div>
          </div>
          <div style={{ display: "flex", gap: 2, marginLeft: 12 }}>
            {[["pipeline", "Live pipeline"], ["architecture", "System architecture"]].map(([id, label]) => (
              <button key={id} onClick={() => setPage(id)} style={{
                padding: "5px 14px", borderRadius: 4, fontSize: 12, fontWeight: 500, border: "none",
                background: page === id ? "#111" : "transparent", color: page === id ? "#22c55e" : "#444", transition: "all .15s",
              }}>{label}</button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {keysSet.hubspot && <a href="https://app.hubspot.com/contacts" target="_blank" rel="noopener" style={{ fontSize: 11, color: "#444", textDecoration: "none", padding: "4px 10px", border: "1px solid #1a1a1e", borderRadius: 4 }}>HubSpot</a>}
          <a href={keys.n8n} target="_blank" rel="noopener" style={{ fontSize: 11, color: "#444", textDecoration: "none", padding: "4px 10px", border: "1px solid #1a1a1e", borderRadius: 4 }}>n8n</a>
          <button onClick={() => setConfigOpen(!configOpen)} style={{
            background: configOpen ? "#111" : "transparent", border: "1px solid #1a1a1e", borderRadius: 4,
            padding: "4px 12px", fontSize: 11, color: keysSet.anthropic ? "#22c55e" : "#EF9F27",
          }}>{keysSet.anthropic ? "✓ configured" : "⚙ configure"}</button>
        </div>
      </nav>

      {/* ═══ CONFIG PANEL ═══ */}
      {configOpen && (
        <div style={{ borderBottom: "1px solid #111", padding: "16px 24px", background: "#0a0a0d", display: "flex", gap: 16, flexWrap: "wrap" }} className="fi">
          <ConfigField label="Anthropic API key" placeholder="sk-ant-api03-..." value={keys.anthropic} onChange={v => updateKey("anthropic", v)} ok={keysSet.anthropic} password />
          <ConfigField label="HubSpot private app token" placeholder="pat-na1-..." value={keys.hubspot} onChange={v => updateKey("hubspot", v)} ok={keysSet.hubspot} password />
          <ConfigField label="n8n instance URL" placeholder="http://localhost:5678" value={keys.n8n} onChange={v => updateKey("n8n", v)} />
        </div>
      )}

      {page === "pipeline" ? <PipelinePage hubspot={keysSet.hubspot} n8nUrl={keys.n8n} /> : <ArchitecturePage n8nUrl={keys.n8n} />}

      {/* ═══ FOOTER ═══ */}
      <footer style={{ borderTop: "1px solid #111", padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 60 }}>
        <div style={{ fontSize: 11, color: "#333" }}>Built by <span style={{ color: "#666" }}>Krish Desai</span> · GTM Automation for <span style={{ color: "#22c55e" }}>Feather</span></div>
        <div style={{ display: "flex", gap: 12 }}>
          <a href="https://www.featherhq.com" target="_blank" rel="noopener" style={{ fontSize: 11, color: "#333" }}>featherhq.com</a>
          <a href={keys.n8n} target="_blank" rel="noopener" style={{ fontSize: 11, color: "#333" }}>n8n workflows</a>
        </div>
      </footer>
    </div>
  );
}

function ConfigField({ label, placeholder, value, onChange, ok, password }) {
  return (
    <div style={{ flex: "1 1 220px" }}>
      <div style={{ fontSize: 10, color: "#555", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
        {label} {ok && <span style={{ color: "#22c55e" }}>✓</span>}
      </div>
      <input type={password ? "password" : "text"} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}
        style={{ width: "100%", background: "#0d0d10", border: `1px solid ${ok ? "#1a3a1e" : "#1a1a1e"}`, borderRadius: 4, padding: "7px 10px", fontSize: 11, color: "#888", fontFamily: "'IBM Plex Mono',monospace" }} />
    </div>
  );
}

/* ═══ PIPELINE PAGE ═══ */
function PipelinePage({ hubspot, n8nUrl }) {
  const [query, setQuery] = useState(PRESETS[0]);
  const [stageIdx, setStageIdx] = useState(-1);
  const [signals, setSignals] = useState([]);
  const [qualified, setQualified] = useState([]);
  const [enriched, setEnriched] = useState([]);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [tabs, setTabs] = useState({});
  const [hubspotStatus, setHubspotStatus] = useState({});
  const running = useRef(false);

  const pushToHubspot = async (item) => {
    if (!_hubspotToken) return;
    const id = item.company.name;
    setHubspotStatus(p => ({ ...p, [id]: "pushing" }));
    try {
      const co = await hubspot("POST", "crm/v3/objects/companies", {
        properties: { name: item.company.name, industry: item.signal.industry, numberofemployees: item.company.employees, description: `Hiring Signal: ${item.signal.role_title} (${item.signal.num_openings} openings). ${item.company.reasoning}` }
      });
      const deal = await hubspot("POST", "crm/v3/objects/deals", {
        properties: {
          dealname: `Signal: ${item.company.name}`, pipeline: "default", dealstage: "qualifiedtobuy",
          amount: String(item.roi?.savings || 100000),
          description: `DM: ${item.dm?.name} (${item.dm?.title})\nROI: $${Math.round((item.roi?.savings || 0) / 1000)}K savings/yr\n\nEmail subject: ${item.outreach?.email?.subject}\nEmail: ${item.outreach?.email?.body}\n\nLinkedIn note: ${item.outreach?.linkedin?.note}\nLinkedIn followup: ${item.outreach?.linkedin?.followup}\n\nLinkedIn post: ${item.outreach?.post}`,
        },
        associations: co?.id ? [{ to: { id: co.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 342 }] }] : [],
      });
      if (item.dm?.name) {
        const names = item.dm.name.split(" ");
        await hubspot("POST", "crm/v3/objects/contacts", {
          properties: { firstname: names[0] || "", lastname: names.slice(1).join(" ") || "", jobtitle: item.dm?.title, email: item.dm?.email_guess || "" },
          associations: co?.id ? [{ to: { id: co.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 280 }] }] : [],
        });
      }
      setHubspotStatus(p => ({ ...p, [id]: "done" }));
    } catch (e) {
      setHubspotStatus(p => ({ ...p, [id]: "error" }));
    }
  };

  const run = useCallback(async (input) => {
    if (running.current) return;
    running.current = true;
    setError(null); setSignals([]); setQualified([]); setEnriched([]); setExpanded(null); setStageIdx(0); setHubspotStatus({});
    try {
      const s1 = await claude([{ role: "user", content: `Search for mid-market companies (200-2000 employees) in US mortgage, lending, insurance, credit union industries currently hiring phone/call center roles. "${input}"\n\nMID-MARKET ONLY. NOT: GEICO, Progressive, Rocket Mortgage, Wells Fargo, JPMorgan, Bank of America. Focus on regional lenders, mid-size servicers, specialty insurers, credit unions $1B-$10B assets.\n\nFind 5-7 real companies. Return ONLY JSON:\n{"signals":[{"company":"","role_title":"","location":"","num_openings":5,"industry":"mortgage/lending/insurance/credit_union","signal_strength":"high/medium/low"}]}` }],
        "Hiring signal agent targeting MID-MARKET companies (200-2000 employees). Return ONLY valid JSON.");
      const d1 = parseJSON(s1);
      if (!d1?.signals?.length) throw new Error("No signals found.");
      setSignals(d1.signals);

      setStageIdx(1);
      const list = d1.signals.map((s, i) => `${i + 1}. ${s.company} (${s.industry}, ${s.num_openings}x ${s.role_title}, ${s.location})`).join("\n");
      const s2 = await claude([{ role: "user", content: `Qualify for Feather AI voice:\n\n${list}\n\nResearch each. Score 0-2 on: industry, size (200-2000 ideal), phone intensity, no AI voice, timing. /10. Qualified if 6+. Disqualify: has AI voice, <50 or >5000 employees, gov.\n\nReturn JSON:\n{"companies":[{"name":"","total_score":0,"qualified":true,"employees":"","revenue":"","has_ai_voice":false,"existing_solution":"none","estimated_contract_value":"$100K","reasoning":"2 sentences"}]}` }],
        "B2B qualification agent. Return ONLY valid JSON.");
      const d2 = parseJSON(s2);
      setQualified(d2?.companies || []);
      const passed = (d2?.companies || []).filter(c => c.qualified);
      if (!passed.length) throw new Error("No companies qualified.");

      const top = passed.slice(0, 3);
      const results = [];
      for (let i = 0; i < top.length; i++) {
        const co = top[i]; const sig = d1.signals.find(s => s.company === co.name) || d1.signals[0];
        setStageIdx(2);
        const s3 = await claude([{ role: "user", content: `Find the decision maker at ${co.name} (${co.employees} employees, ${co.industry}) for AI voice calling software.\nTarget: VP Ops, COO, Dir Contact Center, VP CX, CTO. NOT recruiters/agents/CEO.\nReturn JSON: {"dm":{"name":"","title":"","linkedin_url":"","email_guess":"","confidence":"high/medium/low","why":""}}` }],
          "Contact research agent. Return ONLY valid JSON.");
        const d3 = parseJSON(s3);
        setStageIdx(3);
        const n = sig.num_openings || 8;
        const s4 = await claude([{ role: "user", content: `ROI+OUTREACH for ${co.name} (${co.employees} emp, ${co.revenue} rev, ${co.industry}). Hiring ${n} phone agents. Feather=$0.07/min.\n\nROI: salary+30%+$4K training vs Feather (50 calls/agent/day, 5min avg, 250 days).\n\nOUTREACH for ${d3?.dm?.name || "VP Ops"} (${d3?.dm?.title || ""}):\n1. EMAIL <100w, ref hiring, lead with ROI. Subject <50 chars.\n2. LINKEDIN note <300 chars + followup <150w.\n3. POST <200w, provocative, say "a ${co.industry} company".\n\nReturn JSON:\n{"roi":{"hiring_annual":0,"feather_annual":0,"savings":0,"pct":0,"headline":""},"email":{"subject":"","body":""},"linkedin":{"note":"","followup":""},"post":""}` }],
          "Financial analyst + B2B copywriter. Return ONLY valid JSON.", true);
        setStageIdx(4);
        const d4 = parseJSON(s4);
        results.push({ company: co, signal: sig, dm: d3?.dm || { name: "N/A", title: "Ops Leader" }, roi: d4?.roi || {}, outreach: { email: d4?.email, linkedin: d4?.linkedin, post: d4?.post } });
        setEnriched([...results]);
      }
      setStageIdx(5);
    } catch (e) { setError(e.message); } finally { running.current = false; }
  }, []);

  const isRunning = stageIdx >= 0 && stageIdx < 5 && !error;

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "40px 20px" }}>
      <Brackets color="#22c55e33" style={{ padding: "32px 28px", marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: "#fff", letterSpacing: "-.02em", marginBottom: 6 }}>Job posting → qualified pipeline</h1>
        <p style={{ fontSize: 13, color: "#444", lineHeight: 1.6, maxWidth: 640 }}>
          Finds mid-market lending & insurance companies hiring phone agents. Qualifies against ICP.
          Finds the decision maker. Calculates ROI. Drafts outreach. Pushes to HubSpot.
        </p>
      </Brackets>

      {/* Input */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1, background: "#0a0a0d", border: "1px solid #1a1a1e", borderRadius: 5, display: "flex", alignItems: "center", padding: "0 4px 0 14px" }}>
          <span style={{ color: "#22c55e", marginRight: 8, fontFamily: "'IBM Plex Mono',monospace", fontSize: 13 }}>$</span>
          <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && !isRunning && run(query)} disabled={isRunning}
            style={{ flex: 1, background: "transparent", border: "none", color: "#d4d4d4", fontSize: 13, padding: "11px 0", fontFamily: "'IBM Plex Mono',monospace" }} />
          <button onClick={() => run(query)} disabled={isRunning || !query.trim()} style={{
            background: isRunning ? "#111" : "#22c55e", color: isRunning ? "#444" : "#050507",
            border: "none", borderRadius: 4, padding: "7px 20px", fontSize: 12, fontWeight: 600,
          }}>{isRunning ? "running..." : "execute"}</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 28 }}>
        {PRESETS.map(p => (
          <button key={p} onClick={() => { setQuery(p); if (!isRunning) run(p); }} disabled={isRunning}
            style={{ background: "#0a0a0d", border: "1px solid #141418", color: "#3a3a3a", padding: "4px 10px", borderRadius: 3, fontSize: 10, transition: "all .15s" }}
            onMouseOver={e => { e.target.style.color = "#22c55e"; e.target.style.borderColor = "#1e3e2e"; }}
            onMouseOut={e => { e.target.style.color = "#3a3a3a"; e.target.style.borderColor = "#141418"; }}
          >{p}</button>
        ))}
      </div>

      {/* Stages */}
      {stageIdx >= 0 && (
        <div style={{ display: "flex", marginBottom: 24, borderRadius: 5, overflow: "hidden", border: "1px solid #141418" }} className="fi">
          {STAGES.map((s, i) => {
            const a = i === stageIdx && stageIdx < 5, d = i < stageIdx || stageIdx === 5;
            return (
              <div key={s.id} style={{ flex: 1, padding: "10px 12px", background: a ? "#0a1a10" : d ? "#0a0a0d" : "#050507", borderRight: i < 4 ? "1px solid #141418" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {a && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", animation: "pulse 1.2s infinite" }} />}
                  {d && <span style={{ color: "#22c55e", fontSize: 12 }}>✓</span>}
                  <span style={{ fontSize: 11, fontWeight: 600, color: a ? "#22c55e" : d ? "#555" : "#222" }}>{s.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && <div style={{ background: "#1a0808", border: "1px solid #331111", borderRadius: 4, padding: "12px 16px", marginBottom: 20 }} className="fi"><span style={{ color: "#f87171", fontSize: 12 }}>{error}</span></div>}
      {isRunning && enriched.length === 0 && <div style={{ borderRadius: 5, padding: 28, border: "1px solid #141418" }}>{[75,90,60,85].map((w, i) => <div key={i} className="shim" style={{ height: 13, width: `${w}%`, borderRadius: 3, marginBottom: 10 }} />)}</div>}

      {/* Signals */}
      {signals.length > 0 && (
        <div className="fi" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 10, color: "#444", fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", marginBottom: 8 }}>{signals.length} signals detected</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(175px,1fr))", gap: 8 }}>
            {signals.map((s, i) => {
              const q = qualified.find(c => c.name === s.company);
              return (
                <div key={i} style={{ background: "#0a0a0d", border: `1px solid ${q?.qualified ? "#1e3e2e" : q ? "#3e1e1e" : "#141418"}`, borderRadius: 4, padding: "10px 12px" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#e0e0e0", marginBottom: 3 }}>{s.company}</div>
                  <div style={{ fontSize: 10, color: "#3a3a3a", marginBottom: 4 }}>{s.role_title}</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <Pill color="green">{s.num_openings} roles</Pill>
                    {q?.qualified && <Pill color="green">✓ {q.total_score}/10</Pill>}
                    {q && !q.qualified && <Pill color="red">✗</Pill>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Enriched Cards */}
      {enriched.map((item, i) => {
        const hs = hubspotStatus[item.company.name];
        const isExpanded = expanded === i;
        const tab = tabs[i] || "roi";
        return (
          <div key={i} style={{ background: "#0a0a0d", border: "1px solid #141418", borderRadius: 5, marginBottom: 10, overflow: "hidden" }} className="fi">
            <div onClick={() => setExpanded(isExpanded ? null : i)} style={{ padding: "14px 16px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{item.company.name}</span>
                  <Pill color="green">qualified</Pill>
                  <Pill color="blue">{item.company.estimated_contract_value}</Pill>
                </div>
                <div style={{ fontSize: 11, color: "#3a3a3a" }}>{item.dm.name} · {item.dm.title} · {item.company.employees} emp</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {item.roi?.savings > 0 && <span style={{ fontSize: 16, fontWeight: 700, color: "#22c55e" }}>${Math.round(item.roi.savings / 1000)}K/yr</span>}
                {hubspot && (
                  <button onClick={e => { e.stopPropagation(); pushToHubspot(item); }}
                    disabled={hs === "pushing" || hs === "done"}
                    style={{ padding: "4px 12px", borderRadius: 4, fontSize: 10, fontWeight: 600, border: "1px solid #1e3e2e",
                      background: hs === "done" ? "#0a1a10" : "#0a0a0d",
                      color: hs === "done" ? "#22c55e" : hs === "error" ? "#f87171" : "#22c55e",
                    }}>
                    {hs === "pushing" ? "..." : hs === "done" ? "✓ in HubSpot" : hs === "error" ? "retry" : "→ HubSpot"}
                  </button>
                )}
                <span style={{ color: "#222", transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform .2s" }}>▸</span>
              </div>
            </div>
            {isExpanded && (
              <div style={{ borderTop: "1px solid #111" }}>
                <div style={{ display: "flex", gap: 4, padding: "8px 16px", borderBottom: "1px solid #111" }}>
                  {["roi", "email", "linkedin", "post"].map(t => (
                    <button key={t} onClick={() => setTabs(p => ({ ...p, [i]: t }))} style={{
                      padding: "4px 12px", borderRadius: 3, fontSize: 11, fontWeight: 500, border: "none",
                      background: tab === t ? "#111" : "transparent", color: tab === t ? "#22c55e" : "#3a3a3a",
                    }}>{t === "roi" ? "ROI" : t === "email" ? "Email" : t === "linkedin" ? "LinkedIn DM" : "Post"}</button>
                  ))}
                </div>
                <div style={{ padding: 16 }}>
                  {tab === "roi" && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                      <MetricBox label="Hiring cost" value={`$${Math.round((item.roi?.hiring_annual || 0) / 1000)}K`} color="#f87171" />
                      <MetricBox label="Feather cost" value={`$${Math.round((item.roi?.feather_annual || 0) / 1000)}K`} color="#22c55e" />
                      <MetricBox label="Savings" value={`$${Math.round((item.roi?.savings || 0) / 1000)}K`} sub={`${item.roi?.pct || 0}%`} color="#EF9F27" />
                    </div>
                  )}
                  {tab === "email" && item.outreach?.email && (
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 11, color: "#22c55e" }}>Subject: {item.outreach.email.subject}</span>
                        <CopyBtn text={`Subject: ${item.outreach.email.subject}\n\n${item.outreach.email.body}`} />
                      </div>
                      <pre>{item.outreach.email.body}</pre>
                    </div>
                  )}
                  {tab === "linkedin" && item.outreach?.linkedin && (
                    <div>
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 10, color: "#3a3a3a", fontWeight: 600 }}>CONNECTION NOTE</span>
                          <CopyBtn text={item.outreach.linkedin.note} />
                        </div>
                        <pre style={{ background: "#080810", padding: 10, borderRadius: 3, borderLeft: "2px solid #60a5fa" }}>{item.outreach.linkedin.note}</pre>
                      </div>
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 10, color: "#3a3a3a", fontWeight: 600 }}>FOLLOW-UP</span>
                          <CopyBtn text={item.outreach.linkedin.followup} />
                        </div>
                        <pre style={{ background: "#080810", padding: 10, borderRadius: 3, borderLeft: "2px solid #60a5fa" }}>{item.outreach.linkedin.followup}</pre>
                      </div>
                    </div>
                  )}
                  {tab === "post" && item.outreach?.post && (
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 10, color: "#3a3a3a", fontWeight: 600 }}>LINKEDIN POST</span>
                        <CopyBtn text={item.outreach.post} />
                      </div>
                      <pre style={{ background: "#080810", padding: 14, borderRadius: 3, border: "1px solid #141418", lineHeight: 1.7 }}>{item.outreach.post}</pre>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {stageIdx === 5 && enriched.length > 0 && (
        <Brackets color="#22c55e33" style={{ padding: "18px 24px", marginTop: 20 }}>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
            <Stat label="Scanned" value={signals.length} />
            <Stat label="Qualified" value={enriched.length} />
            <Stat label="Total savings" value={`$${Math.round(enriched.reduce((s, e) => s + (e.roi?.savings || 0), 0) / 1000)}K/yr`} />
            <Stat label="Outreach ready" value={enriched.length} />
          </div>
        </Brackets>
      )}
    </div>
  );
}

/* ═══ ARCHITECTURE PAGE ═══ */
function ArchitecturePage({ n8nUrl }) {
  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "40px 20px" }}>
      <Brackets color="#22c55e33" style={{ padding: "32px 28px", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: "#fff", letterSpacing: "-.02em", marginBottom: 6 }}>System architecture</h1>
            <p style={{ fontSize: 13, color: "#444", maxWidth: 500 }}>3 n8n workflows. 3 human gates. HubSpot as source of truth. Nothing goes out without review.</p>
          </div>
          <a href={n8nUrl} target="_blank" rel="noopener" style={{
            padding: "8px 20px", borderRadius: 5, fontSize: 12, fontWeight: 600,
            background: "#22c55e", color: "#050507", textDecoration: "none", whiteSpace: "nowrap",
          }}>Open n8n →</a>
        </div>
      </Brackets>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 32 }}>
        {[["Signals/day", "6-12", "#22c55e"], ["Pass rate", "~40%", "#a78bfa"], ["Cost/run", "$0.35", "#60a5fa"], ["Human time", "45 min/day", "#EF9F27"]].map(([l, v, c]) => (
          <div key={l} style={{ background: "#0a0a0d", border: "1px solid #141418", borderRadius: 5, padding: "14px 16px", borderTop: `2px solid ${c}` }}>
            <div style={{ fontSize: 9, color: "#3a3a3a", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: c }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Workflows */}
      {WORKFLOWS.map(wf => (
        <div key={wf.id} style={{ marginBottom: 20 }} className="fi">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 6, background: wf.color + "15", border: `1px solid ${wf.color}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: wf.color }}>{wf.id}</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{wf.name}</div>
              <div style={{ fontSize: 10, color: "#3a3a3a", fontFamily: "'IBM Plex Mono',monospace" }}>{wf.trigger}</div>
            </div>
          </div>
          <div style={{ background: "#0a0a0d", border: "1px solid #141418", borderRadius: 5, padding: 14, marginBottom: 6 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {wf.nodes.map((n, j) => (
                <div key={j} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ padding: "6px 12px", borderRadius: 4, background: n.startsWith("Claude") ? "#110d1a" : n.startsWith("IF") ? "#1a1808" : "#081a12",
                    border: `1px solid ${n.startsWith("Claude") ? "#2a1a3a" : n.startsWith("IF") ? "#3a3010" : "#1a3a2a"}`,
                    fontSize: 11, fontWeight: 500, color: n.startsWith("Claude") ? "#a78bfa" : n.startsWith("IF") ? "#EF9F27" : "#22c55e" }}>{n}</div>
                  {j < wf.nodes.length - 1 && <span style={{ color: "#222", fontSize: 12 }}>→</span>}
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "#120e04", border: "1px solid #2a1e08", borderRadius: 4, borderLeft: "3px solid #EF9F27" }}>
            <span style={{ fontSize: 11, color: "#EF9F27" }}>⏸ {wf.gate}</span>
          </div>
        </div>
      ))}

      {/* HubSpot Pipeline */}
      <div style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "#fff", marginBottom: 10 }}>HubSpot deal pipeline</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {["Signal detected", "Qualifying", "▮ Pending review", "ICP approved", "Finding DM", "▮ DM review", "Contact approved", "Gen outreach", "▮ Outreach review", "Sent", "Meeting", "Won"].map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ padding: "4px 8px", borderRadius: 3, fontSize: 10, fontWeight: 500,
                background: s.startsWith("▮") ? "#120e04" : s === "Won" ? "#081a10" : "#0a0a0d",
                color: s.startsWith("▮") ? "#EF9F27" : s === "Won" ? "#22c55e" : "#3a3a3a",
                border: `1px solid ${s.startsWith("▮") ? "#2a1e08" : s === "Won" ? "#1e3e2e" : "#141418"}`,
              }}>{s.replace("▮ ", "")}</div>
              {i < 11 && <span style={{ color: "#1a1a1a", fontSize: 9 }}>→</span>}
            </div>
          ))}
        </div>
      </div>

      {/* ICP Scorecard */}
      <div style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "#fff", marginBottom: 10 }}>ICP scorecard</h2>
        <div style={{ background: "#0a0a0d", border: "1px solid #141418", borderRadius: 5, overflow: "hidden" }}>
          {[["Industry", "Mortgage/lending/insurance/CU = 2"], ["Size", "200-2000 employees = 2, 100-200 = 1"], ["Phone intensity", "5+ openings = 2, some = 1"], ["No AI voice", "No Vapi/Retell/Bland = 2, IVR = 1"], ["Timing", "<14 days or 5+ openings = 2"]].map(([k, v], i) => (
            <div key={i} style={{ display: "flex", padding: "8px 16px", borderBottom: i < 4 ? "1px solid #0d0d10" : "none" }}>
              <div style={{ width: 140, fontSize: 12, fontWeight: 600, color: "#22c55e" }}>{k}</div>
              <div style={{ flex: 1, fontSize: 11, color: "#3a3a3a" }}>{v}</div>
              <div style={{ fontSize: 11, color: "#333", fontFamily: "'IBM Plex Mono',monospace" }}>/2</div>
            </div>
          ))}
          <div style={{ padding: "8px 16px", background: "#060608", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>Threshold</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#22c55e" }}>≥ 6/10</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══ SHARED ═══ */
function Pill({ children, color = "green" }) {
  const c = { green: ["#081a10", "#22c55e", "#1e3e2e"], red: ["#1a0808", "#f87171", "#3e1e1e"], blue: ["#081018", "#60a5fa", "#1e2e4e"], amber: ["#120e04", "#EF9F27", "#2a1e08"] }[color] || ["#081a10", "#22c55e", "#1e3e2e"];
  return <span style={{ display: "inline-block", padding: "1px 7px", borderRadius: 3, fontSize: 9.5, fontWeight: 600, background: c[0], color: c[1], border: `1px solid ${c[2]}` }}>{children}</span>;
}
function MetricBox({ label, value, sub, color }) {
  return <div style={{ background: "#080810", borderRadius: 4, padding: "12px 14px", borderTop: `2px solid ${color}` }}>
    <div style={{ fontSize: 9, color: "#3a3a3a", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
    {sub && <div style={{ fontSize: 10, color: "#333", marginTop: 2 }}>{sub}</div>}
  </div>;
}
function Stat({ label, value }) {
  return <div><div style={{ fontSize: 9, color: "#22c55e", textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</div><div style={{ fontSize: 17, fontWeight: 700, color: "#fff" }}>{value}</div></div>;
}
function CopyBtn({ text }) {
  const [c, setC] = useState(false);
  return <button onClick={() => { navigator.clipboard.writeText(text); setC(true); setTimeout(() => setC(false), 1500); }}
    style={{ background: "#080810", border: "1px solid #1a1a1e", color: c ? "#22c55e" : "#3a3a3a", padding: "2px 8px", borderRadius: 3, fontSize: 10 }}>{c ? "✓" : "copy"}</button>;
}
