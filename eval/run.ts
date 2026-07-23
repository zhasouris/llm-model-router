/**
 * Eval CLI (dry-run). Hermetic — uses the deterministic heuristic provider.
 *
 *   npm run eval -- --dataset eval/datasets/curated.jsonl --strategies best,value
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { HeuristicSignalProvider, RouteLLMProvider, type SignalProvider } from "../src/core/signal.js";
import { isStrategy, type Strategy } from "../src/types.js";
import { loadDataset } from "./src/dataset.js";
import { aggregate, toMarkdown, type Report } from "./src/report.js";
import { runEval } from "./src/runner.js";

interface Args {
  dataset: string;
  strategies?: Strategy[];
  out: string;
  provider: string;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key) args[key] = argv[i + 1] ?? "";
  }
  let strategies: Strategy[] | undefined;
  if (args.strategies) {
    strategies = args.strategies
      .split(",")
      .map((s) => s.trim())
      .filter(isStrategy);
  }
  return {
    dataset: args.dataset ?? "eval/datasets/curated.jsonl",
    strategies,
    out: args.out ?? "eval/out",
    provider: args.provider ?? "heuristic",
  };
}

function makeProvider(name: string): SignalProvider {
  if (name === "routellm") {
    return new RouteLLMProvider(process.env.ROUTELLM_URL ?? "http://localhost:8001");
  }
  return new HeuristicSignalProvider();
}

async function main(): Promise<void> {
  const { dataset: datasetPath, strategies, out, provider: providerName } = parseArgs(
    process.argv.slice(2),
  );
  const dataset = loadDataset(datasetPath);
  const provider = makeProvider(providerName);
  const results = await runEval(dataset, { strategies, provider });
  const stats = aggregate(results);

  const report: Report = {
    dataset: datasetPath,
    scenarios: dataset.length,
    provider: provider.name,
    stats,
  };
  const md = toMarkdown(report);

  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/report.json`, JSON.stringify({ report, results }, null, 2));
  writeFileSync(`${out}/report.md`, md);
  console.log(md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
