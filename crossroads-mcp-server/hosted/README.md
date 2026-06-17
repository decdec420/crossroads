# Crossroads — Hosted, Metered MCP

A **remote** Model Context Protocol endpoint so any AI agent can ground a recommendation in a verifiable, reproducible decision computation instead of hallucinating one. Same engine as the local MCP, but hosted, API-key gated, and metered per call against a monthly quota.

> "I ran 6,000 simulations — Option A wins 84%, here's the 80% range, and the one thing worth resolving first" beats a confident guess. This is the anti-hallucination layer for agent decisions.

Deployed as the Supabase Edge Function **`mcp`** (`verify_jwt` off — auth is the API key). Pure computation: no user data, no model calls.

## Endpoint

```
POST https://rgbgstcipidkrcjofins.supabase.co/functions/v1/mcp
```

Transport: HTTP JSON-RPC 2.0 (MCP). Returns `application/json`, or a single SSE event if the client sends `Accept: text/event-stream`.

## Auth

Send your key as either header:

```
x-api-key: cr_live_xxx
# or
Authorization: Bearer cr_live_xxx
```

Keys are minted per user via the `mint_api_key()` RPC (the web app exposes this; the raw key is shown once and only its SHA-256 hash is stored). Errors: `-32001` invalid/missing key, `-32003` monthly quota exceeded.

## Plans & quota

| Plan | Calls / month |
|------|---------------|
| free | 100 |
| pro | 10,000 |
| team | 50,000 |

Only `tools/call` is billed; `initialize`/`tools/list`/`ping` are free (but still require a valid key).

## Tools

- `crossroads_analyze_decision` — P(best), dominance, sensitivity, and value-of-information (what to research first); risk-utility or prospect-theory value models.
- `crossroads_quick_compare` — fast weighted compare, no value-of-information.

## Quick test (curl)

List tools:
```bash
curl -s https://rgbgstcipidkrcjofins.supabase.co/functions/v1/mcp \
  -H "x-api-key: $CROSSROADS_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Run an analysis:
```bash
curl -s https://rgbgstcipidkrcjofins.supabase.co/functions/v1/mcp \
  -H "x-api-key: $CROSSROADS_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"crossroads_analyze_decision",
        "arguments":{
          "title":"Which database?",
          "options":["Postgres","DynamoDB"],
          "criteria":[
            {"name":"Cost","weight":30,"uncertainty":"low"},
            {"name":"Scalability","weight":40,"uncertainty":"med"},
            {"name":"Team familiarity","weight":30,"uncertainty":"low"}],
          "scores":{
            "Postgres":{"Cost":7,"Scalability":6,"Team familiarity":9},
            "DynamoDB":{"Cost":6,"Scalability":9,"Team familiarity":4}}}}}'
```

## Connect an AI agent

Clients with native remote-MCP support: point them at the endpoint URL and add the `x-api-key` header.

Stdio-only clients (Claude Desktop, Cursor) via the `mcp-remote` bridge:
```json
{
  "mcpServers": {
    "crossroads": {
      "command": "npx",
      "args": ["mcp-remote", "https://rgbgstcipidkrcjofins.supabase.co/functions/v1/mcp",
               "--header", "x-api-key: cr_live_xxx"]
    }
  }
}
```

## Architecture

`api_keys` (hashed) + `api_usage` (monthly counter) tables; `mcp_meter()` is a SECURITY DEFINER function — callable only by the edge function's service role — that validates the key, enforces the plan quota, and atomically increments usage. The local (free, unmetered) MCP lives one directory up.
