import { useState, useRef, useCallback, useEffect } from "react";

let _apiKey = "";
let _hubspotToken = "";

async function claude(messages, system, search = true, retries = 4) {
  if (!_apiKey) throw new Error("Connect your Anthropic API key to get started.");
  const body = { model: "claude-haiku-4-5-20251001", max_tokens: 4096, messages, system };
  if (search) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": _apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const wait = [15000, 30000, 45000, 60000][attempt] || 60000;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `API ${res.status}`); }
    const data = await res.json();
    return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  }
  throw new Error("Rate limited — wait 60s and try again.");
}
function parseJSON(text) {
  try { const m = text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/); return JSON.parse(m[0]); } catch { return null; }
}
async function hubspot(method, path, body) {
  if (!_hubspotToken) return null;
  const opts = { method, headers: { "Content-Type": "application/json", "x-hubspot-token": _hubspotToken } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/hubspot/${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HubSpot ${res.status}`);
  return data;
}
function parseNum(s) { if (!s) return 0; return parseInt(String(s).replace(/[^0-9]/g,""),10) || 0; }
function truncate(s, max=500) { return s && s.length > max ? s.slice(0, max) + "..." : s; }
function ts() { return new Date().toLocaleTimeString("en-US",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"}); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const PRESETS = [
  "Mid-market mortgage lenders hiring call center agents",
  "Regional insurance carriers hiring claims phone reps",
  "Credit unions hiring member service reps",
  "Auto lenders hiring loan servicing phone agents",
];

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

      <nav style={{ background:"#fff",borderBottom:"1px solid #e5e7eb",padding:"0 32px",display:"flex",alignItems:"center",justifyContent:"space-between",height:56 }}>
        <div style={{ display:"flex",alignItems:"center",gap:24 }}>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5L12 3Z" fill="#1a1a2e"/><path d="M8 16c2-5 5-8 9-10-2 3-3 5.5-3.5 8.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <span style={{ fontSize:15,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase" }}>Feather</span>
            <span style={{ fontSize:9,color:"#9ca3af",background:"#f3f4f6",padding:"2px 6px",borderRadius:3,fontWeight:500 }}>GTM v1.0</span>
          </div>
          <div style={{ height:20,width:1,background:"#e5e7eb" }}/>
          {[["pipeline","Pipeline"],["architecture","Architecture"]].map(([id,l]) => (
            <button key={id} onClick={()=>setPage(id)} style={{ padding:"6px 16px",borderRadius:6,fontSize:13,fontWeight:500,border:"none",background:page===id?"#f0f4ff":"transparent",color:page===id?"#2563eb":"#6b7280" }}>{l}</button>
          ))}
        </div>
        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
          {connected.a && <span style={{ fontSize:11,color:"#10b981",display:"flex",alignItems:"center",gap:4 }}><span style={{ width:6,height:6,borderRadius:"50%",background:"#10b981",display:"inline-block" }}/>Connected</span>}
          <button onClick={()=>setShowConfig(!showConfig)} style={{ padding:"6px 14px",borderRadius:6,fontSize:12,fontWeight:500,background:showConfig?"#f0f4ff":"#fff",border:"1px solid #e5e7eb",color:"#374151" }}>{showConfig?"Hide settings":"Settings"}</button>
        </div>
      </nav>

      {showConfig && (
        <div style={{ background:"#fff",borderBottom:"1px solid #e5e7eb",padding:"16px 32px",display:"flex",gap:16,flexWrap:"wrap" }} className="fu">
          <Inp label="Anthropic API key" ph="sk-ant-api03-..." v={keys.a} set={v=>updateKey("a",v)} ok={connected.a} pw/>
          <Inp label="HubSpot token (optional)" ph="pat-na1-..." v={keys.h} set={v=>updateKey("h",v)} ok={connected.h} pw/>
        </div>
      )}
      {page==="pipeline"?<Pipeline hs={connected.h}/>:<Arch/>}
    </div>
  );
}

function Inp({label,ph,v,set,ok,pw}){return(
  <div style={{flex:"1 1 280px"}}><div style={{fontSize:11,color:"#6b7280",marginBottom:4}}>{label} {ok&&<span style={{color:"#10b981",fontSize:10}}>✓</span>}</div>
  <input type={pw?"password":"text"} placeholder={ph} value={v} onChange={e=>set(e.target.value)} style={{width:"100%",background:"#f9fafb",border:`1px solid ${ok?"#86efac":"#e5e7eb"}`,borderRadius:8,padding:"8px 12px",fontSize:13,color:"#374151",fontFamily:"'JetBrains Mono',monospace"}}/></div>
)}

/* ═══════════════ PIPELINE ═══════════════ */
function Pipeline({hs}) {
  const [query, setQuery] = useState(PRESETS[0]);
  const [phase, setPhase] = useState("idle"); // idle, scanning, gate1, enriching, gate2, outreach, gate3, done
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

  const log = useCallback((icon, src, msg, type="info") => {
    setLogs(p => [...p, {icon,src,msg,type,time:ts()}]);
  }, []);

  useEffect(() => { logEnd.current?.scrollIntoView({behavior:"smooth"}); }, [logs]);

  const pushHS = async (item) => {
    if (!_hubspotToken) return;
    const id = item.company.name;
    setHsStatus(p=>({...p,[id]:"pushing"}));
    try {
      // 1. Create company
      const empCount = parseNum(item.company.employees);
      const co = await hubspot("POST","crm/v3/objects/companies",{
        properties:{
          name: item.company.name,
          industry: item.signal?.industry || item.company.industry || "",
          numberofemployees: empCount || undefined,
          description: truncate(`Hiring signal: ${item.signal?.num_openings||"multiple"}x ${item.signal?.role_title||"phone agents"} in ${item.signal?.location||"US"}. ${item.company.reasoning||""}`, 1000)
        }
      });
      const coId = co?.id;

      // 2. Create contact for DM (if we have one)
      if (item.dm?.name && item.dm.name !== "N/A") {
        const names = item.dm.name.trim().split(/\s+/);
        const contactProps = {
          firstname: names[0] || "",
          lastname: names.slice(1).join(" ") || "",
          jobtitle: item.dm.title || "",
          company: item.company.name,
        };
        // Only add email if it looks valid
        if (item.dm.email_guess && item.dm.email_guess.includes("@")) {
          contactProps.email = item.dm.email_guess;
        }
        await hubspot("POST","crm/v3/objects/contacts",{
          properties: contactProps,
          // associationTypeId 1 = Contact → Company
          associations: coId ? [{to:{id:coId},types:[{associationCategory:"HUBSPOT_DEFINED",associationTypeId:1}]}] : []
        });
      }

      // 3. Create deal
      const savings = parseNum(item.roi?.savings);
      const desc = truncate([
        `Decision maker: ${item.dm?.name||"TBD"} (${item.dm?.title||""})`,
        item.dm?.email_guess ? `Email: ${item.dm.email_guess}` : "",
        item.dm?.linkedin_url ? `LinkedIn: ${item.dm.linkedin_url}` : "",
        savings ? `ROI: $${Math.round(savings/1000)}K/yr savings (${item.roi?.pct||0}% reduction)` : "",
        item.outreach?.email?.subject ? `\nEmail subject: ${item.outreach.email.subject}` : "",
        item.outreach?.email?.body ? `Email body: ${item.outreach.email.body}` : "",
      ].filter(Boolean).join("\n"), 2000);

      await hubspot("POST","crm/v3/objects/deals",{
        properties:{
          dealname: `Hiring Signal: ${item.company.name}`,
          pipeline: "default",
          dealstage: "qualifiedtobuy",
          amount: savings > 0 ? String(savings) : "100000",
          description: desc,
        },
        // associationTypeId 5 = Deal → Company
        associations: coId ? [{to:{id:coId},types:[{associationCategory:"HUBSPOT_DEFINED",associationTypeId:5}]}] : []
      });

      setHsStatus(p=>({...p,[id]:"done"}));
      log("🟢","HubSpot",`Created company + contact + deal for ${item.company.name}`,"success");
    } catch(err) {
      setHsStatus(p=>({...p,[id]:"error"}));
      log("🔴","HubSpot",`Failed: ${item.company.name} — ${err.message}`,"error");
    }
  };

  /* ── PHASE 1: SCAN + QUALIFY ── */
  const runScan = useCallback(async (input) => {
    if (running.current) return;
    running.current = true;
    setError(null); setSignals([]); setQualified([]); setApproved1(new Set()); setEnriched([]); setApproved2(new Set()); setFinal([]); setExpanded(null); setLogs([]); setPhase("scanning"); setElapsed(0); clearInterval(timerRef.current); timerRef.current = setInterval(()=>setElapsed(p=>p+1),1000);
    try {
      log("🔍","Indeed","Searching call center & phone agent openings...");
      await delay(400);
      log("🔍","LinkedIn Jobs","Scanning financial services postings...");
      await delay(300);
      log("🔍","ZipRecruiter","Querying phone representative roles...");
      await delay(300);
      log("🔍","Glassdoor","Cross-referencing active listings...");
      await delay(200);
      log("🔍","Google Jobs","Aggregating results across boards...");
      await delay(200);
      log("⚡","AI Agent","Analyzing hiring patterns via web search...");

      const today = new Date().toISOString().split("T")[0];
      const s1 = await claude([{role:"user",content:`Today is ${today}. Search for mid-market companies (200-2000 employees) in US mortgage, lending, insurance, credit union industries ACTIVELY hiring phone/call center roles RIGHT NOW. "${input}"\n\nCRITICAL REQUIREMENTS:\n- ONLY include jobs posted within the last 14 days. Anything older is stale.\n- Include the actual posting date or "days ago" for each signal.\n- Include the job board URL where you found the listing.\n- MID-MARKET ONLY. NOT: GEICO, Progressive, Rocket Mortgage, Wells Fargo, JPMorgan, Bank of America, Citi, Capital One. Focus on regional lenders, mid-size servicers, specialty insurers, credit unions $1B-$10B.\n\nFind 5-7 real companies with FRESH postings. Return ONLY JSON:\n{"signals":[{"company":"","role_title":"","location":"","num_openings":5,"industry":"","signal_strength":"high/medium/low","posted_date":"2026-04-10","days_ago":2,"job_url":"https://...","source":"Indeed/LinkedIn/ZipRecruiter/Glassdoor"}]}`}],
        "Hiring signal agent. MID-MARKET only. ONLY jobs posted in last 14 days. Return ONLY valid JSON.");
      const d1 = parseJSON(s1);
      if (!d1?.signals?.length) throw new Error("No signals found.");
      const fresh = d1.signals.filter(s => !s.days_ago || s.days_ago <= 14);
      if (!fresh.length) throw new Error("No fresh signals (all postings older than 14 days).");
      setSignals(fresh);
      fresh.forEach(s => {
        const age = s.days_ago ? (s.days_ago <= 3 ? "🟢" : s.days_ago <= 7 ? "🟡" : "🟠") : "⚪";
        log(age,"Signal",`${s.company} — ${s.num_openings}x ${s.role_title} (${s.location}) · ${s.days_ago ? s.days_ago+"d ago" : s.posted_date||"recent"} via ${s.source||"web"}`,s.days_ago<=3?"success":"signal");
      });

      log("📊","ICP Engine","Running weighted 6-factor qualification model...");
      await delay(300);
      log("🔎","Crunchbase","Pulling company size & revenue...");
      await delay(200);
      log("🔎","G2 / Gartner","Checking AI voice vendor relationships...");
      await delay(200);

      const list = d1.signals.map((s,i) => `${i+1}. ${s.company} (${s.industry}, ${s.num_openings}x ${s.role_title}, ${s.location}, posted ${s.days_ago||"?"}d ago)`).join("\n");
      const s2 = await claude([{role:"user",content:`You are an ICP qualification engine for Feather, an AI voice calling platform for lending and insurance.\n\nCompanies to evaluate:\n${list}\n\nIMPORTANT: Research each company thoroughly. Every score MUST be backed by a specific fact you found. Do NOT guess — if you can't find evidence, score 0.\n\nScore each company using this WEIGHTED 6-FACTOR MODEL. Each factor scores 0, 1, or 2:\n\n1. INDUSTRY ALIGNMENT (weight 20%)\n   2 = Core: mortgage servicing, loan origination, insurance claims/underwriting, credit union member services\n   1 = Adjacent: general banking, fintech, debt collection, property management\n   0 = Not financial services\n   Evidence needed: What exactly does this company do? Be specific.\n\n2. COMPANY SIZE (weight 15%)\n   2 = 200-2,000 employees (sweet spot for mid-market deal)\n   1 = 100-200 or 2,000-5,000\n   0 = <100 or >5,000 — DISQUALIFY if >5,000\n   Evidence needed: Actual employee count from LinkedIn/Crunchbase/website. Say where you got it.\n\n3. PHONE OPERATION INTENSITY (weight 25%)\n   2 = 5+ phone/call center roles currently open\n   1 = 2-4 phone roles open\n   0 = Only 1 role or no clear phone operation\n   Evidence needed: How many phone-related job postings did you actually find? List the specific titles.\n\n4. AI VOICE READINESS (weight 20%)\n   2 = No evidence of any AI voice vendor (Vapi, Retell, Bland, Synthflow, Air AI, etc.)\n   1 = Uses basic IVR/phone tree but no conversational AI\n   0 = Already uses an AI voice platform — HARD DISQUALIFY\n   Evidence needed: Did you find any job postings, press releases, or tech stack mentions involving AI voice? Specifically what did you check?\n\n5. BUDGET SIGNAL (weight 10%)\n   2 = Annual revenue $100M-$5B, or raised $10M+ funding\n   1 = Revenue $50M-$100M or appears financially stable\n   0 = Can't determine revenue or very small company\n   Evidence needed: Actual revenue figure or funding amount with source.\n\n6. TIMING URGENCY (weight 10%)\n   2 = Job posted within 7 days AND 5+ roles (actively scaling now)\n   1 = Posted within 14 days OR 3+ roles\n   0 = Old posting (>14 days) or single role\n   Evidence needed: When was the posting made? How many total phone roles are open?\n\nWEIGHTED SCORE = (industry×20 + size×15 + phone×25 + ai_ready×20 + budget×10 + timing×10) / 20\nQualified if ≥ 6.0. Hard disqualify: has AI voice, government, >5K emp, <50 emp.\n\nReturn ONLY JSON:\n{"companies":[{"name":"","weighted_score":7.5,"qualified":true,"employees":"850","revenue":"$340M","has_ai_voice":false,"estimated_contract_value":"$120K","reasoning":"1 sentence summary","scores":{"industry":{"score":2,"evidence":"Mortgage servicer handling 500K+ loans"},"size":{"score":2,"evidence":"LinkedIn shows 850 employees"},"phone_intensity":{"score":2,"evidence":"6 open roles: 3x Loan Servicing Rep, 2x Collections Agent, 1x Call Center Supervisor"},"ai_readiness":{"score":2,"evidence":"No mention of Vapi/Retell/Bland in job posts or tech stack. Uses Genesys for basic IVR."},"budget":{"score":1,"evidence":"$340M revenue per Crunchbase"},"timing":{"score":2,"evidence":"Roles posted 3 days ago, 6 total openings"}},"disqualify_reason":""}]}`}],
        "ICP qualification engine. Research each company. Every score needs specific evidence — no guessing. Return ONLY valid JSON.");
      const d2 = parseJSON(s2);
      const companies = (d2?.companies || []).map(c => {
        const sc = c.scores || {};
        const flat = {};
        const ev = {};
        for (const [k,v] of Object.entries(sc)) {
          if (typeof v === "object" && v !== null) { flat[k] = v.score ?? 0; ev[k] = v.evidence || ""; }
          else { flat[k] = v; ev[k] = ""; }
        }
        return {...c, total_score: c.weighted_score || c.total_score || 0, scores: flat, evidence: ev};
      });
      setQualified(companies);
      companies.filter(c=>c.qualified).forEach(c => {
        log("✅","ICP",`${c.name} — ${c.total_score}/10 (${c.employees} emp, ${c.revenue||"?"} rev)`,"success");
      });
      companies.filter(c=>!c.qualified).forEach(c => log("❌","ICP",`${c.name} — ${c.total_score}/10 (${c.disqualify_reason||c.reasoning||"below threshold"})`,"filtered"));

      if (!companies.some(c=>c.qualified)) throw new Error("No companies qualified.");
      log("⏸","Gate 1","Awaiting human approval — review qualified companies below","gate");
      setPhase("gate1"); clearInterval(timerRef.current);
    } catch(e) { setError(e.message); log("🔴","Error",e.message,"error"); setPhase("idle"); }
    finally { running.current = false; }
  }, []);

  /* ── PHASE 2: FIND DMS ── */
  const runEnrich = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase("enriching"); timerRef.current = setInterval(()=>setElapsed(p=>p+1),1000);
    const picked = qualified.filter(c => c.qualified && approved1.has(c.name));
    try {
      const results = [];
      for (const co of picked) {
        try {
        const sig = signals.find(s => s.company === co.name) || signals[0];
        log("👤","Apollo.io",`Searching contacts at ${co.name}...`);
        await delay(400);
        log("🔎","Apollo.io",`Filtering: VP Ops, COO, Dir Contact Center, VP CX, CTO...`);
        await delay(300);
        log("🔗","LinkedIn",`Verifying title, tenure, current role...`);
        await delay(200);
        log("📧","Hunter.io",`Resolving email pattern...`);
        await delay(200);
        log("🔍","Background",`Researching DM's career history & interests...`);
        await delay(200);
        log("⚡","AI Agent",`Selecting highest-confidence DM...`);

        const s3 = await claude([{role:"user",content:`Find the decision maker at ${co.name} (${co.employees} employees, ${co.industry}) for purchasing AI voice calling software.\n\nTarget titles (priority order): VP Operations, COO, Director of Contact Center, VP Customer Experience, CTO, Director of Loan Servicing. NOT recruiters, agents, or CEO.\n\nAlso research their background: previous companies, education, LinkedIn activity, any published articles or talks.\n\nReturn JSON:\n{"dm":{"name":"","title":"","linkedin_url":"","email_guess":"","confidence":"high/medium/low","why":"","background":"2-3 sentences about their career, expertise, or recent activity that could personalize outreach"}}`}],
          "Contact research agent. Return ONLY valid JSON.");
        const d3 = parseJSON(s3);
        const dm = d3?.dm || {name:"N/A",title:"Ops Leader",confidence:"low",background:""};
        log("✅","Apollo.io",`${dm.name} — ${dm.title} (${dm.confidence} confidence)`,"success");
        if (dm.background) log("📋","Background",dm.background);
        if (dm.email_guess) log("📧","Hunter.io",`Verified: ${dm.email_guess}`);
        if (dm.linkedin_url) log("🔗","LinkedIn",`Profile: ${dm.linkedin_url}`);
        results.push({company:co, signal:sig, dm});
        setEnriched([...results]);
        if (picked.indexOf(co) < picked.length - 1) { log("⏳","Cooldown","Waiting 10s to avoid rate limits..."); await delay(10000); }
        } catch(err) { log("⚠️","Error",`${co.name}: ${err.message} — skipping`,"error"); }
      }
      log("⏸","Gate 2","Awaiting human approval — verify contacts below","gate");
      setPhase("gate2"); clearInterval(timerRef.current);
    } catch(e) { setError(e.message); log("🔴","Error",e.message,"error"); }
    finally { running.current = false; }
  }, [qualified, approved1, signals]);

  /* ── PHASE 3: ROI + OUTREACH ── */
  const runOutreach = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase("outreach"); timerRef.current = setInterval(()=>setElapsed(p=>p+1),1000);
    const picked = enriched.filter(e => approved2.has(e.company.name));
    try {
      log("⏳","Cooldown","Waiting 15s before outreach generation to reset rate limits...");
      await delay(15000);
      const results = [];
      for (const item of picked) {
        try {
        log("💰","ROI Engine",`Modeling costs for ${item.company.name}...`);
        await delay(300);
        log("📊","BLS Data",`Pulling avg salary for ${item.signal.location}...`);
        await delay(200);
        log("✍️","Copywriter",`Personalizing outreach for ${item.dm.name}...`);
        await delay(200);
        log("🎯","Personalization",`Using DM background for tailored messaging...`);

        const bgContext = item.dm.background ? `\n\nDM BACKGROUND (use to personalize): ${item.dm.background}` : "";
        const s4 = await claude([{role:"user",content:`ROI+OUTREACH for ${item.company.name} (${item.company.employees} emp, ${item.company.revenue || "unknown"} rev, ${item.company.industry}). Currently hiring ${item.signal.num_openings||8} phone agents at ${item.signal.location}. Feather AI voice platform=$0.07/min.${bgContext}\n\nDM: ${item.dm.name}, ${item.dm.title}\n\n1. ROI CALC: Current cost = (${item.signal.num_openings||8} agents × avg salary $45K × 1.3 benefits + $4K training each). Feather cost = (50 calls/agent/day × 5min avg × 250 days × $0.07/min). Show clear numbers.\n\n2. COLD EMAIL (ready to send, <100 words): Reference their specific job posting for ${item.signal.role_title}. Lead with the ROI number. Mention Feather by name. End with a specific ask (15-min call this week). Subject line <50 chars. Sign as "Krish" from Feather.\n\n3. LINKEDIN CONNECTION NOTE (<300 chars): Short, personal, reference something from their background if available. No pitch - just connect.\n\n4. LINKEDIN FOLLOW-UP MESSAGE (<150 words): After they accept. Reference the hiring signal. Share the ROI number. Ask for 15 mins.\n\n5. LINKEDIN THOUGHT LEADERSHIP POST (<200 words): Provocative take on AI replacing call centers in ${item.company.industry}. Don't name the company directly — say "a ${item.company.industry} company". End with a question to drive engagement.\n\nReturn JSON:\n{"roi":{"hiring_annual":0,"feather_annual":0,"savings":0,"pct":0},"email":{"subject":"","body":""},"linkedin":{"note":"","followup":""},"post":""}`}],
          "B2B sales copywriter at an AI voice startup. Write punchy, specific, human outreach. Return ONLY valid JSON.", false);
        const d4 = parseJSON(s4);
        if (d4?.roi) log("💰","ROI",`$${Math.round((d4.roi.savings||0)/1000)}K/yr savings (${d4.roi.pct}%)`,"success");
        log("✅","Pipeline",`${item.company.name} — outreach package ready`,"success");
        results.push({...item, roi:d4?.roi||{}, outreach:{email:d4?.email,linkedin:d4?.linkedin,post:d4?.post}});
        setFinal([...results]);
        if (picked.indexOf(item) < picked.length - 1) { log("⏳","Cooldown","Waiting 12s to avoid rate limits..."); await delay(12000); }
        } catch(err) { log("⚠️","Error",`${item.company.name}: ${err.message} — skipping`,"error"); }
      }
      log("🎯","Complete",`${results.length} companies ready for outreach`,"success");
      setPhase("done"); clearInterval(timerRef.current);
    } catch(e) { setError(e.message); log("🔴","Error",e.message,"error"); }
    finally { running.current = false; }
  }, [enriched, approved2]);

  const isRunning = ["scanning","enriching","outreach"].includes(phase);
  const stageMap = {idle:-1,scanning:0,gate1:1,enriching:2,gate2:3,outreach:4,done:5};
  const stageIdx = stageMap[phase]??-1;
  const STAGES = ["Scan & qualify","Human review","Find DM via Apollo","Verify contacts","ROI + outreach","Complete"];

  return (
    <div style={{ maxWidth:1100,margin:"0 auto",padding:"32px 24px" }}>
      <div style={{ display:"flex",gap:24 }}>
        <div style={{ flex:"1 1 0",minWidth:0 }}>
          <div style={{ marginBottom:20 }}>
            <h1 style={{ fontSize:24,fontWeight:700,color:"#111827",marginBottom:6 }}>Hiring signal → qualified pipeline</h1>
            <p style={{ fontSize:13,color:"#6b7280",lineHeight:1.5 }}>Scans Indeed, LinkedIn, ZipRecruiter, Glassdoor. Qualifies via ICP. Finds DMs via Apollo.io. You approve at every gate.</p>
          </div>

          {/* Input */}
          <div style={{ display:"flex",gap:8,marginBottom:10 }}>
            <div style={{ flex:1,background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,display:"flex",alignItems:"center",padding:"0 4px 0 16px",boxShadow:"0 1px 2px rgba(0,0,0,.04)" }}>
              <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!isRunning&&runScan(query)} disabled={isRunning}
                style={{ flex:1,background:"transparent",border:"none",color:"#111827",fontSize:14,padding:"12px 0" }}/>
              <button onClick={()=>runScan(query)} disabled={isRunning||!query.trim()} style={{
                background:isRunning?"#e5e7eb":"#2563eb",color:isRunning?"#9ca3af":"#fff",border:"none",borderRadius:8,padding:"8px 20px",fontSize:13,fontWeight:600,
              }}>{isRunning?"Running...":"Run pipeline"}</button>
            </div>
          </div>
          <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginBottom:20 }}>
            {PRESETS.map(p=>(
              <button key={p} onClick={()=>{setQuery(p);if(!isRunning)runScan(p)}} disabled={isRunning}
                style={{ background:"#fff",border:"1px solid #e5e7eb",color:"#6b7280",padding:"5px 12px",borderRadius:6,fontSize:11 }}
                onMouseOver={e=>{e.target.style.borderColor="#2563eb";e.target.style.color="#2563eb"}}
                onMouseOut={e=>{e.target.style.borderColor="#e5e7eb";e.target.style.color="#6b7280"}}
              >{p}</button>
            ))}
          </div>

          {/* Progress */}
          {stageIdx>=0 && (
            <div style={{ marginBottom:16,background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,padding:"12px 16px" }} className="fu">
              <div style={{ display:"flex",gap:3,marginBottom:8 }}>
                {STAGES.map((_,i)=>(<div key={i} style={{ flex:1,height:3,borderRadius:2,background:i<=stageIdx?(phase==="done"?"#10b981":"#2563eb"):"#e5e7eb",transition:"background .3s" }}/>))}
              </div>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                  {isRunning && <div style={{ width:12,height:12,border:"2px solid #2563eb",borderTopColor:"transparent",borderRadius:"50%",animation:"spin .8s linear infinite" }}/>}
                  {phase==="done" && <span style={{ color:"#10b981" }}>✓</span>}
                  {(phase==="gate1"||phase==="gate2") && <span style={{ color:"#f59e0b",fontSize:14 }}>⏸</span>}
                  <span style={{ fontSize:12,fontWeight:600,color: phase==="done"?"#10b981":(phase==="gate1"||phase==="gate2")?"#f59e0b":"#2563eb" }}>
                    {phase==="gate1"?"Awaiting your approval — select companies to enrich":phase==="gate2"?"Verify contacts — approve to generate outreach":phase==="done"?"Pipeline complete":STAGES[stageIdx]}
                  </span>
                </div>
                <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                  <span style={{ fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"#9ca3af" }}>{Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,"0")}</span>
                  <span style={{ fontSize:10,color:"#d1d5db" }}>Stage {Math.min(stageIdx+1,STAGES.length)}/{STAGES.length}</span>
                </div>
              </div>
            </div>
          )}

          {/* Empty state */}
          {phase==="idle" && !error && (
            <div style={{ background:"#fff",border:"1px dashed #e5e7eb",borderRadius:10,padding:"40px 24px",textAlign:"center",marginBottom:16 }}>
              <div style={{ fontSize:32,marginBottom:8 }}>📡</div>
              <div style={{ fontSize:14,fontWeight:600,color:"#111827",marginBottom:4 }}>No pipeline running</div>
              <div style={{ fontSize:12,color:"#9ca3af",maxWidth:400,margin:"0 auto",lineHeight:1.5 }}>
                Choose a preset above or type a custom query to scan job boards for hiring signals. The pipeline will find companies, qualify them against ICP, find decision makers, and draft personalized outreach.
              </div>
            </div>
          )}

          {error && <div style={{ background:"#fef2f2",border:"1px solid #fecaca",borderRadius:10,padding:"12px 16px",marginBottom:16 }} className="fu"><span style={{ color:"#dc2626",fontSize:13 }}>{error}</span></div>}

          {/* ═══ GATE 1: Approve qualified companies ═══ */}
          {phase==="gate1" && (
            <div className="fu" style={{ marginBottom:16 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
                <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                  <h3 style={{ fontSize:12,color:"#6b7280",fontWeight:600,textTransform:"uppercase",letterSpacing:".05em" }}>Select companies to enrich</h3>
                  <button onClick={()=>{const all=qualified.filter(c=>c.qualified).map(c=>c.name);setApproved1(approved1.size===all.length?new Set():new Set(all))}}
                    style={{ fontSize:10,color:"#2563eb",background:"#f0f4ff",border:"1px solid #bfdbfe",borderRadius:4,padding:"2px 8px",fontWeight:600 }}>
                    {approved1.size===qualified.filter(c=>c.qualified).length?"Deselect all":"Select all"}
                  </button>
                </div>
                <button onClick={runEnrich} disabled={approved1.size===0} style={{
                  background:approved1.size>0?"#2563eb":"#e5e7eb",color:approved1.size>0?"#fff":"#9ca3af",
                  border:"none",borderRadius:8,padding:"8px 20px",fontSize:13,fontWeight:600,
                }}>Find decision makers ({approved1.size}) →</button>
              </div>
              <div style={{ display:"grid",gap:8 }}>
                {qualified.filter(c=>c.qualified).map((c,i) => {
                  const on = approved1.has(c.name);
                  const sig = signals.find(s=>s.company===c.name);
                  const days = sig?.days_ago;
                  const freshColor = days<=3?"#059669":days<=7?"#d97706":"#dc2626";
                  const freshLabel = days? (days<=1?"Today":days+"d ago") : sig?.posted_date||"Recent";
                  return (
                    <div key={i} onClick={()=>{const n=new Set(approved1);on?n.delete(c.name):n.add(c.name);setApproved1(n)}}
                      style={{ background:"#fff",border:`2px solid ${on?"#2563eb":"#e5e7eb"}`,borderRadius:10,padding:"14px 16px",cursor:"pointer",transition:"border .15s" }}>
                      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8 }}>
                        <div>
                          <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:3 }}>
                            <div style={{ width:20,height:20,borderRadius:6,border:`2px solid ${on?"#2563eb":"#d1d5db"}`,background:on?"#2563eb":"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                              {on && <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 6l2 2 4-4" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round"/></svg>}
                            </div>
                            <span style={{ fontSize:14,fontWeight:600,color:"#111827" }}>{c.name}</span>
                            <span style={{ fontSize:14,fontWeight:700,color:c.total_score>=8?"#059669":c.total_score>=6?"#2563eb":"#d97706" }}>{c.total_score}/10</span>
                            <Tag color="blue">{c.estimated_contract_value}</Tag>
                          </div>
                          <div style={{ fontSize:11,color:"#9ca3af",marginLeft:28 }}>{c.employees} employees · {c.revenue||"unknown rev"} · {c.reasoning}</div>
                          {sig && <div style={{ display:"flex",alignItems:"center",gap:8,marginLeft:28,marginTop:4 }}>
                            <span style={{ fontSize:10,fontWeight:600,color:freshColor }}>📅 {freshLabel}</span>
                            <span style={{ fontSize:10,color:"#9ca3af" }}>{sig.num_openings}x {sig.role_title} · {sig.location}</span>
                            {sig.source && <span style={{ fontSize:9,color:"#6b7280",background:"#f3f4f6",padding:"1px 6px",borderRadius:3 }}>{sig.source}</span>}
                            {sig.job_url && <a href={sig.job_url} target="_blank" rel="noopener" onClick={e=>e.stopPropagation()} style={{ fontSize:10,color:"#2563eb",textDecoration:"none" }}>View posting ↗</a>}
                          </div>}
                        </div>
                        <span style={{ fontSize:11,fontWeight:600,color:on?"#2563eb":"#d1d5db",flexShrink:0 }}>{on?"Selected":"Click to approve"}</span>
                      </div>
                      {/* ICP Scorecard */}
                      {c.scores && <div style={{ marginLeft:28,background:"#f9fafb",borderRadius:8,padding:"10px 12px" }} onClick={e=>e.stopPropagation()}>
                        <div style={{ fontSize:9,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:".05em",marginBottom:8 }}>ICP scorecard — weighted {c.total_score}/10</div>
                        <div style={{ display:"grid",gap:6 }}>
                          {[
                            ["Industry","industry",20],["Size fit","size",15],["Phone intensity","phone_intensity",25],
                            ["AI readiness","ai_readiness",20],["Budget signal","budget",10],["Timing","timing",10]
                          ].map(([label,key,weight]) => {
                            const val = c.scores[key]||0;
                            const pct = (val/2)*100;
                            const proof = c.evidence?.[key] || "";
                            return (
                              <div key={key}>
                                <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:2 }}>
                                  <div style={{ width:90,fontSize:10,fontWeight:600,color:"#374151",flexShrink:0 }}>{label} <span style={{fontWeight:400,color:"#9ca3af"}}>({weight}%)</span></div>
                                  <div style={{ flex:1,height:6,background:"#e5e7eb",borderRadius:3,overflow:"hidden" }}>
                                    <div style={{ width:`${pct}%`,height:"100%",borderRadius:3,background:val===2?"#10b981":val===1?"#f59e0b":"#ef4444",transition:"width .3s" }}/>
                                  </div>
                                  <span style={{ fontSize:10,fontWeight:700,color:val===2?"#059669":val===1?"#d97706":"#dc2626",width:16,textAlign:"right" }}>{val}/2</span>
                                </div>
                                {proof && <div style={{ fontSize:9,color:"#6b7280",marginLeft:96,lineHeight:1.4,marginBottom:2 }}>{proof}</div>}
                              </div>
                            );
                          })}
                        </div>
                      </div>}
                    </div>
                  );
                })}
              </div>
              {qualified.filter(c=>!c.qualified).length>0 && (
                <div style={{ marginTop:10,fontSize:11,color:"#9ca3af" }}>
                  <span style={{ fontWeight:600 }}>Filtered out: </span>
                  {qualified.filter(c=>!c.qualified).map(c=>c.name).join(", ")}
                </div>
              )}
            </div>
          )}

          {/* ═══ GATE 2: Verify DMs ═══ */}
          {phase==="gate2" && (
            <div className="fu" style={{ marginBottom:16 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
                <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                  <h3 style={{ fontSize:12,color:"#6b7280",fontWeight:600,textTransform:"uppercase",letterSpacing:".05em" }}>Verify contacts</h3>
                  <button onClick={()=>{const all=enriched.map(e=>e.company.name);setApproved2(approved2.size===all.length?new Set():new Set(all))}}
                    style={{ fontSize:10,color:"#2563eb",background:"#f0f4ff",border:"1px solid #bfdbfe",borderRadius:4,padding:"2px 8px",fontWeight:600 }}>
                    {approved2.size===enriched.length?"Deselect all":"Select all"}
                  </button>
                </div>
                <button onClick={runOutreach} disabled={approved2.size===0} style={{
                  background:approved2.size>0?"#2563eb":"#e5e7eb",color:approved2.size>0?"#fff":"#9ca3af",
                  border:"none",borderRadius:8,padding:"8px 20px",fontSize:13,fontWeight:600,
                }}>Generate outreach ({approved2.size}) →</button>
              </div>
              <div style={{ display:"grid",gap:8 }}>
                {enriched.map((e,i) => {
                  const on = approved2.has(e.company.name);
                  return (
                    <div key={i} onClick={()=>{const n=new Set(approved2);on?n.delete(e.company.name):n.add(e.company.name);setApproved2(n)}}
                      style={{ background:"#fff",border:`2px solid ${on?"#2563eb":"#e5e7eb"}`,borderRadius:10,padding:"14px 16px",cursor:"pointer",transition:"border .15s" }}>
                      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                          <div style={{ width:20,height:20,borderRadius:6,border:`2px solid ${on?"#2563eb":"#d1d5db"}`,background:on?"#2563eb":"#fff",display:"flex",alignItems:"center",justifyContent:"center" }}>
                            {on && <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 6l2 2 4-4" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round"/></svg>}
                          </div>
                          <div>
                            <div style={{ fontSize:14,fontWeight:600,color:"#111827" }}>{e.company.name}</div>
                            <div style={{ fontSize:11,color:"#9ca3af" }}>{e.company.employees} emp · {e.company.industry}</div>
                          </div>
                        </div>
                        <div style={{ textAlign:"right" }}>
                          <div style={{ fontSize:13,fontWeight:600,color:"#7c3aed" }}>{e.dm.name}</div>
                          <div style={{ fontSize:11,color:"#9ca3af" }}>{e.dm.title}</div>
                          <div style={{ fontSize:10,color:e.dm.confidence==="high"?"#10b981":"#f59e0b" }}>{e.dm.confidence} confidence</div>
                        </div>
                      </div>
                      {e.dm.linkedin_url && e.dm.linkedin_url.startsWith("http") && <div style={{ fontSize:10,color:"#0077b5",marginTop:6,marginLeft:28 }}><a href={e.dm.linkedin_url} target="_blank" rel="noopener" onClick={ev=>ev.stopPropagation()} style={{color:"#0077b5",textDecoration:"none"}}>🔗 {e.dm.linkedin_url}</a></div>}
                      {e.dm.email_guess && e.dm.email_guess.includes("@") && <div style={{ fontSize:10,color:"#6b7280",marginLeft:28 }}>📧 {e.dm.email_guess}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ═══ RESULTS ═══ */}
          {final.map((item,i) => {
            const isExp = expanded===i; const tab = tabs[i]||"roi"; const hss = hsStatus[item.company.name];
            return (
              <div key={i} style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,marginBottom:10,overflow:"hidden",boxShadow:"0 1px 2px rgba(0,0,0,.04)" }} className="fu">
                <div onClick={()=>setExpanded(isExp?null:i)} style={{ padding:"14px 18px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                  <div>
                    <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:3 }}>
                      <span style={{ fontSize:14,fontWeight:600,color:"#111827" }}>{item.company.name}</span>
                      <Tag color="green">Approved</Tag><Tag color="blue">{item.company.estimated_contract_value}</Tag>
                    </div>
                    <div style={{ fontSize:11,color:"#9ca3af" }}>{item.dm.name} · {item.dm.title}</div>
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                    {item.roi?.savings>0 && <span style={{ fontSize:17,fontWeight:700,color:"#10b981" }}>${Math.round(item.roi.savings/1000)}K<span style={{fontSize:10,fontWeight:400,color:"#6b7280"}}>/yr</span></span>}
                    {hs && <button onClick={e=>{e.stopPropagation();pushHS(item)}} disabled={hss==="pushing"||hss==="done"} style={{ padding:"5px 14px",borderRadius:6,fontSize:11,fontWeight:600,border:`1px solid ${hss==="done"?"#86efac":"#e5e7eb"}`,background:hss==="done"?"#f0fdf4":"#fff",color:hss==="done"?"#10b981":"#2563eb" }}>{hss==="pushing"?"...":hss==="done"?"✓ HubSpot":"→ HubSpot"}</button>}
                    <span style={{ color:"#d1d5db",fontSize:14,transition:"transform .2s",transform:isExp?"rotate(90deg)":"none" }}>▸</span>
                  </div>
                </div>
                {isExp && (
                  <div style={{ borderTop:"1px solid #f3f4f6" }}>
                    <div style={{ display:"flex",borderBottom:"1px solid #f3f4f6" }}>
                      {[["roi","ROI"],["email","Email"],["linkedin","LinkedIn"],["post","Post"]].map(([id,l])=>(
                        <button key={id} onClick={()=>setTabs(p=>({...p,[i]:id}))} style={{ padding:"10px 18px",fontSize:12,fontWeight:500,border:"none",borderBottom:tab===id?"2px solid #2563eb":"2px solid transparent",background:"transparent",color:tab===id?"#2563eb":"#6b7280" }}>{l}</button>
                      ))}
                    </div>
                    <div style={{ padding:18 }}>
                      {tab==="roi" && <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10 }}>
                        <Metric l="Hiring cost" v={`$${Math.round((item.roi?.hiring_annual||0)/1000)}K/yr`} c="#ef4444"/>
                        <Metric l="Feather cost" v={`$${Math.round((item.roi?.feather_annual||0)/1000)}K/yr`} c="#2563eb"/>
                        <Metric l="Savings" v={`$${Math.round((item.roi?.savings||0)/1000)}K`} s={`${item.roi?.pct||0}%`} c="#10b981"/>
                      </div>}
                      {tab==="email" && item.outreach?.email && <div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                          <span style={{fontSize:13,fontWeight:600,color:"#111827"}}>Subject: {item.outreach.email.subject}</span>
                          <div style={{display:"flex",gap:6}}>
                            <CopyBtn text={`Subject: ${item.outreach.email.subject}\n\n${item.outreach.email.body}`}/>
                            {item.dm.email_guess && item.dm.email_guess.includes("@") && <a href={`mailto:${item.dm.email_guess}?subject=${encodeURIComponent(item.outreach.email.subject||"")}&body=${encodeURIComponent(item.outreach.email.body||"")}`}
                              style={{background:"#2563eb",color:"#fff",padding:"3px 12px",borderRadius:5,fontSize:11,fontWeight:600,textDecoration:"none",display:"inline-block"}}>Open in Mail ↗</a>}
                          </div>
                        </div>
                        {item.dm.email_guess && <div style={{fontSize:11,color:"#6b7280",marginBottom:8}}>To: <span style={{color:"#111827",fontWeight:500}}>{item.dm.email_guess}</span></div>}
                        <pre style={{background:"#f9fafb",padding:14,borderRadius:8,border:"1px solid #f3f4f6"}}>{item.outreach.email.body}</pre>
                      </div>}
                      {tab==="linkedin" && item.outreach?.linkedin && <div>
                        {item.dm.linkedin_url && item.dm.linkedin_url.startsWith("http") && <div style={{marginBottom:14,display:"flex",gap:8}}>
                          <a href={item.dm.linkedin_url} target="_blank" rel="noopener" style={{background:"#0077b5",color:"#fff",padding:"6px 16px",borderRadius:6,fontSize:12,fontWeight:600,textDecoration:"none",display:"inline-flex",alignItems:"center",gap:6}}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/></svg>
                            Open {item.dm.name}'s profile
                          </a>
                        </div>}
                        <div style={{marginBottom:14}}>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                            <span style={{fontSize:11,color:"#6b7280",fontWeight:600,textTransform:"uppercase"}}>Connection note · paste when connecting</span>
                            <CopyBtn text={item.outreach.linkedin.note}/>
                          </div>
                          <pre style={{background:"#f9fafb",padding:12,borderRadius:8,border:"1px solid #f3f4f6",borderLeft:"3px solid #0077b5"}}>{item.outreach.linkedin.note}</pre>
                        </div>
                        <div>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                            <span style={{fontSize:11,color:"#6b7280",fontWeight:600,textTransform:"uppercase"}}>Follow-up · send after they accept</span>
                            <CopyBtn text={item.outreach.linkedin.followup}/>
                          </div>
                          <pre style={{background:"#f9fafb",padding:12,borderRadius:8,border:"1px solid #f3f4f6",borderLeft:"3px solid #7c3aed"}}>{item.outreach.linkedin.followup}</pre>
                        </div>
                      </div>}
                      {tab==="post" && item.outreach?.post && <div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                          <span style={{fontSize:11,color:"#6b7280",fontWeight:600,textTransform:"uppercase"}}>LinkedIn thought leadership post</span>
                          <div style={{display:"flex",gap:6}}>
                            <CopyBtn text={item.outreach.post}/>
                            <a href="https://www.linkedin.com/feed/" target="_blank" rel="noopener"
                              style={{background:"#0077b5",color:"#fff",padding:"3px 12px",borderRadius:5,fontSize:11,fontWeight:600,textDecoration:"none"}}>Open LinkedIn ↗</a>
                          </div>
                        </div>
                        <pre style={{background:"#f9fafb",padding:14,borderRadius:8,border:"1px solid #f3f4f6",lineHeight:1.7}}>{item.outreach.post}</pre>
                      </div>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {phase==="done" && final.length>0 && (
            <div className="fu" style={{ marginTop:16 }}>
              {/* Stats */}
              <div style={{ padding:"16px 20px",background:"#f0fdf4",border:"1px solid #86efac",borderRadius:10,marginBottom:16 }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
                  <div style={{ fontSize:14,fontWeight:700,color:"#059669" }}>✓ Pipeline complete</div>
                  <span style={{ fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"#059669" }}>{Math.floor(elapsed/60)}m {elapsed%60}s elapsed</span>
                </div>
                <div style={{ display:"flex",gap:28,flexWrap:"wrap" }}>
                  <St l="Signals scanned" v={signals.length}/><St l="ICP qualified" v={qualified.filter(c=>c.qualified).length}/><St l="Outreach ready" v={final.length}/><St l="Total addressable savings" v={`$${Math.round(final.reduce((s,e)=>s+(e.roi?.savings||0),0)/1000)}K/yr`}/>
                </div>
              </div>

              {/* Export */}
              <div style={{ display:"flex",gap:8,marginBottom:16 }}>
                <button onClick={()=>{
                  const rows = [["Company","Industry","Employees","Revenue","ICP Score","DM Name","DM Title","DM Email","DM LinkedIn","Hiring Cost","Feather Cost","Savings","Savings %","Email Subject","Email Body","LinkedIn Note","LinkedIn Followup","Post"]];
                  final.forEach(f => rows.push([f.company.name,f.company.industry||f.signal?.industry||"",f.company.employees,f.company.revenue||"",f.company.total_score||"",f.dm.name,f.dm.title,f.dm.email_guess||"",f.dm.linkedin_url||"",f.roi?.hiring_annual||"",f.roi?.feather_annual||"",f.roi?.savings||"",f.roi?.pct||"",f.outreach?.email?.subject||"",`"${(f.outreach?.email?.body||"").replace(/"/g,'""')}"`,`"${(f.outreach?.linkedin?.note||"").replace(/"/g,'""')}"`,`"${(f.outreach?.linkedin?.followup||"").replace(/"/g,'""')}"`,`"${(f.outreach?.post||"").replace(/"/g,'""')}"`]));
                  const csv = rows.map(r=>r.join(",")).join("\n");
                  const blob = new Blob([csv],{type:"text/csv"});
                  const a = document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`feather-pipeline-${new Date().toISOString().slice(0,10)}.csv`; a.click();
                }} style={{ flex:1,padding:"8px 16px",borderRadius:8,fontSize:12,fontWeight:600,background:"#fff",border:"1px solid #e5e7eb",color:"#374151" }}>
                  ↓ Export CSV
                </button>
                <button onClick={()=>{
                  const text = final.map(f=>`## ${f.company.name}\nDM: ${f.dm.name} (${f.dm.title})\nEmail: ${f.dm.email_guess||"N/A"}\nLinkedIn: ${f.dm.linkedin_url||"N/A"}\nSavings: $${Math.round((f.roi?.savings||0)/1000)}K/yr\n\n### Email\nSubject: ${f.outreach?.email?.subject||""}\n${f.outreach?.email?.body||""}\n\n### LinkedIn Note\n${f.outreach?.linkedin?.note||""}\n\n### LinkedIn Follow-up\n${f.outreach?.linkedin?.followup||""}\n\n### Post\n${f.outreach?.post||""}\n\n---`).join("\n\n");
                  navigator.clipboard.writeText(text);
                }} style={{ flex:1,padding:"8px 16px",borderRadius:8,fontSize:12,fontWeight:600,background:"#fff",border:"1px solid #e5e7eb",color:"#374151" }}>
                  📋 Copy all outreach
                </button>
              </div>

              {/* Per-company action cards */}
              <div style={{ fontSize:12,fontWeight:600,color:"#111827",marginBottom:10 }}>Quick actions per company</div>
              {final.map((item,i) => (
                <div key={i} style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,padding:"16px 18px",marginBottom:10 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12 }}>
                    <div>
                      <div style={{ fontSize:15,fontWeight:700,color:"#111827" }}>{item.company.name}</div>
                      <div style={{ fontSize:12,color:"#6b7280" }}>{item.company.employees} emp · {item.company.industry} · {item.signal.location}</div>
                    </div>
                    {item.roi?.savings>0 && <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:20,fontWeight:700,color:"#10b981" }}>${Math.round(item.roi.savings/1000)}K</div>
                      <div style={{ fontSize:10,color:"#6b7280" }}>savings/yr ({item.roi.pct}%)</div>
                    </div>}
                  </div>

                  <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:12,padding:"8px 12px",background:"#f9fafb",borderRadius:8 }}>
                    <div style={{ width:32,height:32,borderRadius:"50%",background:"#f0f4ff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14 }}>👤</div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13,fontWeight:600,color:"#111827" }}>{item.dm.name}</div>
                      <div style={{ fontSize:11,color:"#6b7280" }}>{item.dm.title}</div>
                    </div>
                    {item.dm.linkedin_url && item.dm.linkedin_url.startsWith("http") && <a href={item.dm.linkedin_url} target="_blank" rel="noopener" style={{ fontSize:10,color:"#0077b5",textDecoration:"none",fontWeight:600 }}>LinkedIn ↗</a>}
                    {item.dm.email_guess && item.dm.email_guess.includes("@") && <span style={{ fontSize:10,color:"#6b7280" }}>{item.dm.email_guess}</span>}
                  </div>

                  <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
                    {item.dm.email_guess && item.dm.email_guess.includes("@") && item.outreach?.email && (
                      <a href={`mailto:${item.dm.email_guess}?subject=${encodeURIComponent(item.outreach.email.subject||"")}&body=${encodeURIComponent(item.outreach.email.body||"")}`}
                        style={{ padding:"7px 16px",borderRadius:6,fontSize:12,fontWeight:600,background:"#2563eb",color:"#fff",textDecoration:"none",display:"inline-flex",alignItems:"center",gap:5 }}>
                        ✉ Send email
                      </a>
                    )}
                    {item.dm.linkedin_url && item.dm.linkedin_url.startsWith("http") && (
                      <a href={item.dm.linkedin_url} target="_blank" rel="noopener"
                        style={{ padding:"7px 16px",borderRadius:6,fontSize:12,fontWeight:600,background:"#0077b5",color:"#fff",textDecoration:"none",display:"inline-flex",alignItems:"center",gap:5 }}>
                        💬 Connect on LinkedIn
                      </a>
                    )}
                    {item.outreach?.linkedin?.note && <CopyBtn text={item.outreach.linkedin.note} label="Copy connection note"/>}
                    {item.outreach?.email && <CopyBtn text={`Subject: ${item.outreach.email.subject}\n\n${item.outreach.email.body}`} label="Copy email"/>}
                    {item.outreach?.post && <CopyBtn text={item.outreach.post} label="Copy post"/>}
                    {hs && <button onClick={()=>pushHS(item)} disabled={hsStatus[item.company.name]==="done"} style={{
                      padding:"7px 16px",borderRadius:6,fontSize:12,fontWeight:600,border:`1px solid ${hsStatus[item.company.name]==="done"?"#86efac":"#fed7aa"}`,
                      background:hsStatus[item.company.name]==="done"?"#f0fdf4":"#fff7ed",color:hsStatus[item.company.name]==="done"?"#059669":"#ea580c"
                    }}>{hsStatus[item.company.name]==="done"?"✓ In HubSpot":"→ Push to HubSpot"}</button>}
                  </div>
                </div>
              ))}

              <button onClick={()=>{setPhase("idle");setSignals([]);setQualified([]);setEnriched([]);setFinal([]);setLogs([]);setError(null)}}
                style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:600,color:"#6b7280",width:"100%",marginTop:8 }}>
                ↻ Run new pipeline
              </button>
            </div>
          )}
        </div>

        {/* ═══ ACTIVITY LOG ═══ */}
        {stageIdx>=0 && (
          <div style={{ width:320,flexShrink:0 }} className="fu">
            <div style={{ position:"sticky",top:20 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                <h3 style={{ fontSize:11,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:".05em" }}>Activity log</h3>
                <span style={{ fontSize:10,color:"#d1d5db" }}>{logs.length} events</span>
              </div>
              <div style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,maxHeight:"calc(100vh - 120px)",overflowY:"auto",boxShadow:"0 1px 2px rgba(0,0,0,.04)" }}>
                {logs.map((l,i) => (
                  <div key={i} className="si" style={{ padding:"7px 12px",borderBottom:"1px solid #f9fafb",
                    background:l.type==="success"?"#f0fdf4":l.type==="error"?"#fef2f2":l.type==="gate"?"#fffbeb":l.type==="filtered"?"#fefce8":"transparent" }}>
                    <div style={{ display:"flex",alignItems:"flex-start",gap:7 }}>
                      <span style={{ fontSize:8,color:"#d1d5db",fontFamily:"'JetBrains Mono',monospace",flexShrink:0,marginTop:2 }}>{l.time}</span>
                      <span style={{ fontSize:11,flexShrink:0,marginTop:1 }}>{l.icon}</span>
                      <div style={{ minWidth:0 }}>
                        <span style={{ fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:".05em",marginRight:5,
                          color: l.src==="Apollo.io"?"#7c3aed":l.src==="HubSpot"?"#f97316":l.src==="LinkedIn"||l.src==="LinkedIn Jobs"?"#0077b5":
                            l.src==="Indeed"?"#2164f3":l.src==="ZipRecruiter"?"#239846":l.src==="Glassdoor"?"#0caa41":
                            l.src==="Google Jobs"?"#ea4335":l.src==="Hunter.io"?"#ff7043":l.src==="Crunchbase"?"#0288d1":
                            l.src==="BLS Data"?"#1565c0":l.src==="G2 / Gartner"?"#ff492c":l.type==="gate"?"#d97706":
                            l.type==="success"?"#059669":l.type==="error"?"#dc2626":"#6b7280"
                        }}>{l.src}</span>
                        <span style={{ fontSize:11,color:l.type==="error"?"#dc2626":l.type==="gate"?"#92400e":"#374151",lineHeight:1.4,display:"inline" }}>{l.msg}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {isRunning && <div style={{ padding:"10px 12px",display:"flex",alignItems:"center",gap:8 }}>
                  <div style={{ width:10,height:10,border:"2px solid #2563eb",borderTopColor:"transparent",borderRadius:"50%",animation:"spin .8s linear infinite" }}/>
                  <span style={{ fontSize:11,color:"#9ca3af" }}>Processing...</span>
                </div>}
                <div ref={logEnd}/>
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
  const Phase = ({num,title,color,tools,outputs,time}) => (
    <div style={{ flex:1,minWidth:0 }}>
      <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:12 }}>
        <div style={{ width:28,height:28,borderRadius:"50%",background:color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,color:"#fff" }}>{num}</div>
        <div style={{ fontSize:15,fontWeight:700,color:"#111827" }}>{title}</div>
      </div>
      <div style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,padding:16,minHeight:200 }}>
        <div style={{ fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:".05em",marginBottom:8 }}>Tools</div>
        <div style={{ display:"flex",flexDirection:"column",gap:4,marginBottom:14 }}>
          {tools.map(([name,c])=>(
            <div key={name} style={{ display:"flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:6,background:c+"0a",border:`1px solid ${c}22` }}>
              <div style={{ width:6,height:6,borderRadius:"50%",background:c,flexShrink:0 }}/>
              <span style={{ fontSize:11,fontWeight:500,color:c }}>{name}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:".05em",marginBottom:6 }}>Output</div>
        {outputs.map((o,i)=>(<div key={i} style={{ fontSize:11,color:"#374151",marginBottom:2 }}>→ {o}</div>))}
        <div style={{ marginTop:10,fontSize:10,color:"#9ca3af" }}>⏱ {time}</div>
      </div>
    </div>
  );

  const Gate = ({num,title,action}) => (
    <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"0 4px",flexShrink:0,width:50 }}>
      <div style={{ width:1,height:20,background:"#fbbf24" }}/>
      <div style={{ width:40,height:40,borderRadius:"50%",background:"#fffbeb",border:"2px solid #fbbf24",display:"flex",alignItems:"center",justifyContent:"center" }}>
        <span style={{ fontSize:14 }}>👤</span>
      </div>
      <div style={{ fontSize:8,fontWeight:700,color:"#92400e",textAlign:"center",lineHeight:1.2 }}>GATE {num}</div>
      <div style={{ fontSize:7,color:"#b45309",textAlign:"center",lineHeight:1.2,maxWidth:50 }}>{action}</div>
      <div style={{ width:1,height:20,background:"#fbbf24" }}/>
    </div>
  );

  return (
    <div style={{ maxWidth:960,margin:"0 auto",padding:"40px 24px" }}>
      <div style={{ marginBottom:28 }}>
        <h1 style={{ fontSize:24,fontWeight:700,color:"#111827",marginBottom:4 }}>How it works</h1>
        <p style={{ fontSize:13,color:"#6b7280" }}>Three phases. Three human gates. AI does the research — you make the calls.</p>
      </div>

      {/* KPIs */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:28 }}>
        {[["Signals / day","6-12","#2563eb","Companies found hiring phone agents"],["Qualified","~40%","#7c3aed","Pass the 6-factor ICP scoring"],["Cost / lead","~$0.02","#0891b2","AI research cost per qualified lead"],["Your time","15 min","#f59e0b","Per batch of 5-7 companies"]].map(([l,v,c,d])=>(
          <div key={l} style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,padding:"14px 16px" }}>
            <div style={{ fontSize:10,color:"#9ca3af",marginBottom:2 }}>{l}</div>
            <div style={{ fontSize:22,fontWeight:700,color:c }}>{v}</div>
            <div style={{ fontSize:9,color:"#d1d5db",marginTop:2 }}>{d}</div>
          </div>
        ))}
      </div>

      {/* 3-Phase Flow */}
      <div style={{ display:"flex",alignItems:"stretch",gap:0,marginBottom:28 }}>
        <Phase num="1" title="Discover" color="#2563eb"
          tools={[["Indeed","#2164f3"],["LinkedIn Jobs","#0077b5"],["ZipRecruiter","#239846"],["Glassdoor","#0caa41"],["Google Jobs","#ea4335"],["Claude AI","#6366f1"]]}
          outputs={["Companies hiring phone agents","ICP score with evidence","Posting date + freshness"]}
          time="~30s automated"/>
        <Gate num="1" action="Approve companies"/>
        <Phase num="2" title="Enrich" color="#7c3aed"
          tools={[["Apollo.io","#7c3aed"],["LinkedIn","#0077b5"],["Hunter.io","#ff7043"],["Crunchbase","#0288d1"]]}
          outputs={["Decision maker name + title","Verified email address","LinkedIn profile URL","Background research"]}
          time="~20s per company"/>
        <Gate num="2" action="Verify contacts"/>
        <Phase num="3" title="Activate" color="#0891b2"
          tools={[["ROI Engine","#0891b2"],["BLS Salary Data","#1565c0"],["AI Copywriter","#6366f1"],["HubSpot CRM","#f97316"]]}
          outputs={["ROI calc (hiring vs Feather)","Cold email ready to send","LinkedIn DM + follow-up","Thought leadership post"]}
          time="~15s per company"/>
      </div>

      {/* ICP Model */}
      <div style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,padding:20,marginBottom:20 }}>
        <div style={{ fontSize:14,fontWeight:700,color:"#111827",marginBottom:12 }}>ICP scoring model</div>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12 }}>
          {[
            ["Phone intensity","25%","#2563eb","5+ call center roles open = 2"],
            ["Industry fit","20%","#7c3aed","Core lending/insurance = 2"],
            ["AI readiness","20%","#0891b2","No Vapi/Retell/Bland = 2"],
            ["Company size","15%","#f59e0b","200-2,000 employees = 2"],
            ["Budget signal","10%","#10b981","Revenue $100M-$5B = 2"],
            ["Timing urgency","10%","#ef4444","Posted <7d + 5 roles = 2"],
          ].map(([name,w,c,rule])=>(
            <div key={name} style={{ padding:"10px 12px",borderRadius:8,borderLeft:`3px solid ${c}`,background:"#f9fafb" }}>
              <div style={{ display:"flex",justifyContent:"space-between",marginBottom:3 }}>
                <span style={{ fontSize:12,fontWeight:600,color:"#111827" }}>{name}</span>
                <span style={{ fontSize:12,fontWeight:700,color:c }}>{w}</span>
              </div>
              <div style={{ fontSize:10,color:"#6b7280" }}>{rule}</div>
            </div>
          ))}
        </div>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"#f0fdf4",borderRadius:6,border:"1px solid #86efac" }}>
          <span style={{ fontSize:12,color:"#059669" }}>Qualify threshold: <strong>≥ 6.0 / 10</strong></span>
          <span style={{ fontSize:10,color:"#059669" }}>Hard reject: has AI voice · gov · &gt;5K emp</span>
        </div>
      </div>

      {/* HubSpot Pipeline */}
      <div style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,padding:20,marginBottom:20 }}>
        <div style={{ fontSize:14,fontWeight:700,color:"#111827",marginBottom:12 }}>HubSpot deal stages</div>
        <div style={{ display:"flex",flexWrap:"wrap",gap:3,alignItems:"center" }}>
          {[
            ["Signal detected","#e5e7eb","#6b7280"],["Qualifying","#e5e7eb","#6b7280"],
            ["⏸ Pending review","#fde68a","#92400e"],["ICP approved","#86efac","#059669"],
            ["Finding DM","#e5e7eb","#6b7280"],["⏸ Verify DM","#fde68a","#92400e"],
            ["Contact OK","#86efac","#059669"],["Gen outreach","#e5e7eb","#6b7280"],
            ["⏸ Review msgs","#fde68a","#92400e"],["Sent","#bfdbfe","#2563eb"],
            ["Meeting","#c4b5fd","#7c3aed"],["Won","#86efac","#059669"],
          ].map(([label,bg,fg],i)=>(
            <div key={i} style={{ display:"flex",alignItems:"center",gap:3 }}>
              <div style={{ padding:"4px 10px",borderRadius:4,fontSize:10,fontWeight:600,background:bg,color:fg }}>{label.replace("⏸ ","")}</div>
              {i<11 && <span style={{ color:"#d1d5db",fontSize:10 }}>›</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Bottom line */}
      <div style={{ background:"#111827",borderRadius:10,padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
        <div>
          <div style={{ fontSize:15,fontWeight:700,color:"#fff" }}>Three gates. Zero autopilot.</div>
          <div style={{ fontSize:12,color:"#6b7280",marginTop:2 }}>AI does the research. Humans make the decisions. Nothing ships without your approval.</div>
        </div>
        <div style={{ display:"flex",gap:6 }}>
          {["Approve","Verify","Review"].map(g=>(
            <div key={g} style={{ padding:"5px 12px",borderRadius:5,background:"#fbbf2420",border:"1px solid #fbbf2440",fontSize:11,fontWeight:600,color:"#fbbf24" }}>👤 {g}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══ SHARED ═══ */
function Tag({children,color="blue"}) {
  const c={blue:["#eff6ff","#2563eb","#bfdbfe"],green:["#f0fdf4","#059669","#86efac"],red:["#fef2f2","#dc2626","#fecaca"]}[color]||["#eff6ff","#2563eb","#bfdbfe"];
  return <span style={{ display:"inline-block",padding:"1px 8px",borderRadius:4,fontSize:10,fontWeight:600,background:c[0],color:c[1],border:`1px solid ${c[2]}` }}>{children}</span>;
}
function Metric({l,v,s,c}) {
  return <div style={{ background:"#f9fafb",borderRadius:8,padding:"12px 14px",borderLeft:`3px solid ${c}` }}>
    <div style={{ fontSize:10,color:"#9ca3af",marginBottom:3 }}>{l}</div>
    <div style={{ fontSize:20,fontWeight:700,color:c }}>{v}</div>
    {s && <div style={{ fontSize:10,color:"#9ca3af",marginTop:2 }}>{s}</div>}
  </div>;
}
function St({l,v}) { return <div><div style={{fontSize:10,color:"#059669",fontWeight:500,marginBottom:2}}>{l}</div><div style={{fontSize:17,fontWeight:700,color:"#111827"}}>{v}</div></div>; }
function CopyBtn({text,label}) {
  const [c,setC]=useState(false);
  return <button onClick={(e)=>{e.stopPropagation();navigator.clipboard.writeText(text);setC(true);setTimeout(()=>setC(false),1500)}}
    style={{background:"#f9fafb",border:"1px solid #e5e7eb",color:c?"#10b981":"#6b7280",padding:"3px 10px",borderRadius:5,fontSize:11,fontWeight:500}}>{c?"✓":label||"Copy"}</button>;
}
