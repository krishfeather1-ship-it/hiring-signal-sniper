# Hiring Signal Sniper — operational blueprint

## The system at a glance

Three n8n workflows. Three human approval gates. HubSpot as single source of truth.

No message ever goes out without a human reviewing it. No company enters the pipeline without passing ICP qualification. No contact gets outreach unless they're verified as the decision maker.

---

## Accounts you need

| Tool | Plan | What it does | Setup time |
|------|------|-------------|------------|
| HubSpot | Free CRM | Pipeline tracker, contact/company records, activity log | 30 min |
| n8n | Cloud (free tier) or self-hosted | Workflow orchestration | 15 min |
| Anthropic API | Pay-as-you-go | Claude Sonnet for all AI agents | 5 min |
| Apollo.io | Free (10K credits/mo) | Contact enrichment + email finding | 10 min |
| Slack | Free | Notifications at each gate | 5 min |

Total setup: ~1 hour before first run.

---

## HubSpot setup

### Deal pipeline: "Hiring Signal Pipeline"

Create this pipeline with these exact stages:

| Stage | Type | What happens here |
|-------|------|-------------------|
| Signal detected | Automated | n8n found a hiring signal |
| Qualifying | Automated | ICP scoring in progress |
| Qualified — pending review | **HUMAN GATE** | You review ICP fit, approve or reject |
| ICP rejected | Closed/lost | Didn't meet criteria |
| ICP approved | Automated | Triggers Workflow 2 |
| Finding contact | Automated | DM discovery in progress |
| Contact found — pending review | **HUMAN GATE** | You verify the right person |
| Contact approved | Automated | Triggers Workflow 3 |
| Generating outreach | Automated | ROI + messaging in progress |
| Outreach ready | **HUMAN GATE** | You review and edit all messaging |
| Outreach sent | Manual | You sent the email/LinkedIn |
| Follow-up scheduled | Manual | Follow-up task created |
| Meeting booked | Manual | They responded, meeting set |
| Closed won | Manual | Deal signed |
| Closed lost | Manual | No fit or no response |

### Custom deal properties

Create these custom properties on the Deal object:

**Signal data:**
- `signal_source` (single-line text) — where the job posting was found
- `job_title_detected` (single-line text) — exact job title from posting
- `job_posting_url` (single-line text) — link to the posting
- `num_openings` (number) — estimated number of roles
- `signal_strength` (dropdown: high/medium/low) — based on opening count

**ICP qualification:**
- `icp_score` (number 1-5) — overall ICP fit score
- `icp_industry_fit` (dropdown: strong/moderate/weak) — lending, mortgage, insurance, credit union
- `icp_size_fit` (dropdown: strong/moderate/weak) — 200+ employees or $50M+ revenue
- `has_existing_solution` (checkbox) — already using voice AI?
- `existing_solution_name` (single-line text) — which solution they use
- `icp_rejection_reason` (multi-line text) — why they were rejected, if applicable

**ROI data:**
- `estimated_contract_value` (currency) — annual contract potential
- `current_hiring_cost` (currency) — what they'd spend on human agents
- `feather_cost` (currency) — equivalent Feather cost
- `annual_savings` (currency) — the delta
- `roi_headline` (single-line text) — one-liner for LinkedIn

**Outreach drafts:**
- `email_subject` (single-line text)
- `email_body` (multi-line text)
- `linkedin_connection_note` (single-line text)
- `linkedin_followup` (multi-line text)
- `linkedin_post_draft` (multi-line text)

**Decision maker:**
- `dm_confidence` (dropdown: high/medium/low) — how confident we are this is the right person

### Custom contact properties

- `source_workflow` (single-line text) — "hiring-signal-sniper"
- `dm_verified` (checkbox) — human confirmed this is the DM

### HubSpot workflow automations

Create two HubSpot workflows (not n8n — these run inside HubSpot):

**Automation 1:** When deal moves to "ICP approved" → send webhook to n8n Workflow 2 URL
**Automation 2:** When deal moves to "Contact approved" → send webhook to n8n Workflow 3 URL

These webhooks trigger the next n8n workflow automatically when you approve in HubSpot.

---

