/**
 * Base-model delta report. Answers "vs. always using ONE model, what did the
 * router save and where did it get sharper?" — two distinct KPIs (cost, targeted
 * accuracy), for best/value/fast. Hermetic dry-run (deterministic heuristic).
 *
 *   npm run eval:baseline -- --base gpt-4.1-mini --dataset eval/datasets/curated.jsonl
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { baselineReport, type BaselineReport, type StrategyStat } from "./src/baseline.js";
import { loadDataset } from "./src/dataset.js";

function parseArgs(argv: string[]): { base: string; dataset: string; out: string } {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    if (k) a[k] = argv[i + 1] ?? "";
  }
  return {
    base: a.base ?? "gpt-4.1-mini",
    dataset: a.dataset ?? "eval/datasets/curated.jsonl",
    out: a.out ?? "eval/out",
  };
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(0)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const sUsd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
const signed = (n: number | null, d = 2) => (n == null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}`);

function strategySection(s: StrategyStat): string {
  const c = s.counts;
  const p = (x: number) => `${Math.round((x / s.n) * 100)}%`;
  const cost = s.cost;
  const acc = s.accuracy;
  return [
    `### Strategy \`${s.strategy}\``,
    "",
    `**Routing vs base:** ${p(c.downgrade)} downgraded · ${p(c.upgrade)} upgraded · ` +
      `${p(c["forced-upgrade"])} forced-upgrade (base can't serve) · ${p(c.unchanged)} unchanged`,
    "",
    "**Cost** *(illustrative units; ratios are what matter)*",
    "",
    "| | |",
    "| --- | --- |",
    `| always-base | ${usd(cost.base)} |`,
    `| routed | ${usd(cost.router)} (**${pct(-cost.netPct)}**) |`,
    `| cost Δ on downgrades | ${sUsd(-cost.savedOnDowngrades)} |`,
    `| cost Δ on upgrades | ${sUsd(cost.spentOnUpgrades)} |`,
    "",
    "**Accuracy — where you need it** *(router − base; benchmark-derived task capability, 0–100)*",
    "",
    `- **Hard prompts** (${acc.needN}, accuracy needed): **${signed(acc.targetedBenchDelta, 1)} pts** ` +
      `(competency ${signed(acc.targetedCompetencyDelta, 3)})`,
    `- Easy prompts (${acc.easyN}): ${signed(acc.easyBenchDelta, 1)} pts ` +
      `(competency ${signed(acc.easyCompetencyDelta, 3)})`,
    "",
  ].join("\n");
}

function toMarkdown(r: BaselineReport): string {
  const head = [
    `# Base-model delta report — always \`${r.base}\``,
    "",
    `Dataset: \`${r.dataset}\` · ${r.scenarios} prompts · signal: heuristic (hermetic).`,
    `Compares the router's pick under each strategy against *always using ${r.base}*.`,
    "Accuracy: **task-appropriate benchmark** (SWE-bench for coding, AIME for math, GPQA for reasoning, …)",
    "and per-task **competency** (ADR 0010). Upgrade/downgrade is by task competency vs the base.",
    "",
  ].join("\n");
  return head + "\n" + r.strategies.map(strategySection).join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = loadDataset(args.dataset);
  const report = await baselineReport(dataset, args.base, args.dataset.split(/[\\/]/).pop() ?? args.dataset);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(`${args.out}/baseline.json`, JSON.stringify(report, null, 2) + "\n");
  const md = toMarkdown(report);
  writeFileSync(`${args.out}/baseline.md`, md + "\n");
  console.log(md);
  console.log(`\nWrote ${args.out}/baseline.md and baseline.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
