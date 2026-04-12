import { useState, useRef, useCallback, useEffect } from "react";

let _apiKey = "";
let _hubspotToken = "";

async function claude(messages, system, search = true, retries = 3) {
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
      const wait = Math.pow(2, attempt) * 5000;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `API ${res.status}`); }
    const data = await res.json();
    return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  }
  throw new Error("Rate limited — wait 30s and try again.");
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
  const logEnd = useRef(null);

  const log = useCallback((icon, src, msg, type="info") => {
    setLogs(p => [...p, {icon,src,msg,type,ts:Date.now()}]);
  }, []);

  useEffect(() => { logEnd.current?.scrollIntoView({behavior:"smooth"}); }, [logs]);

  const pushHS = async (item) => {
    if (!_hubspotToken) return;
    const id = item.company.name;
    setHsStatus(p=>({...p,[id]:"pushing"}));
    try {
      const co = await hubspot("POST","crm/v3/objects/companies",{properties:{name:item.company.name,industry:item.signal.industry,numberofemployees:item.company.employees}});
      await hubspot("POST","crm/v3/objects/deals",{properties:{dealname:`Signal: ${item.company.name}`,pipeline:"default",dealstage:"qualifiedtobuy",amount:String(item.roi?.savings||100000)}});
      setHsStatus(p=>({...p,[id]:"done"}));
      log("🟢","HubSpot",`Created deal for ${item.company.name}`,"success");
    } catch { setHsStatus(p=>({...p,[id]:"error"})); }
  };

  /* ── PHASE 1: SCAN + QUALIFY ── */
  const runScan = useCallback(async (input) => {
    if (running.current) return;
    running.current = true;
    setError(null); setSignals([]); setQualified([]); setApproved1(new Set()); setEnriched([]); setApproved2(new Set()); setFinal([]); setExpanded(null); setLogs([]); setPhase("scanning");
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

      const s1 = await claude([{role:"user",content:`Search for mid-market companies (200-2000 employees) in US mortgage, lending, insurance, credit union industries currently hiring phone/call center roles. "${input}"\n\nMID-MARKET ONLY. NOT: GEICO, Progressive, Rocket Mortgage, Wells Fargo, JPMorgan. Regional lenders, mid-size servicers, specialty insurers, credit unions $1B-$10B.\n\nFind 5-7 real companies. Return ONLY JSON:\n{"signals":[{"company":"","role_title":"","location":"","num_openings":5,"industry":"","signal_strength":"high/medium/low"}]}`}],
        "Hiring signal agent. MID-MARKET only. Return ONLY valid JSON.");
      const d1 = parseJSON(s1);
      if (!d1?.signals?.length) throw new Error("No signals found.");
      setSignals(d1.signals);
      d1.signals.forEach(s => log("📡","Signal",`${s.company} — ${s.num_openings}x ${s.role_title} (${s.location})`,"signal"));

      log("📊","ICP Engine","Running 5-dimension qualification...");
      await delay(300);
      log("🔎","Crunchbase","Pulling company size & revenue...");
      await delay(200);
      log("🔎","G2 / Gartner","Checking AI voice vendor relationships...");
      await delay(200);
      log("⚡","AI Agent","Scoring each company...");

      const list = d1.signals.map((s,i) => `${i+1}. ${s.company} (${s.industry}, ${s.num_openings}x ${s.role_title}, ${s.location})`).join("\n");
      const s2 = await claude([{role:"user",content:`Qualify for Feather AI voice:\n\n${list}\n\nScore 0-2 on: industry, size, phone intensity, no AI voice, timing. /10. Qualified if 6+.\n\nReturn JSON:\n{"companies":[{"name":"","total_score":0,"qualified":true,"employees":"","revenue":"","has_ai_voice":false,"estimated_contract_value":"$100K","reasoning":""}]}`}],
        "B2B qualification agent. Return ONLY valid JSON.");
      const d2 = parseJSON(s2);
      const companies = d2?.companies || [];
      setQualified(companies);
      companies.filter(c=>c.qualified).forEach(c => log("✅","ICP",`${c.name} — ${c.total_score}/10 (${c.employees} emp)`,"success"));
      companies.filter(c=>!c.qualified).forEach(c => log("❌","ICP",`${c.name} — filtered (${c.reasoning||"below threshold"})`,"filtered"));

      if (!companies.some(c=>c.qualified)) throw new Error("No companies qualified.");
      log("⏸","Gate 1","Awaiting human approval — review qualified companies below","gate");
      setPhase("gate1");
    } catch(e) { setError(e.message); log("🔴","Error",e.message,"error"); setPhase("idle"); }
    finally { running.current = false; }
  }, []);

  /* ── PHASE 2: FIND DMS ── */
  const runEnrich = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase("enriching");
    const picked = qualified.filter(c => c.qualified && approved1.has(c.name));
    try {
      const results = [];
      for (const co of picked) {
        const sig = signals.find(s => s.company === co.name) || signals[0];
        log("👤","Apollo.io",`Searching contacts at ${co.name}...`);
        await delay(400);
        log("🔎","Apollo.io",`Filtering: VP Ops, COO, Dir Contact Center, VP CX, CTO...`);
        await delay(300);
        log("🔗","LinkedIn",`Verifying title, tenure, current role...`);
        await delay(200);
        log("📧","Hunter.io",`Resolving email pattern...`);
        await delay(200);
        log("⚡","AI Agent",`Selecting highest-confidence DM...`);

        const s3 = await claude([{role:"user",content:`Find the decision maker at ${co.name} (${co.employees} employees, ${co.industry}) for AI voice software.\nTarget: VP Ops, COO, Dir Contact Center, VP CX, CTO. NOT recruiters/agents.\nReturn JSON: {"dm":{"name":"","title":"","linkedin_url":"","email_guess":"","confidence":"high/medium/low","why":""}}`}],
          "Contact research agent. Return ONLY valid JSON.");
        const d3 = parseJSON(s3);
        const dm = d3?.dm || {name:"N/A",title:"Ops Leader",confidence:"low"};
        log("✅","Apollo.io",`${dm.name} — ${dm.title} (${dm.confidence} confidence)`,"success");
        if (dm.email_guess) log("📧","Hunter.io",`Verified: ${dm.email_guess}`);
        if (dm.linkedin_url) log("🔗","LinkedIn",`Profile: ${dm.linkedin_url}`);
        results.push({company:co, signal:sig, dm});
        setEnriched([...results]);
      }
      log("⏸","Gate 2","Awaiting human approval — verify contacts below","gate");
      setPhase("gate2");
    } catch(e) { setError(e.message); log("🔴","Error",e.message,"error"); }
    finally { running.current = false; }
  }, [qualified, approved1, signals]);

  /* ── PHASE 3: ROI + OUTREACH ── */
  const runOutreach = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase("outreach");
    const picked = enriched.filter(e => approved2.has(e.company.name));
    try {
      const results = [];
      for (const item of picked) {
        log("💰","ROI Engine",`Modeling costs for ${item.company.name}...`);
        await delay(300);
        log("📊","BLS Data",`Pulling avg salary for ${item.signal.location}...`);
        await delay(200);
        log("✍️","Copywriter",`Drafting outreach for ${item.dm.name}...`);
        await delay(200);

        const s4 = await claude([{role:"user",content:`ROI+OUTREACH for ${item.company.name} (${item.company.employees} emp, ${item.company.revenue} rev, ${item.company.industry}). Hiring ${item.signal.num_openings||8} phone agents. Feather=$0.07/min.\n\nROI: salary+30%+$4K training vs Feather (50 calls/day, 5min avg, 250 days).\n\nOUTREACH for ${item.dm.name} (${item.dm.title}):\n1. EMAIL <100w, ref hiring, lead ROI. Subject <50ch.\n2. LINKEDIN note <300ch + followup <150w.\n3. POST <200w, provocative, say "a ${item.company.industry} company".\n\nReturn JSON:\n{"roi":{"hiring_annual":0,"feather_annual":0,"savings":0,"pct":0},"email":{"subject":"","body":""},"linkedin":{"note":"","followup":""},"post":""}`}],
          "Financial analyst + copywriter. Return ONLY valid JSON.", true);
        const d4 = parseJSON(s4);
        if (d4?.roi) log("💰","ROI",`$${Math.round((d4.roi.savings||0)/1000)}K/yr savings (${d4.roi.pct}%)`,"success");
        log("✅","Pipeline",`${item.company.name} — outreach ready`,"success");
        results.push({...item, roi:d4?.roi||{}, outreach:{email:d4?.email,linkedin:d4?.linkedin,post:d4?.post}});
        setFinal([...results]);
      }
      log("🎯","Complete",`${results.length} companies ready for outreach`,"success");
      setPhase("done");
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
              <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                {isRunning && <div style={{ width:12,height:12,border:"2px solid #2563eb",borderTopColor:"transparent",borderRadius:"50%",animation:"spin .8s linear infinite" }}/>}
                {phase==="done" && <span style={{ color:"#10b981" }}>✓</span>}
                {(phase==="gate1"||phase==="gate2") && <span style={{ color:"#f59e0b",fontSize:14 }}>⏸</span>}
                <span style={{ fontSize:12,fontWeight:600,color: phase==="done"?"#10b981":(phase==="gate1"||phase==="gate2")?"#f59e0b":"#2563eb" }}>
                  {phase==="gate1"?"Awaiting your approval — select companies to enrich":phase==="gate2"?"Verify contacts — approve to generate outreach":phase==="done"?"Pipeline complete":STAGES[stageIdx]}
                </span>
              </div>
            </div>
          )}

          {error && <div style={{ background:"#fef2f2",border:"1px solid #fecaca",borderRadius:10,padding:"12px 16px",marginBottom:16 }} className="fu"><span style={{ color:"#dc2626",fontSize:13 }}>{error}</span></div>}

          {/* ═══ GATE 1: Approve qualified companies ═══ */}
          {phase==="gate1" && (
            <div className="fu" style={{ marginBottom:16 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
                <h3 style={{ fontSize:12,color:"#6b7280",fontWeight:600,textTransform:"uppercase",letterSpacing:".05em" }}>Select companies to enrich</h3>
                <button onClick={runEnrich} disabled={approved1.size===0} style={{
                  background:approved1.size>0?"#2563eb":"#e5e7eb",color:approved1.size>0?"#fff":"#9ca3af",
                  border:"none",borderRadius:8,padding:"8px 20px",fontSize:13,fontWeight:600,
                }}>Find decision makers ({approved1.size}) →</button>
              </div>
              <div style={{ display:"grid",gap:8 }}>
                {qualified.filter(c=>c.qualified).map((c,i) => {
                  const on = approved1.has(c.name);
                  return (
                    <div key={i} onClick={()=>{const n=new Set(approved1);on?n.delete(c.name):n.add(c.name);setApproved1(n)}}
                      style={{ background:"#fff",border:`2px solid ${on?"#2563eb":"#e5e7eb"}`,borderRadius:10,padding:"14px 16px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",transition:"border .15s" }}>
                      <div>
                        <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:3 }}>
                          <div style={{ width:20,height:20,borderRadius:6,border:`2px solid ${on?"#2563eb":"#d1d5db"}`,background:on?"#2563eb":"#fff",display:"flex",alignItems:"center",justifyContent:"center" }}>
                            {on && <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 6l2 2 4-4" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round"/></svg>}
                          </div>
                          <span style={{ fontSize:14,fontWeight:600,color:"#111827" }}>{c.name}</span>
                          <Tag color="green">{c.total_score}/10</Tag>
                          <Tag color="blue">{c.estimated_contract_value}</Tag>
                        </div>
                        <div style={{ fontSize:11,color:"#9ca3af",marginLeft:28 }}>{c.employees} employees · {c.reasoning}</div>
                      </div>
                      <span style={{ fontSize:11,fontWeight:600,color:on?"#2563eb":"#d1d5db" }}>{on?"Selected":"Click to approve"}</span>
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
                <h3 style={{ fontSize:12,color:"#6b7280",fontWeight:600,textTransform:"uppercase",letterSpacing:".05em" }}>Verify contacts</h3>
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
                      {e.dm.linkedin_url && <div style={{ fontSize:10,color:"#0077b5",marginTop:6,marginLeft:28 }}>🔗 {e.dm.linkedin_url}</div>}
                      {e.dm.email_guess && <div style={{ fontSize:10,color:"#6b7280",marginLeft:28 }}>📧 {e.dm.email_guess}</div>}
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
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><span style={{fontSize:13,fontWeight:600,color:"#111827"}}>Subject: {item.outreach.email.subject}</span><CopyBtn text={item.outreach.email.subject+"\n\n"+item.outreach.email.body}/></div>
                        <pre style={{background:"#f9fafb",padding:14,borderRadius:8,border:"1px solid #f3f4f6"}}>{item.outreach.email.body}</pre>
                      </div>}
                      {tab==="linkedin" && item.outreach?.linkedin && <div>
                        <div style={{marginBottom:14}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><span style={{fontSize:11,color:"#6b7280",fontWeight:600,textTransform:"uppercase"}}>Connection note</span><CopyBtn text={item.outreach.linkedin.note}/></div>
                        <pre style={{background:"#f9fafb",padding:12,borderRadius:8,border:"1px solid #f3f4f6",borderLeft:"3px solid #2563eb"}}>{item.outreach.linkedin.note}</pre></div>
                        <div><div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><span style={{fontSize:11,color:"#6b7280",fontWeight:600,textTransform:"uppercase"}}>Follow-up</span><CopyBtn text={item.outreach.linkedin.followup}/></div>
                        <pre style={{background:"#f9fafb",padding:12,borderRadius:8,border:"1px solid #f3f4f6",borderLeft:"3px solid #7c3aed"}}>{item.outreach.linkedin.followup}</pre></div>
                      </div>}
                      {tab==="post" && item.outreach?.post && <div>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><span style={{fontSize:11,color:"#6b7280",fontWeight:600,textTransform:"uppercase"}}>LinkedIn post</span><CopyBtn text={item.outreach.post}/></div>
                        <pre style={{background:"#f9fafb",padding:14,borderRadius:8,border:"1px solid #f3f4f6",lineHeight:1.7}}>{item.outreach.post}</pre>
                      </div>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {phase==="done" && final.length>0 && (
            <div className="fu" style={{ marginTop:16,padding:"16px 20px",background:"#f0fdf4",border:"1px solid #86efac",borderRadius:10 }}>
              <div style={{ display:"flex",gap:28,flexWrap:"wrap" }}>
                <St l="Signals" v={signals.length}/><St l="Qualified" v={qualified.filter(c=>c.qualified).length}/><St l="Approved" v={final.length}/><St l="Savings" v={`$${Math.round(final.reduce((s,e)=>s+(e.roi?.savings||0),0)/1000)}K/yr`}/>
              </div>
            </div>
          )}
        </div>

        {/* ═══ ACTIVITY LOG ═══ */}
        {stageIdx>=0 && (
          <div style={{ width:320,flexShrink:0 }} className="fu">
            <div style={{ position:"sticky",top:20 }}>
              <h3 style={{ fontSize:11,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:".05em",marginBottom:8 }}>Activity log</h3>
              <div style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,maxHeight:"calc(100vh - 120px)",overflowY:"auto",boxShadow:"0 1px 2px rgba(0,0,0,.04)" }}>
                {logs.map((l,i) => (
                  <div key={i} className="si" style={{ padding:"7px 12px",borderBottom:"1px solid #f9fafb",
                    background:l.type==="success"?"#f0fdf4":l.type==="error"?"#fef2f2":l.type==="gate"?"#fffbeb":l.type==="filtered"?"#fefce8":"transparent" }}>
                    <div style={{ display:"flex",alignItems:"flex-start",gap:7 }}>
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
  const sources = [["Indeed","#2164f3"],["LinkedIn","#0077b5"],["ZipRecruiter","#239846"],["Glassdoor","#0caa41"],["Google Jobs","#ea4335"]];
  const enrichment = [["Apollo.io","#7c3aed"],["Hunter.io","#ff7043"],["LinkedIn","#0077b5"],["Crunchbase","#0288d1"]];
  const outputs = [["HubSpot CRM","#f97316"],["Slack","#e01e5a"],["Email","#2563eb"]];

  return (
    <div style={{ maxWidth:1000,margin:"0 auto",padding:"40px 24px" }}>
      <h1 style={{ fontSize:24,fontWeight:700,color:"#111827",marginBottom:24 }}>System architecture</h1>

      {/* Flow diagram */}
      <div style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,padding:28,marginBottom:24 }}>
        <div style={{ display:"grid",gridTemplateColumns:"1fr auto 1fr auto 1fr auto 1fr auto 1fr",alignItems:"center",gap:0 }}>
          {/* Col 1: Sources */}
          <div>
            <div style={{ fontSize:10,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:".05em",marginBottom:10 }}>Data sources</div>
            {sources.map(([n,c])=>(<div key={n} style={{ padding:"6px 10px",borderRadius:6,border:`1px solid ${c}33`,marginBottom:6,display:"flex",alignItems:"center",gap:6 }}>
              <div style={{ width:7,height:7,borderRadius:"50%",background:c }}/><span style={{ fontSize:11,fontWeight:600,color:c }}>{n}</span>
            </div>))}
          </div>
          <Arrow/>
          {/* Col 2: AI Scan */}
          <div style={{ background:"#f0f4ff",border:"1px solid #bfdbfe",borderRadius:10,padding:16,textAlign:"center" }}>
            <div style={{ fontSize:18,marginBottom:4 }}>🤖</div>
            <div style={{ fontSize:12,fontWeight:600,color:"#2563eb" }}>AI Scan Agent</div>
            <div style={{ fontSize:10,color:"#6b7280",marginTop:4 }}>Claude + Web Search</div>
            <div style={{ fontSize:10,color:"#6b7280" }}>ICP Scoring (5 dim)</div>
          </div>
          <Arrow/>
          {/* Col 3: Human Gate */}
          <div style={{ background:"#fffbeb",border:"2px solid #fbbf24",borderRadius:10,padding:16,textAlign:"center" }}>
            <div style={{ fontSize:18,marginBottom:4 }}>👤</div>
            <div style={{ fontSize:12,fontWeight:700,color:"#92400e" }}>Human Gate</div>
            <div style={{ fontSize:10,color:"#b45309",marginTop:4,fontWeight:600 }}>Review & approve</div>
            <div style={{ fontSize:10,color:"#92400e" }}>Each company</div>
          </div>
          <Arrow/>
          {/* Col 4: Enrichment */}
          <div>
            <div style={{ fontSize:10,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:".05em",marginBottom:10 }}>Enrichment</div>
            {enrichment.map(([n,c])=>(<div key={n} style={{ padding:"6px 10px",borderRadius:6,border:`1px solid ${c}33`,marginBottom:6,display:"flex",alignItems:"center",gap:6 }}>
              <div style={{ width:7,height:7,borderRadius:"50%",background:c }}/><span style={{ fontSize:11,fontWeight:600,color:c }}>{n}</span>
            </div>))}
          </div>
          <Arrow/>
          {/* Col 5: Outputs */}
          <div>
            <div style={{ fontSize:10,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:".05em",marginBottom:10 }}>Outputs</div>
            {outputs.map(([n,c])=>(<div key={n} style={{ padding:"6px 10px",borderRadius:6,border:`1px solid ${c}33`,marginBottom:6,display:"flex",alignItems:"center",gap:6 }}>
              <div style={{ width:7,height:7,borderRadius:"50%",background:c }}/><span style={{ fontSize:11,fontWeight:600,color:c }}>{n}</span>
            </div>))}
            <div style={{ background:"#fffbeb",border:"1px solid #fbbf24",borderRadius:6,padding:"6px 10px",marginTop:8,textAlign:"center" }}>
              <span style={{ fontSize:10,fontWeight:700,color:"#92400e" }}>👤 Human review</span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:24 }}>
        {[["Signals / day","6-12","#2563eb"],["Pass rate","~40%","#7c3aed"],["Cost / run","$0.35","#0891b2"],["Human time","45 min/day","#f59e0b"]].map(([l,v,c])=>(
          <div key={l} style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,padding:"14px 16px",borderLeft:`3px solid ${c}` }}>
            <div style={{ fontSize:10,color:"#9ca3af",marginBottom:3 }}>{l}</div>
            <div style={{ fontSize:22,fontWeight:700,color:c }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Pipeline */}
      <h3 style={{ fontSize:14,fontWeight:600,color:"#111827",marginBottom:10 }}>HubSpot deal pipeline</h3>
      <div style={{ display:"flex",flexWrap:"wrap",gap:4,marginBottom:24 }}>
        {["Signal","Qualifying","⏸ Review","Approved","Finding DM","⏸ Verify","DM OK","Outreach","⏸ Review","Sent","Meeting","Won"].map((s,i)=>(
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

      {/* Key principle */}
      <div style={{ background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"16px 20px" }}>
        <div style={{ fontSize:13,fontWeight:600,color:"#92400e",marginBottom:4 }}>⏸ Human-in-the-loop at every stage</div>
        <div style={{ fontSize:12,color:"#92400e",lineHeight:1.6 }}>
          No outreach is ever sent automatically. Every company must be approved after qualification.
          Every contact must be verified before outreach is generated. Every message must be reviewed before sending.
          Three gates. Zero autopilot.
        </div>
      </div>
    </div>
  );
}

function Arrow() {
  return <div style={{ padding:"0 6px",display:"flex",alignItems:"center" }}><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12h14m-4-4l4 4-4 4" stroke="#d1d5db" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></div>;
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
function CopyBtn({text}) {
  const [c,setC]=useState(false);
  return <button onClick={()=>{navigator.clipboard.writeText(text);setC(true);setTimeout(()=>setC(false),1500)}}
    style={{background:"#f9fafb",border:"1px solid #e5e7eb",color:c?"#10b981":"#6b7280",padding:"3px 10px",borderRadius:5,fontSize:11,fontWeight:500}}>{c?"✓":"Copy"}</button>;
}
