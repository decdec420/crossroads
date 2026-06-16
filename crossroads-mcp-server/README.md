# crossroads-mcp-server

A **decision-analysis engine for AI agents**, delivered as an MCP server. Instead of an agent hand-waving its way to a recommendation, it calls Crossroads to get an honest, quantified answer:

- **Probability each option is best** (Monte Carlo over uncertain inputs) — not a fake-confident single pick.
- **Expected value + an 80% range** per option.
- **Dominance** — options beaten on every criterion, which can be eliminated.
- **Sensitivity** — which weight could flip the winner.
- **Value of information (EVPPI)** — the signature feature: *which unknown is worth resolving before you commit.*

It's **pure computation** — no network, no API keys, fully local and reproducible (seeded). That makes it trivially safe to run and easy to distribute.

## Tools

| Tool | What it does |
|------|--------------|
| `crossroads_analyze_decision` | Full analysis: P(best), dominance, sensitivity, value-of-information. Supports risk-adjusted utility or prospect-theory (loss-averse) value models. |
| `crossroads_quick_compare` | Fast weighted compare with P(best), no EVPPI/sensitivity. For simple/low-stakes reads. |

## Install

```bash
cd crossroads-mcp-server
npm install
npm run build      # compiles to dist/
```

## Add it to an MCP client

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "crossroads": {
      "command": "node",
      "args": ["/absolute/path/to/crossroads-mcp-server/dist/index.js"]
    }
  }
}
```

**Claude Code:**
```bash
claude mcp add crossroads -- node /absolute/path/to/crossroads-mcp-server/dist/index.js
```

**Cursor** — add the same `command`/`args` under `mcpServers` in your MCP settings.

Restart the client; the two `crossroads_*` tools become available to the agent.

## Example call

`crossroads_analyze_decision` with:
```json
{
  "title": "Which database?",
  "options": ["Postgres", "DynamoDB"],
  "criteria": [
    { "name": "Cost", "weight": 30, "uncertainty": "low" },
    { "name": "Scalability", "weight": 40, "uncertainty": "med" },
    { "name": "Team familiarity", "weight": 30, "uncertainty": "low" }
  ],
  "scores": {
    "Postgres":  { "Cost": 7, "Scalability": 6, "Team familiarity": 9 },
    "DynamoDB":  { "Cost": 6, "Scalability": 9, "Team familiarity": 4 }
  }
}
```
Returns a ranked recommendation with probabilities, what could flip it, and what to research first.

## Value models

- **utility** (default): risk-adjusted. `risk` from -1 (risk-averse) to +1 (risk-seeking).
- **prospect**: prospect theory — losses below `reference_point` (0–10) weigh `loss_aversion`× more than equal gains (Kahneman–Tversky ≈ 2.25). Use when downside aversion matters.

## Method

Each 0–10 score is widened to a triangular distribution by its confidence (low/med/high → ±1/±2/±3), mapped through the value function, and simulated thousands of times. EVPPI is a nested Monte Carlo. Identical inputs + seed ⇒ identical output.

## License

MIT.
