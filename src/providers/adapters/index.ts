import type { ProviderAdapter } from "../adapter.js";
import { anthropicAdapter } from "./anthropic.js";
import { passthroughAdapter } from "./passthrough.js";

/** Adapter registry. Provider config selects one by name via `adapter:`. */
const ADAPTERS: Record<string, ProviderAdapter> = {
  openai: passthroughAdapter,
  passthrough: passthroughAdapter,
  anthropic: anthropicAdapter,
};

export function getAdapter(name: string | undefined): ProviderAdapter {
  return (name && ADAPTERS[name]) || passthroughAdapter;
}

export function adapterNames(): string[] {
  return Object.keys(ADAPTERS);
}