## ICP qualification criteria

This is the scoring rubric Claude uses. A company must score 3+ to qualify.

### ICP scorecard (1-5 points)

| Criterion | 0 points | 1 point | 2 points |
|-----------|----------|---------|----------|
| **Industry** | Not financial services | Adjacent (real estate, auto) | Core (mortgage, lending, insurance, credit union) |
| **Size** | <100 employees | 100-500 employees | 500+ employees or $50M+ revenue |
| **Phone intensity** | No evidence of call center | Some phone roles | Dedicated call center / multiple phone openings |
| **Existing solution** | Already uses AI voice (Vapi, Retell, etc.) | Uses basic IVR | No voice automation at all |
| **Timing signal** | Old posting (60+ days) | Recent posting (30 days) | Very recent (< 14 days) or multiple openings |

**Qualification threshold:** Score 6+ out of 10 = qualified. Below 6 = rejected with reason logged.

**Hard disqualifiers (auto-reject regardless of score):**
- Already uses Vapi, Retell, Bland, Synthflow, or similar
- Fewer than 50 employees (can't support $100K contract)
- Government entity (procurement complexity)
- Non-US/Canada (Feather's current market)

### Decision maker targeting

The DM is the person who can sign a $100K+ annual contract for call center technology. This is NOT:
- A recruiter (they're hiring agents, not buying tech)
- An individual call center agent
- A generic "manager" without operations scope
- The CEO (too high — they delegate this)

**Target titles (in priority order):**
1. VP of Operations / SVP Operations
2. Chief Operating Officer (at companies under 500 people)
3. Director/Head of Contact Center
4. VP of Customer Experience
5. CTO / VP Engineering (if they're tech-forward)
6. Director of Loan Servicing / Mortgage Operations

**Verification checks before outreach:**
- Title matches target list above
- They've been in the role 3+ months (not brand new)
- LinkedIn profile exists and is active
- They're actually at the company (not just "former")

---

## n8n workflow 1: scan and qualify

**Trigger:** Daily schedule (7 AM) + manual trigger for demos

### Node-by-node

**Node 1: Claude Signal Scanner**
Type: HTTP Request → Anthropic API
```
System: You are a hiring signal intelligence agent. Use web search to find REAL current job postings.
User: Search for companies in the US mortgage, lending, insurance, and credit union industries that are currently hiring for call center, phone support, or loan servicing phone roles. Find 8-12 real companies with actual open positions. Return ONLY valid JSON:
{
  "signals": [{
    "company": "real company name",
    "role_title": "exact job title",
    "location": "city, state",
    "num_openings": number,
    "job_url": "url",
    "industry_guess": "mortgage/lending/insurance/credit union",
    "signal_strength": "high/medium/low"
  }]
}
```

**Node 2: Parse signals** (Code node)
Parse JSON, loop through each signal.

**Node 3: HubSpot — Search company** 
Check if company already exists in HubSpot. If yes, skip (don't create duplicates).

**Node 4: Claude ICP Qualifier**
Type: HTTP Request → Anthropic API with web search
```
System: You are a B2B sales qualification agent for Feather (featherhq.com), an AI voice calling platform for lending. Score this company against our ICP.
User: Research {company_name} and score them:

1. Industry fit (0-2): Is this mortgage, lending, insurance, or credit union?
2. Size fit (0-2): 500+ employees or $50M+ revenue = 2, 100-500 = 1, <100 = 0
3. Phone intensity (0-2): Evidence of call center operations?
4. Existing solution (0-2): Do they already use AI voice agents? (Check for Vapi, Retell, Bland, Synthflow mentions)
5. Timing (0-2): How recent/urgent are their phone hiring needs?

Also determine:
- Estimated annual revenue
- Employee count
- Whether they have any existing voice AI solution
- Estimated contract value (based on call volume)

Return ONLY valid JSON:
{
  "company": "name",
  "scores": { "industry": N, "size": N, "phone_intensity": N, "existing_solution": N, "timing": N },
  "total_score": N,
  "qualified": true/false (threshold: 6+),
  "hard_disqualifier": null or "reason",
  "employees": "count or range",
  "revenue": "estimate",
  "has_existing_solution": false,
  "existing_solution_name": "none or name",
  "estimated_contract_value": "$XXK",
  "qualification_reasoning": "2-3 sentence explanation"
}
```

**Node 5: IF — Qualified?**
Check: `total_score >= 6` AND `hard_disqualifier === null`
- Yes → continue to Node 6
- No → Node 5b: HubSpot create deal in "ICP rejected" stage with rejection reason, then skip

**Node 6: HubSpot — Create company**
Create company record with all enrichment data.

**Node 7: HubSpot — Create deal**
Create deal in "Qualified — pending review" stage. Set all custom properties from the qualification data.

**Node 8: HubSpot — Add note**
Add a note to the deal with the full qualification reasoning.

**Node 9: Slack notification**
Post to #hiring-signals channel:
```
New qualified signal:
• Company: {name}
• ICP score: {score}/10
• Hiring: {num_openings} phone roles
• Est. contract: {contract_value}
• Industry: {industry}
→ Review in HubSpot: {deal_url}
```

---

## Human gate 1: ICP review

**What you do:** Open HubSpot. Review the deal. Check:
- Does the qualification make sense?
- Is the company actually in lending/mortgage/insurance?
- Is the contract value realistic?
- Any red flags?

**Action:** Move deal to "ICP approved" or "ICP rejected"

Moving to "ICP approved" triggers HubSpot workflow → sends webhook → starts n8n Workflow 2.

---

## n8n workflow 2: find decision maker

**Trigger:** Webhook (from HubSpot automation when deal → "ICP approved")

### Node-by-node

**Node 1: Webhook trigger**
Receives deal ID from HubSpot.

**Node 2: HubSpot — Get deal + company**
Pull all deal and company data.

**Node 3: Apollo — People search**
```
POST https://api.apollo.io/api/v1/mixed_people/search
{
  "organization_name": "{company_name}",
  "person_titles": [
    "VP Operations", "SVP Operations", "Vice President Operations",
    "Chief Operating Officer", "COO",
    "Director Contact Center", "Head of Contact Center",
    "VP Customer Experience",
    "CTO", "VP Engineering",
    "Director Loan Servicing", "Director Mortgage Operations"
  ],
  "person_seniorities": ["vp", "director", "c_suite"],
  "per_page": 5
}
```

**Node 4: Claude — DM Verification**
Type: HTTP Request → Anthropic API with web search
```
System: You are verifying whether a person is the right decision maker to buy an AI voice calling platform for a call center.
User: I found these people at {company_name}:
{list of names + titles from Apollo}

The right DM is someone who:
- Controls call center / phone operations budget
- Can sign a $100K+ annual contract
- Is NOT a recruiter, individual agent, or someone too junior
- Has been in their role 3+ months

For the BEST match, verify via web search:
- Are they currently at this company?
- Does their LinkedIn show relevant operations/technology scope?
- Are they the right seniority level?

Return ONLY valid JSON:
{
  "best_match": {
    "name": "full name",
    "title": "exact title",
    "linkedin_url": "verified LinkedIn URL",
    "email": "from Apollo data",
    "confidence": "high/medium/low",
    "why_this_person": "1-2 sentences"
  },
  "backup_contact": {
    "name": "second best option",
    "title": "title",
    "why_backup": "reason"
  }
}
```

**Node 5: HubSpot — Create contact**
Create contact record with all data. Associate with company and deal.

**Node 6: HubSpot — Update deal**
Move to "Contact found — pending review". Set `dm_confidence` property.

**Node 7: HubSpot — Add note**
Note with DM reasoning: why this person, their LinkedIn, confidence level.

**Node 8: Slack notification**
```
Decision maker found:
• Company: {company}
• Contact: {name} — {title}
• Confidence: {confidence}
• LinkedIn: {url}
→ Verify in HubSpot: {deal_url}
```

---

## Human gate 2: contact verification

**What you do:** Open HubSpot. Click the LinkedIn URL. Check:
- Is this person actually at the company?
- Is their title current?
- Do they have operations/technology scope?
- Are they active on LinkedIn (important for LinkedIn outreach)?

**Action:** Move deal to "Contact approved" or back to "Finding contact" (if wrong person, Workflow 2 will re-run with additional context).

---

## n8n workflow 3: ROI + outreach generation

**Trigger:** Webhook (from HubSpot automation when deal → "Contact approved")

### Node-by-node

**Node 1: Webhook trigger**

**Node 2: HubSpot — Get deal + company + contact**
Pull all data accumulated so far.

**Node 3: Claude — ROI Analyst**
Type: HTTP Request → Anthropic API with web search
```
System: You are a financial analyst specializing in contact center economics. Use web search for current salary data. Be precise.
User: Calculate the ROI of Feather AI voice agents vs. hiring human agents for {company_name}.

Known data:
- Company: {company_name} in {industry}
- Location: {location}
- Hiring: {num_openings} phone/call center roles
- Company size: {employees} employees
- Feather pricing: $0.07/minute per call

Research and calculate:
1. Average salary for call center agents in {industry} in {location}
2. Add 30% for benefits + overhead
3. Add $3,000-5,000 per agent for training
4. Estimate calls per agent per day (typically 40-80 in lending)
5. Estimate average call duration (typically 4-8 min in lending)
6. Calculate Feather cost for equivalent call volume
7. Net savings and payback period

Return ONLY valid JSON:
{
  "hiring_cost": {
    "agents": {num_openings},
    "avg_salary": N,
    "with_overhead": N,
    "training": N,
    "total_annual": N
  },
  "feather_cost": {
    "daily_calls_per_agent": N,
    "avg_duration_min": N,
    "total_annual_minutes": N,
    "total_annual_cost": N
  },
  "savings": {
    "annual": N,
    "pct": N,
    "payback_months": N,
    "three_year": N
  },
  "headline": "provocative one-liner with the specific numbers"
}
```

**Node 4: Claude — Copywriter**
Type: HTTP Request → Anthropic API
```
System: You are a B2B outreach copywriter. You write sharp, personalized messages that get responses because they lead with specific, relevant data — never generic pitches.
User: Generate outreach for:

Contact: {dm_name}, {dm_title} at {company_name}
Context: They're hiring {num_openings} call center agents. Job posting: {job_title}
ROI: Feather saves them ${savings}/year ({pct}% reduction)
Industry: {industry}

IMPORTANT RULES:
- Reference the SPECIFIC job posting — show you did your homework
- Lead with the ROI math — make it impossible to ignore
- Keep email under 120 words — busy execs don't read walls
- LinkedIn connection note must be under 300 characters
- The LinkedIn post should NOT name the company — just the math
- Everything should feel like it's from a peer, not a vendor

Generate:

1. COLD EMAIL
- Subject line (under 50 chars, no clickbait)
- Body (under 120 words, specific, helpful)

2. LINKEDIN
- Connection note (under 300 chars, references something specific)
- Follow-up message (under 150 words, sent after they connect)

3. LINKEDIN POST
- A data-driven, provocative post (under 200 words) about the cost of hiring call center agents vs. AI
- Should be genuinely shareable and generate engagement
- Don't name the company — say "a {industry} company" or "a lender I'm tracking"

Return ONLY valid JSON:
{
  "cold_email": { "subject": "", "body": "" },
  "linkedin": { "connection_note": "", "followup": "" },
  "linkedin_post": "",
  "one_liner": "single most compelling line from all of the above"
}
```

**Node 5: HubSpot — Update deal**
Set ALL custom properties: ROI data, email drafts, LinkedIn drafts. Move to "Outreach ready" stage.

**Node 6: HubSpot — Add note**
Comprehensive note with all messaging and ROI breakdown.

**Node 7: HubSpot — Create task**
Task assigned to you: "Review outreach for {company_name} — {dm_name}" due today.

**Node 8: Slack notification**
```
Outreach package ready:
• Company: {company}
• Contact: {dm_name} — {dm_title}
• Annual savings: ${savings}
• Email subject: {subject}
→ Review and edit in HubSpot: {deal_url}
```

---

## Human gate 3: outreach review

**What you do:** Open the deal in HubSpot. Read every piece of messaging:

**Email check:**
- Does the subject line feel natural (not AI-generated)?
- Does the body reference the right job posting?
- Is the ROI math correct?
- Would YOU respond to this email?
- Edit anything that feels off

**LinkedIn check:**
- Is the connection note under 300 chars?
- Does the follow-up reference something specific?
- Is the LinkedIn post provocative but professional?

**Action:** When satisfied:
1. Copy the email and send it manually (or via HubSpot sequences)
2. Send LinkedIn connection request with the note
3. Post the LinkedIn post from the founder's account
4. Move deal to "Outreach sent" in HubSpot
5. Log the activities

---

## Demo walkthrough (30 minutes)

### 0-3 min: The insight
"Every voice AI company prospects the same way — cold emails to generic lists. I found a signal nobody's using: when a lending company posts a job for call center agents, they're publicly announcing they need more phone capacity. That's intent data hiding in plain sight on job boards."

### 3-8 min: Show the system
Open HubSpot. Walk through the pipeline stages. Point out the three human gates.
"Nothing goes out without my eyes on it. The AI does the research, the math, and the drafting. I do the judgment."

Show the ICP scorecard. "Not every hiring signal is a lead. We score on five dimensions. Only companies that score 6+ enter the pipeline."

Show the DM targeting criteria. "We don't just find 'someone' at the company. We target the person who controls the call center budget."

### 8-20 min: Run it live
Open n8n. Trigger Workflow 1 manually. While it runs:
- "Right now Claude is scanning job boards for lending companies hiring phone agents..."
- "Found 8 signals. Now it's qualifying each one against our ICP..."
- "3 companies passed. They're being created in HubSpot right now."

Switch to HubSpot. Show the new deals in "Qualified — pending review."
Open one deal. Show all the enrichment data.
"Everything Claude found is logged here — ICP score, industry, employee count, existing solutions."

Approve the deal (move to "ICP approved"). Show how this triggers Workflow 2.
- "Now it's finding the VP of Operations at this company via Apollo..."

Show the contact created. Click through to LinkedIn. "This is real — that's the actual person."
Approve the contact. Show Workflow 3 triggering.
- "Now it's calculating the specific ROI and drafting all the messaging..."

Open the completed deal. Show the outreach tab. Read the email aloud. "This email references their specific job posting, calculates their exact savings, and is under 120 words."

### 20-25 min: The economics
"Each run costs about $0.80 in API credits and processes 8-12 signals. Three runs a week = 24-36 signals → maybe 10 qualified companies → maybe 4 with verified DMs → 4 complete outreach packages. That's 16 qualified, personalized outreach packages a month for under $15 in API costs. A human doing this research manually would take 2-3 hours per company."

### 25-30 min: What I'd build next
1. **Performance feedback**: Track which email subjects get responses. Feed winning patterns back into the copywriter prompt.
2. **Expand signal sources**: Monitor not just job postings but also LinkedIn posts mentioning "scaling phone ops," company press releases about expansion, and reviews where people complain about current call center tools.
3. **Auto-sequence**: Instead of one email, generate a 3-touch sequence with different angles.
4. **Feather Hiring Index**: Monthly report aggregating all signals into "which lending verticals are scaling phone ops fastest." Publish it as thought leadership. The report itself generates leads.
5. **Competitor churn layer**: Add monitoring for people complaining about Vapi/Retell on Reddit/G2/LinkedIn. Same pipeline, different signal source.

---

## Operational cadence

| When | What | Time |
|------|------|------|
| Daily 7 AM | Workflow 1 runs automatically | 0 min (automated) |
| Daily 8 AM | Review qualified signals in HubSpot | 10 min |
| Daily 8:15 AM | Approve good companies, reject bad ones | 5 min |
| Daily 9 AM | Review DM contacts (triggered automatically) | 5 min |
| Daily 9:15 AM | Review outreach packages (triggered automatically) | 15 min |
| Daily 9:30 AM | Send approved outreach manually | 10 min |
| Weekly | Post 2-3 LinkedIn posts from the pipeline | 15 min |
| Weekly | Review pipeline in HubSpot, follow up on opens/replies | 20 min |

**Total human time: ~45 min/day for 3-5 qualified, researched, personalized outreach packages.**
