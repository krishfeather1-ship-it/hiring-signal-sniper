# Setup guide: zero to running pipeline

## Step 1: Start n8n (5 min)

```bash
# Clone the hiring-sniper directory (or create it with the files)
cd hiring-sniper

# Start n8n
docker compose up -d

# Verify it's running
open http://localhost:5678
```

Create your n8n account when prompted. You'll see the workflow editor.

---

## Step 2: Set up HubSpot (20 min)

### 2a. Create a free HubSpot account
Go to https://app.hubspot.com/signup — the free CRM plan works.

### 2b. Create a Private App (for API access)
1. Settings → Integrations → Private Apps → Create private app
2. Name: "Hiring Signal Sniper"
3. Scopes — enable ALL of these:
   - `crm.objects.companies.write`
   - `crm.objects.companies.read`
   - `crm.objects.contacts.write`
   - `crm.objects.contacts.read`
   - `crm.objects.deals.write`
   - `crm.objects.deals.read`
   - `crm.objects.custom.write` (for notes/tasks)
   - `crm.objects.custom.read`
4. Create app → copy the **access token**

### 2c. Create the deal pipeline
1. Settings → Objects → Deals → Pipelines
2. Create pipeline: "Hiring Signal Pipeline"
3. Add these stages (in order):
   - `Signal detected` (internal name: `signaldetected`)
   - `Qualifying` (internal name: `qualifying`)
   - `Qualified — pending review` (internal name: `qualifiedpendingreview`)
   - `ICP rejected` (internal name: `icprejected`, mark as "Closed lost")
   - `ICP approved` (internal name: `icpapproved`)
   - `Finding contact` (internal name: `findingcontact`)
   - `Contact found — pending review` (internal name: `contactfoundpendingreview`)
   - `Contact approved` (internal name: `contactapproved`)
   - `Generating outreach` (internal name: `generatingoutreach`)
   - `Outreach ready` (internal name: `outreachready`)
   - `Outreach sent` (internal name: `outreachsent`)
   - `Meeting booked` (internal name: `meetingbooked`)
   - `Closed won` (internal name: `closedwon`, mark as "Closed won")
   - `Closed lost` (internal name: `closedlost`, mark as "Closed lost")

### 2d. Create custom deal properties
Settings → Properties → Deal properties → Create property:

| Property name | Internal name | Type |
|---------------|---------------|------|
| Signal source | `signal_source` | Single-line text |
| Job title detected | `job_title_detected` | Single-line text |
| Job posting URL | `job_posting_url` | Single-line text |
| Number of openings | `num_openings` | Number |
| ICP score | `icp_score` | Number |
| Has existing solution | `has_existing_solution` | Single checkbox |
| Existing solution name | `existing_solution_name` | Single-line text |
| Current hiring cost | `current_hiring_cost` | Number |
| Feather cost | `feather_cost` | Number |
| Annual savings | `annual_savings` | Number |
| ROI headline | `roi_headline` | Single-line text |
| Email subject | `email_subject` | Single-line text |
| Email body | `email_body` | Multi-line text |
| LinkedIn connection note | `linkedin_connection_note` | Single-line text |
| LinkedIn followup | `linkedin_followup` | Multi-line text |
| LinkedIn post draft | `linkedin_post_draft` | Multi-line text |
| DM confidence | `dm_confidence` | Dropdown (high/medium/low) |

### 2e. Create HubSpot workflow automations
Automation → Workflows → Create workflow → Deal-based:

**Workflow A: "Trigger DM Search"**
- Trigger: Deal pipeline stage = "ICP approved"
- Action: Send webhook
  - Method: POST
  - URL: `http://YOUR_N8N_URL/webhook/hiring-sniper-find-dm`
  - Body: `{ "dealId": {{dealId}} }`

**Workflow B: "Trigger Outreach Gen"**
- Trigger: Deal pipeline stage = "Contact approved"
- Action: Send webhook
  - Method: POST
  - URL: `http://YOUR_N8N_URL/webhook/hiring-sniper-outreach`
  - Body: `{ "dealId": {{dealId}} }`

NOTE: For local dev, use n8n's test webhook URLs. For production, you'll need n8n accessible via a public URL (use the tunnel feature or deploy to a VPS).

---

## Step 3: Get API keys (10 min)

### Anthropic API key
1. Go to https://console.anthropic.com
2. Create API key
3. Add credits ($5 is plenty to start)

