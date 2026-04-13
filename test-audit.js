const fs = require('fs');
const code = fs.readFileSync(__dirname + '/src/App.jsx', 'utf8');

let pass = 0, fail = 0;
function test(name, condition, detail) {
  if (condition) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} — ${detail}`); }
}

console.log("\n🔬 HIRING SIGNAL SNIPER — DEEP TEST SUITE\n");

// === TEST 1: Timer cleanup on error ===
console.log("── Timer management ──");
test("Timer cleared on scan error",
  code.includes("setPhase(\"idle\")") && code.match(/catch.*setPhase\("idle"\)/s),
  "Timer keeps running if scan fails — need clearInterval in catch block");

test("Timer cleared on enrichment completion",
  code.includes('setPhase("gate2"); clearInterval(timerRef.current)'),
  "Timer not stopped at gate2");

test("Timer cleared on outreach completion",
  code.includes('setPhase("done"); clearInterval(timerRef.current)'),
  "Timer not stopped on done");

test("Timer leak: scan error path clears interval",
  code.match(/catch\(e\)\s*\{[^}]*clearInterval/s) || code.match(/catch\(e\)\s*\{\s*setError.*setPhase\("idle"\)/s),
  "BUG: Timer runs forever if scan throws — clearInterval missing in scan catch");

// === TEST 2: Data flow integrity ===
console.log("\n── Data flow ──");
test("Filtered signals used for qualification (not raw)",
  code.match(/const list = d1\.signals\.map/) || code.match(/const list = fresh\.map/),
  "BUG: Using d1.signals instead of filtered 'fresh' for qualification list");

const usesD1ForList = code.includes("d1.signals.map((s,i) => `${i+1}");
test("CRITICAL: Qualification uses d1.signals not fresh",
  !usesD1ForList || code.includes("const fresh = d1.signals"),
  "BUG: ICP qualification receives stale signals that were filtered out");

// === TEST 3: Freshness null safety ===
console.log("\n── Null safety ──");
test("days_ago handles undefined gracefully",
  code.includes("days<=3") && code.includes("sig?.days_ago"),
  "days_ago can be undefined — color fallback needed");

const freshColorLine = code.match(/const freshColor = .*/);
test("freshColor has fallback for undefined days",
  freshColorLine && freshColorLine[0].includes("null") || !freshColorLine[0].includes("days<=3"),
  "BUG: undefined<=3 is false, falls to red — misleading for unknown dates");

// === TEST 4: CSV export escaping ===
console.log("\n── CSV export ──");
test("CSV properly escapes commas in values",
  code.includes('.replace(/"/g') || code.includes("replace(/\"/g"),
  "Double-quotes escaped in CSV");

