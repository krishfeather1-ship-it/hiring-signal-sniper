#!/bin/bash
# Sets up HubSpot pipeline, stages, and custom deal properties via API
# Usage: HUBSPOT_TOKEN=pat-na1-xxxxx bash setup-hubspot.sh

set -e

if [ -z "$HUBSPOT_TOKEN" ]; then
    if [ -f .env ]; then source .env; fi
    if [ -z "$HUBSPOT_TOKEN" ]; then
        read -p "HubSpot Private App token (pat-na1-...): " HUBSPOT_TOKEN
    fi
fi

API="https://api.hubapi.com"
AUTH="Authorization: Bearer $HUBSPOT_TOKEN"
CT="Content-Type: application/json"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

call() {
    local method=$1 url=$2 data=$3
    local resp
    if [ -n "$data" ]; then
        resp=$(curl -s -w "\n%{http_code}" -X "$method" "$API$url" -H "$AUTH" -H "$CT" -d "$data")
    else
        resp=$(curl -s -w "\n%{http_code}" -X "$method" "$API$url" -H "$AUTH" -H "$CT")
    fi
    local code=$(echo "$resp" | tail -1)
    local body=$(echo "$resp" | head -n -1)
    if [[ "$code" =~ ^2 ]]; then
        echo "$body"
        return 0
    else
        echo "HTTP $code: $body" >&2
        return 1
    fi
}

echo "Setting up HubSpot for Hiring Signal Sniper..."
echo ""

# 1. Create deal pipeline
echo "Creating deal pipeline..."
PIPELINE=$(call POST "/crm/v3/pipelines/deals" '{
  "label": "Hiring Signal Pipeline",
  "displayOrder": 1,
  "stages": [
    {"label": "Signal detected", "displayOrder": 0, "metadata": {"probability": "0.1"}},
    {"label": "Qualifying", "displayOrder": 1, "metadata": {"probability": "0.1"}},
    {"label": "Qualified — pending review", "displayOrder": 2, "metadata": {"probability": "0.2"}},
    {"label": "ICP rejected", "displayOrder": 3, "metadata": {"probability": "0.0"}},
    {"label": "ICP approved", "displayOrder": 4, "metadata": {"probability": "0.3"}},
    {"label": "Finding contact", "displayOrder": 5, "metadata": {"probability": "0.3"}},
    {"label": "Contact found — pending review", "displayOrder": 6, "metadata": {"probability": "0.4"}},
    {"label": "Contact approved", "displayOrder": 7, "metadata": {"probability": "0.5"}},
    {"label": "Generating outreach", "displayOrder": 8, "metadata": {"probability": "0.5"}},
    {"label": "Outreach ready", "displayOrder": 9, "metadata": {"probability": "0.6"}},
    {"label": "Outreach sent", "displayOrder": 10, "metadata": {"probability": "0.7"}},
    {"label": "Meeting booked", "displayOrder": 11, "metadata": {"probability": "0.8"}},
    {"label": "Closed won", "displayOrder": 12, "metadata": {"probability": "1.0"}},
    {"label": "Closed lost", "displayOrder": 13, "metadata": {"probability": "0.0"}}
  ]
}' 2>&1)

if echo "$PIPELINE" | grep -q '"id"'; then
    PIPELINE_ID=$(echo "$PIPELINE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "unknown")
    echo -e "${GREEN}✓ Pipeline created (ID: $PIPELINE_ID)${NC}"
    
    # Extract stage IDs for reference
    echo "$PIPELINE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print('  Stage IDs:')
for s in data.get('stages', []):
    print(f\"    {s['label']}: {s['id']}\")
" 2>/dev/null || true
else
    echo -e "${RED}Pipeline creation failed (may already exist). Continuing...${NC}"
    echo "  $PIPELINE"
fi
echo ""

# 2. Create custom deal properties
echo "Creating custom deal properties..."

create_prop() {
    local name=$1 label=$2 type=$3 field=$4
    local data="{\"name\":\"$name\",\"label\":\"$label\",\"type\":\"$type\",\"fieldType\":\"$field\",\"groupName\":\"dealinformation\"}"
    local result
    result=$(call POST "/crm/v3/properties/deals" "$data" 2>&1)
    if echo "$result" | grep -q '"name"'; then
        echo -e "  ${GREEN}✓ $label${NC}"
    elif echo "$result" | grep -q "already exists"; then
        echo -e "  ${GREEN}✓ $label (already exists)${NC}"
    else
        echo -e "  ${RED}✗ $label: $result${NC}"
    fi
}

create_prop "signal_source" "Signal source" "string" "text"
create_prop "job_title_detected" "Job title detected" "string" "text"
create_prop "job_posting_url" "Job posting URL" "string" "text"
create_prop "num_openings" "Number of openings" "number" "number"
create_prop "icp_score" "ICP score" "number" "number"
create_prop "has_existing_solution" "Has existing AI voice solution" "enumeration" "booleancheckbox"
create_prop "existing_solution_name" "Existing solution name" "string" "text"
create_prop "current_hiring_cost" "Current hiring cost" "number" "number"
create_prop "feather_cost" "Feather cost" "number" "number"
create_prop "annual_savings" "Annual savings" "number" "number"
create_prop "roi_headline" "ROI headline" "string" "text"
create_prop "email_subject" "Email subject draft" "string" "text"
create_prop "email_body" "Email body draft" "string" "textarea"
create_prop "linkedin_connection_note" "LinkedIn connection note" "string" "text"
create_prop "linkedin_followup" "LinkedIn followup draft" "string" "textarea"
create_prop "linkedin_post_draft" "LinkedIn post draft" "string" "textarea"
create_prop "dm_confidence" "DM confidence" "string" "text"
create_prop "estimated_contract_value" "Estimated contract value" "string" "text"

echo ""

# 3. Create custom contact property
echo "Creating custom contact properties..."
call POST "/crm/v3/properties/contacts" '{
  "name": "source_workflow",
  "label": "Source workflow",
  "type": "string",
  "fieldType": "text",
  "groupName": "contactinformation"
}' > /dev/null 2>&1 && echo -e "  ${GREEN}✓ Source workflow${NC}" || echo -e "  ${GREEN}✓ Source workflow (already exists)${NC}"

call POST "/crm/v3/properties/contacts" '{
  "name": "dm_verified",
  "label": "DM verified",
  "type": "enumeration",
  "fieldType": "booleancheckbox",
  "groupName": "contactinformation",
  "options": [{"label": "Yes", "value": "true"}, {"label": "No", "value": "false"}]
}' > /dev/null 2>&1 && echo -e "  ${GREEN}✓ DM verified${NC}" || echo -e "  ${GREEN}✓ DM verified (already exists)${NC}"

echo ""
echo "======================================="
echo -e "${GREEN}HubSpot setup complete!${NC}"
echo "======================================="
echo ""
echo "Pipeline ID: $PIPELINE_ID"
echo ""
echo "IMPORTANT — note the stage IDs above. You'll need to update"
echo "the dealstage values in the n8n workflow JSON files to match"
echo "the actual stage IDs HubSpot assigned."
echo ""
echo "Next: Set up HubSpot workflows to trigger n8n webhooks."
echo "  1. Go to HubSpot → Automation → Workflows"
echo "  2. Create deal-based workflow: 'ICP approved' stage → webhook POST"
echo "  3. Create deal-based workflow: 'Contact approved' stage → webhook POST"
echo "  (See SETUP.md for webhook URLs)"
