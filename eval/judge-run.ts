/**
 * Phase 2 CLI — measure the router's judgment-call accuracy against
 * quality-derived ground truth. MAKES REAL MODEL CALLS (spends). Gated behind
 * this explicit command; not part of the hermetic suite.
 *
 *   npm run eval:judge -- --strategy value
 *
 * Requires OPENAI_API_KEY. Weak/strong/judge models are configurable via env.
 */

import OpenAI from "openai";
import { getConfig } from "../src/config.js";
import { makeAnalyze } from "../src/core/analysis.js";
import { Router } from "../src/core/router.js";
import { HeuristicSignalProvider } from "../src/core/signal.js";
import { isStrategy, type RoutingRequest, type Strategy } from "../src/types.js";
import { loadDataset } from "./src/dataset.js";
import {
  classify,
  deriveGroundTruth,
  summarize,
  type Judge,
  type ModelCaller,
  type Outcome,
} from "./src/judge.js";

const WEAK = process.env.JUDGE_WEAK_MODEL ?? "gpt-4.1-nano";
const STRONG = process.env.JUDGE_STRONG_MODEL ?? "gpt-4.1";
const JUDGE = process.env.JUDGE_MODEL ?? "gpt-4.1-mini";
const STRONG_TIER_THRESHOLD = Number(process.env.JUDGE_STRONG_TIER ?? 4);

function client(): OpenAI {
  const config = getConfig();
  const provider = config.server.providers["openai"]!;
  return new OpenAI({
    baseURL: provider.base_url,
    apiKey: config.providerApiKey("openai") ?? "missing",
    maxRetries: 1,
  });
}

const oa = client();

const caller: ModelCaller = {
  async complete(model, prompt) {
    const r = await oa.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400,
      temperature: 0,
    });
    return r.choices[0]?.message?.content ?? "";
  },
};

const judge: Judge = {
  async strongBetter(prompt, weak, strong) {
    const r = await oa.chat.completions.create({
      model: JUDGE,
      messages: [
        {
          role: "system",
          content:
            "Compare two AI answers to the same prompt. Decide if Answer B is " +
            "MEANINGFULLY better than Answer A — in correctness/completeness/" +
            "usefulness, not just style. Respond with a single JSON object: " +
            '{"strongBetter": boolean, "margin": number between 0 and 1}.',
        },
        { role: "user", content: `PROMPT:\n${prompt}\n\nAnswer A:\n${weak}\n\nAnswer B:\n${strong}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 150,
      temperature: 0,
    });
    const data = JSON.parse(r.choices[0]?.message?.content ?? "{}") as {
      strongBetter?: boolean;
      margin?: number;
    };
    return { strongBetter: Boolean(data.strongBetter), margin: Number(data.margin ?? 0) };
  },
};

function promptOf(request: { messages?: { content?: unknown }[] }): string {
  const c = request.messages?.[0]?.content;
  if (typeof c === "string") return c;
  return "";
}

function buildRequest(request: unknown, strategy: Strategy): RoutingRequest {
  return {
    body: request as RoutingRequest["body"],
    options: { strategy, bypass: false, maxCost: null, warnings: [] },
    requiresVision: false,
    requiresTools: false,
    requiresStructuredOutput: false,
    requiresAudio: false,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stratArg = argv[argv.indexOf("--strategy") + 1];
  const strategy: Strategy = stratArg && isStrategy(stratArg) ? stratArg : "value";

  const config = getConfig();
  const byId = new Map(config.catalog.map((m) => [m.id, m]));
  const router = new Router(config, makeAnalyze(new HeuristicSignalProvider()));
  const dataset = loadDataset("eval/datasets/judgment.jsonl");

  console.log(
    `judgment eval | strategy=${strategy} weak=${WEAK} strong=${STRONG} judge=${JUDGE} threshold=tier>=${STRONG_TIER_THRESHOLD}\n`,
  );

  const outcomes: Outcome[] = [];
  for (const sc of dataset) {
    const prompt = promptOf(sc.request);
    const gt = await deriveGroundTruth(prompt, WEAK, STRONG, caller, judge);
    const { decision } = await router.decide(buildRequest(sc.request, strategy));
    const tier = byId.get(decision.modelId)!.tier;
    const outcome = classify(tier, STRONG_TIER_THRESHOLD, gt);
    outcomes.push(outcome);
    console.log(
      `${sc.id.padEnd(22)} strongNeeded=${String(gt.strongNeeded).padEnd(5)} routed=${decision.modelId.padEnd(16)}(t${tier}) -> ${outcome}`,
    );
  }

  const s = summarize(outcomes);
  console.log(
    `\naccuracy=${(s.accuracy * 100).toFixed(0)}%  over-route=${(s.overRouteRate * 100).toFixed(0)}%  under-route=${(s.underRouteRate * 100).toFixed(0)}%  (n=${s.n})`,
  );
  console.log(`counts: ${JSON.stringify(s.counts)}`);
  console.log(`\n~${dataset.length * 3} model calls made (weak+strong+judge per prompt).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