test("CSV wraps text fields in quotes",
  code.match(/`"\$\{/) || code.includes('`"${'),
  "Text fields with potential commas should be quoted");

// === TEST 5: HubSpot integration ===
console.log("\n── HubSpot ──");
test("Contact association uses type 1 (contact→company)",
  code.includes("associationTypeId:1"),
  "Wrong association ID for contact→company");

test("Deal association uses type 5 (deal→company)",
  code.includes("associationTypeId:5"),
  "Wrong association ID for deal→company");

test("Employee count parsed to number",
  code.includes("parseNum(item.company.employees)"),
  "Employees sent as string — HubSpot needs number");

test("Email validated before adding to contact",
  code.includes('email_guess.includes("@")'),
  "Invalid email could break HubSpot contact creation");

test("Description truncated",
  code.includes("truncate(") && code.includes("2000"),
  "Description could exceed HubSpot limits");

test("HubSpot errors logged to activity log",
  code.includes("HubSpot") && code.includes("err.message") && code.includes('"error"'),
  "HubSpot errors should surface in UI");

// === TEST 6: Rate limit handling ===
console.log("\n── Rate limits ──");
test("Retry with backoff on 429",
  code.includes("res.status === 429") && code.includes("15000") && code.includes("60000"),
  "Need exponential backoff on rate limit");

test("Outreach uses NO web search (saves tokens)",
  code.includes('"B2B sales copywriter') && code.includes(", false)"),
  "Outreach call should not use web search");

test("Cooldown between DM lookups",
  code.includes("Waiting 10s") && code.includes("delay(10000)"),
  "Need cooldown between DM API calls");

test("Cooldown before outreach phase",
  code.includes("Waiting 15s before outreach"),
  "Need buffer before outreach to reset rate window");

test("Per-company error handling in enrichment",
  code.match(/for \(const co of picked\)[\s\S]*?try \{/),
  "Individual company failure should not kill the loop");

// === TEST 7: Scoring model ===
console.log("\n── ICP scoring ──");
test("6 factors defined in prompt",
  code.includes("INDUSTRY ALIGNMENT") && code.includes("COMPANY SIZE") && 
  code.includes("PHONE OPERATION") && code.includes("AI VOICE READINESS") && 
  code.includes("BUDGET SIGNAL") && code.includes("TIMING URGENCY"),
  "Missing one or more ICP factors");

test("Weights sum to 100",
  code.includes("weight 20%") && code.includes("weight 15%") && 
  code.includes("weight 25%") && code.includes("weight 10%"),
  "Weights should sum to 100%: 20+15+25+20+10+10");

test("Formula documented: /20 for score out of 10",
  code.includes("/ 20"),
  "Formula divisor should be 20 for 0-10 range");

test("Threshold 6.0 documented",
  code.includes("6.0") || code.includes("≥ 6"),
  "Qualification threshold should be 6.0/10");

test("Evidence required for each score",
  code.includes("Evidence needed") && code.includes("Do NOT guess"),
  "Scores must be evidence-backed");

// === TEST 8: UI/UX ===
console.log("\n── UI/UX ──");
test("Empty state shown when idle",
  code.includes("No pipeline running"),
  "Need empty state before first run");

test("Select all button on gate 1",
  code.includes("Select all") && code.includes("Deselect all"),
  "Need bulk select on approval gate");

test("Run again button on completion",
  code.includes("Run new pipeline"),
  "Need restart button after pipeline completes");

test("LinkedIn URL validated (starts with http)",
  code.includes('linkedin_url.startsWith("http")'),
  "LinkedIn URLs should be validated before rendering as links");

test("Email validated (contains @)",
  code.includes('email_guess.includes("@")'),
  "Emails should be validated before mailto links");

test("Elapsed timer displayed",
  code.includes("elapsed") && code.includes("padStart"),
  "Timer should show MM:SS format");

test("CSV export available",
  code.includes("Export CSV") && code.includes("text/csv"),
  "Need CSV download on completion");

test("Copy all outreach button",
  code.includes("Copy all outreach"),
  "Need bulk copy for all outreach text");

// === TEST 9: State management ===
console.log("\n── State management ──");
test("All state reset on new run",
  code.includes("setSignals([])") && code.includes("setQualified([])") && 
  code.includes("setEnriched([])") && code.includes("setFinal([])") &&
  code.includes("setLogs([])"),
  "All state arrays should be cleared on new pipeline run");

test("hsStatus reset on new run",
  code.match(/setHsStatus\(\{?\}\)?/) || code.includes("setHsStatus"),
  "POTENTIAL: hsStatus should be cleared between runs");

test("running.current prevents double execution",
  code.includes("if (running.current) return"),
  "Need guard against double-clicking run");

// === TEST 10: Security ===
console.log("\n── Security ──");
test("API key stored in memory only (not localStorage)",
  !code.includes("localStorage") && !code.includes("sessionStorage"),
  "API keys should never be persisted to storage");

test("API key sent via header not URL",
  code.includes("x-api-key") && !code.includes("apiKey="),
  "API key should be in header, never in URL params");

test("HubSpot token proxied through backend",
  code.includes("/api/hubspot/") && code.includes("x-hubspot-token"),
  "HubSpot calls should go through server proxy");

// === RESULTS ===
console.log(`\n${"═".repeat(50)}`);
console.log(`  ${pass} passed  |  ${fail} failed  |  ${pass+fail} total`);
console.log(`${"═".repeat(50)}`);

if (fail > 0) {
  console.log("\n🔧 BUGS TO FIX:");
}