### Apollo.io API key
1. Sign up at https://app.apollo.io (free plan = 10K credits/month)
2. Settings → API → Copy your API key

### Slack webhook (optional)
1. Go to https://api.slack.com/apps → Create New App
2. Incoming Webhooks → Activate → Add New Webhook to Workspace
3. Choose channel (e.g., #hiring-signals)
4. Copy the webhook URL

---

## Step 4: Configure n8n credentials (10 min)

In n8n (http://localhost:5678):

### Credential 1: Anthropic API Key
1. Credentials → Add Credential → Header Auth
2. Name: `Anthropic API Key`
3. Name: `x-api-key`
4. Value: `sk-ant-...your key...`

### Credential 2: HubSpot Private App
1. Credentials → Add Credential → Header Auth
2. Name: `HubSpot Private App`
3. Name: `Authorization`
4. Value: `Bearer pat-na1-...your token...`

### Credential 3: Apollo API Key
1. Credentials → Add Credential → Header Auth
2. Name: `Apollo API Key`
3. Name: `X-Api-Key`
4. Value: `...your Apollo key...`

---

## Step 5: Import workflows (5 min)

1. In n8n, click "Add workflow" → Import from File
2. Import `workflow-1-scan-qualify.json`
3. Import `workflow-2-find-dm.json`
4. Import `workflow-3-roi-outreach.json`

For each workflow after import:
1. Open each HTTP Request node
2. Assign the correct credential (Anthropic, HubSpot, or Apollo)
3. Update the Slack webhook URL in the Slack nodes

---

## Step 6: Test the pipeline (15 min)

### Test Workflow 1
1. Open "Hiring Sniper — 1. Scan & Qualify"
2. Click the "Manual Run" trigger
3. Click "Execute Workflow"
4. Watch each node execute — check the output at each step
5. Verify: deals appear in HubSpot in "Qualified — pending review"

### Test the human gate
1. Open HubSpot → Deals → "Hiring Signal Pipeline"
2. Find a qualified deal
3. Review the ICP score and reasoning
4. Drag the deal to "ICP approved"
5. This should trigger Workflow 2 via the HubSpot webhook

### Test Workflow 2
1. Check n8n — Workflow 2 should have been triggered
2. Verify: a contact was created in HubSpot
3. Verify: the deal moved to "Contact found — pending review"
4. Review the contact in HubSpot — check LinkedIn URL
5. Move deal to "Contact approved" to trigger Workflow 3

### Test Workflow 3
1. Check n8n — Workflow 3 should have been triggered
2. Verify: deal updated with ROI data and messaging drafts
3. Verify: a note was added with the full outreach package
4. Verify: a task was created
5. Read through the email and LinkedIn drafts

---

## Troubleshooting

**"Claude: Scan Signals" fails**
- Check Anthropic API key is set correctly
- Check you have credits on your Anthropic account
- Increase timeout if needed (currently 120s)

**HubSpot nodes fail with 401**
- Verify the Bearer token format: `Bearer pat-na1-xxxxx`
- Check all required scopes are enabled on the Private App

**HubSpot deal creation fails with "property doesn't exist"**
- Custom properties must be created BEFORE importing workflows
- Double-check internal names match exactly

**Apollo returns empty results**
- The free plan has limited data — some companies may not be in their database
- The Claude: Verify DM node has a fallback that uses web search instead

**Webhook not triggering Workflow 2/3**
- For local dev: n8n must be accessible from the internet
- Use `docker compose` with the tunnel option, or deploy to a VPS
- For testing: manually trigger Workflow 2/3 with a test webhook payload:
  ```json
  { "dealId": "YOUR_DEAL_ID_FROM_HUBSPOT" }
  ```

---

## For the interview demo

If webhooks aren't working (common in local dev), you can demo the full flow manually:

1. Run Workflow 1 → show deals appearing in HubSpot
2. Approve a deal in HubSpot → manually trigger Workflow 2 with that deal ID
3. Review contact → manually trigger Workflow 3 with that deal ID
4. Show the complete outreach package in HubSpot

The key demo moments:
- "Watch the signals appear in HubSpot in real time"
- "I review and approve — nothing goes out without my eyes on it"
- "Look at the ROI math — specific to this company"
- "The email references their actual job posting"
- "45 minutes a day, $15/month in API costs"
