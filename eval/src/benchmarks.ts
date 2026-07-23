import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The single most task-appropriate benchmark per task type — the "accuracy where
 * you need it" yardstick (KPI lens 3). Read from docs/process/model-scores.json.
 */
export const TASK_BENCHMARK: Record<string, string> = {
  reasoning: "GPQA_Diamond",
  coding: "SWE_bench_Verified",
  math: "AIME",
  knowledge_qa: "MMLU",
  instruction_following: "IFEval",
  long_context: "MRCR",
};

interface ScoreModel {
  model_id: string;
  categories: Record<string, { score: number | null }>;
}

let cache: Map<string, ScoreModel> | null = null;
function load(): Map<string, ScoreModel> {
  if (cache) return cache;
  const path = join(process.cwd(), "docs", "process", "model-scores.json");
  const doc = JSON.parse(readFileSync(path, "utf-8")) as { models: ScoreModel[] };
  cache = new Map(doc.models.map((m) => [m.model_id, m]));
  return cache;
}

/**
 * The task-appropriate benchmark score (0–100) for a model, or the category
 * aggregate if that specific benchmark is unpublished. Null when neither exists.
 */
export function taskBenchmark(modelId: string, task: string): { benchmark: string; score: number } | null {
  const m = load().get(modelId);
  const cat = m?.categories[task];
  if (!cat || cat.score == null) return null;
  // model-scores.json stores the per-task capability score (0–100) derived from
  // the task-appropriate benchmark(s); we label it with the primary benchmark.
  return { benchmark: TASK_BENCHMARK[task] ?? task, score: cat.score };
}
