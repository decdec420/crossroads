#!/usr/bin/env node
/**
 * crossroads-mcp-server
 *
 * A decision-analysis engine for AI agents. Instead of hand-waving a recommendation,
 * an agent calls these tools to get an honest, uncertainty-aware answer:
 * probability each option is best, expected value with a credible interval,
 * which options can be eliminated, what could flip the winner, and — uniquely —
 * which unknown is worth resolving BEFORE committing (value of information).
 *
 * Pure computation: no network, no API keys, fully local and reproducible.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyze, AnalyzeInput, AnalyzeResult } from "./engine.js";

const VERSION = "1.0.0";

const criterionSchema = z
  .object({
    name: z.string().min(1).describe("Criterion name, e.g. 'Cost' or 'Growth potential'."),
    weight: z.number().min(0).max(100).default(50).describe("Relative importance 0–100 (normalized internally). Higher = matters more."),
    uncertainty: z
      .enum(["low", "med", "high"])
      .default("med")
      .describe("How unsure you are about this criterion's scores: low (±1), med (±2), high (±3). Drives the value-of-information analysis."),
  })
  .strict();

const analyzeShape = {
  title: z.string().optional().describe("Short label for the decision, e.g. 'Which vendor to choose?'"),
  options: z.array(z.string().min(1)).min(2).describe("The choices being decided between (≥2), by name. Names are used as keys in `scores`."),
  criteria: z.array(criterionSchema).min(1).describe("The factors that matter, each with a weight (0–100) and a confidence level."),
  scores: z
    .record(z.string(), z.record(z.string(), z.number().min(0).max(10)))
    .describe(
      "How good each option is on each criterion, 0 (poor) to 10 (excellent). Nested by NAME: scores[optionName][criterionName] = number. Missing cells default to 5 (neutral) with a warning."
    ),
  model: z
    .enum(["utility", "prospect"])
    .default("utility")
    .describe("Value model. 'utility' = risk-adjusted (use with `risk`). 'prospect' = prospect theory: losses below the reference point hurt more than equivalent gains (use with `reference_point` and `loss_aversion`)."),
  risk: z.number().min(-1).max(1).default(0).describe("Risk attitude for the 'utility' model: -1 strongly risk-averse, 0 neutral, +1 risk-seeking."),
  reference_point: z.number().min(0).max(10).default(5).describe("For 'prospect' model: the 0–10 score that counts as the break-even baseline; outcomes below it register as losses."),
  loss_aversion: z.number().min(1).max(4).default(2.25).describe("For 'prospect' model: how much more a loss hurts than an equal gain (Kahneman–Tversky ≈ 2.25)."),
  trials: z.number().int().min(500).max(50000).default(6000).describe("Monte-Carlo trials. More = smoother, slower. 6000 is plenty for most decisions."),
  seed: z.number().int().optional().describe("Optional RNG seed for exact reproducibility. Omit to derive deterministically from the inputs."),
  value_of_information: z.boolean().default(true).describe("Compute EVPPI — which unknown to resolve first. Slightly slower; the signature feature. Set false for a quick read."),
  response_format: z.enum(["markdown", "json"]).default("markdown").describe("'markdown' for a readable brief, 'json' for the structured result as text. Structured data is always returned in structuredContent."),
};

const quickShape = {
  options: z.array(z.string().min(1)).min(2).describe("The choices (≥2), by name."),
  criteria: z.array(criterionSchema).min(1).describe("Factors with weights (uncertainty optional)."),
  scores: z.record(z.string(), z.record(z.string(), z.number().min(0).max(10))).describe("scores[optionName][criterionName] = 0–10."),
};

function structured(r: AnalyzeResult): Omit<AnalyzeResult, "markdown"> {
  const { markdown, ...rest } = r;
  void markdown;
  return rest;
}

const server = new McpServer({ name: "crossroads-mcp-server", version: VERSION });

server.registerTool(
  "crossroads_analyze_decision",
  {
    title: "Analyze a decision under uncertainty",
    description: `Run a rigorous multi-criteria decision analysis and return an honest, quantified recommendation.

Use this when you must choose among options and want more than a gut call: it treats every score as uncertain, runs a Monte-Carlo simulation, and reports the probability each option is best — not a fake-confident single answer. It also tells you which unknown is most worth resolving before committing.

WHEN TO USE
- Comparing vendors, candidates, tools, designs, strategies, places, offers — anything with 2+ options and multiple criteria.
- When you want a defensible, reproducible recommendation with its reasoning.

INPUTS
- options: string[] (≥2) — the choices, by name.
- criteria: [{ name, weight 0–100, uncertainty 'low'|'med'|'high' }] — what matters and how sure you are.
- scores: { [optionName]: { [criterionName]: 0–10 } } — how good each option is on each criterion. Missing => 5 (neutral) + warning.
- model: 'utility' (risk-adjusted, with risk -1..1) or 'prospect' (loss aversion around reference_point, loss_aversion≈2.25).
- trials, seed, value_of_information, response_format — optional tuning.

RETURNS (structuredContent)
{
  leader: string,                       // best bet
  confidence: 'confident'|'leaning'|'toss-up',
  ranking: [{ name, pBestPct, expectedValue/100, low, high }],  // sorted best-first; low/high = 80% range
  dominated: string[],                  // options beaten on every criterion (eliminable)
  evpi: number,                         // value of perfect information (0–100)
  valueOfInformation: [{ criterion, value }],  // sorted; what to research first
  researchFirst: string|null,
  sensitivity: [{ criterion, swing, canFlip }],// what could flip the winner
  warnings: string[]
}

GUIDANCE FOR THE AGENT
- Report the leader WITH its probability and confidence. If 'toss-up', say so plainly — do not overstate.
- If researchFirst is set, recommend resolving that unknown before committing.
- Mention any dominated options can be dropped.

Examples
- "Pick a database for our app" -> options=["Postgres","DynamoDB"], criteria=[{name:"Cost",weight:30,uncertainty:"low"},{name:"Scalability",weight:40,uncertainty:"med"},{name:"Team familiarity",weight:30,uncertainty:"low"}], scores accordingly.
- Don't use for single-option yes/no questions (need ≥2 options).`,
    inputSchema: analyzeShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      const input: AnalyzeInput = {
        title: args.title,
        options: args.options,
        criteria: args.criteria,
        scores: args.scores ?? {},
        model: args.model,
        risk: args.risk,
        reference_point: args.reference_point,
        loss_aversion: args.loss_aversion,
        trials: args.trials,
        seed: args.seed,
        value_of_information: args.value_of_information,
      };
      const r = analyze(input);
      const text = args.response_format === "json" ? JSON.stringify(structured(r), null, 2) : r.markdown;
      return { content: [{ type: "text" as const, text }], structuredContent: structured(r) };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }
);

server.registerTool(
  "crossroads_quick_compare",
  {
    title: "Quick weighted compare",
    description: `A fast, lightweight version of crossroads_analyze_decision: weighted multi-criteria scoring with probability-of-best, but no value-of-information or sensitivity pass. Use for simple, low-stakes comparisons or a first read. Inputs: options (≥2), criteria ([{name, weight}]), scores ({[option]:{[criterion]:0–10}}). Returns the same structuredContent shape (valueOfInformation empty). For high-stakes decisions or 'what should I research first?', use crossroads_analyze_decision instead.`,
    inputSchema: quickShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      const input: AnalyzeInput = {
        options: args.options,
        criteria: args.criteria,
        scores: args.scores ?? {},
        model: "utility",
        risk: 0,
        reference_point: 5,
        loss_aversion: 2.25,
        trials: 4000,
        value_of_information: false,
      };
      const r = analyze(input);
      return { content: [{ type: "text" as const, text: r.markdown }], structuredContent: structured(r) };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }
);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      `crossroads-mcp-server v${VERSION}\n` +
        `A decision-analysis engine (MCP server) for AI agents.\n\n` +
        `Tools: crossroads_analyze_decision, crossroads_quick_compare\n` +
        `Transport: stdio. Add to an MCP client (Claude Desktop/Code, Cursor) — see README.\n`
    );
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(VERSION + "\n");
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("crossroads-mcp-server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
