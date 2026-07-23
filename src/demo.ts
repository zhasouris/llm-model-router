/**
 * The /demo decision-inspector page (served by the API itself). A prompt box +
 * strategy selector + a sidebar of gold-query presets; on submit it POSTs to
 * /v1/router/explain and renders the router's decision trace human-readably. It
 * never runs the actual completion.
 *
 * Self-contained HTML (inline CSS/JS). The inner script uses string
 * concatenation (no template literals) to avoid clashing with this outer one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Preset {
  id: string;
  label: string;
  strategy: string;
  prompt: string;
  bypass: boolean;
  body: any;
}

/** Load the gold dataset as demo presets. Best-effort — returns [] if absent. */
export function loadPresets(): Preset[] {
  try {
    const path = join(process.cwd(), "eval", "datasets", "gold.jsonl");
    return readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, any>)
      .map((g) => {
        const content = g.request?.messages?.[0]?.content;
        let prompt = "";
        if (typeof content === "string") prompt = content;
        else if (Array.isArray(content)) {
          const part = content.find((p: any) => typeof p?.text === "string");
          prompt = part ? part.text : "(non-text request)";
        }
        return {
          id: g.id as string,
          label: (g.note as string) || (g.id as string),
          strategy: (g.strategy as string) || "value",
          prompt,
          bypass: Boolean(g.bypass),
          body: g.request,
        };
      });
  } catch {
    return [];
  }
}

export interface DemoModel {
  id: string;
  provider: string;
  available: boolean;
}

export interface DemoOptions {
  /** Show a cold-start notice — set on scale-to-zero deployments. */
  coldStartHint?: boolean;
}

export function demoHtml(
  presets: Preset[],
  models: DemoModel[] = [],
  opts: DemoOptions = {},
): string {
  const presetsJson = JSON.stringify(presets).replace(/</g, "\\u003c");
  const availabilityJson = JSON.stringify(
    Object.fromEntries(models.map((m) => [m.id, m.available])),
  ).replace(/</g, "\\u003c");
  // The excluded list carries only model ids, so vendors are looked up here
  // rather than threaded through the explain payload.
  const vendorsJson = JSON.stringify(
    Object.fromEntries(models.map((m) => [m.id, m.provider])),
  ).replace(/</g, "\\u003c");

  // 🟢 routable / ⚪ no key. Carried in the option label because a <select>
  // cannot be styled per-option across browsers.
  const modelOptions = ['<option value="auto">auto (let the router decide)</option>']
    .concat(
      models.map(
        (m) => `<option value="${m.id}">${m.available ? "🟢" : "⚪"} ${m.id}</option>`,
      ),
    )
    .join("");

  const availableCount = models.filter((m) => m.available).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>corgi-ai-gateway — decision inspector</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 1120px;
    margin: 1.5rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .sub { opacity: 0.7; margin-top: 0; font-size: 0.9rem; }
  .coldstart { border: 1px solid #d9770633; background: #d977061a; border-radius: 8px;
    padding: 0.6rem 0.9rem; margin: 0.75rem 0 0; font-size: 0.88rem; }
  .layout { display: flex; gap: 1.25rem; align-items: flex-start; }
  .sidebar { width: 260px; flex-shrink: 0; }
  .main { flex: 1; min-width: 0; }
  .sidebar h2 { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
  button.preset { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
    width: 100%; text-align: left; margin: 0.3rem 0; padding: 0.5rem 0.6rem; border: 1px solid #8883;
    border-radius: 6px; background: transparent; cursor: pointer; font: inherit; }
  button.preset:hover { background: #7c3aed18; border-color: #7c3aed88; }
  .preset .pl { font-size: 0.82rem; }
  .chip { font-size: 0.68rem; padding: 0.05rem 0.4rem; border-radius: 999px; background: #8883; white-space: nowrap; }
  textarea { width: 100%; min-height: 90px; font: inherit; padding: 0.6rem; box-sizing: border-box; }
  .row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.6rem 0; }
  label { font-size: 0.85rem; opacity: 0.8; }
  select, input { font: inherit; padding: 0.35rem; }
  input.key { flex: 1; min-width: 160px; }
  button.go { font: inherit; padding: 0.5rem 1.1rem; cursor: pointer; border-radius: 6px; border: 1px solid #8888; }
  button.go:disabled { opacity: 0.5; cursor: wait; }
  .card { border: 1px solid #8883; border-radius: 8px; padding: 0.8rem 1rem; margin: 0.8rem 0; }
  .banner { font-size: 1.1rem; }
  .banner b { font-size: 1.25rem; }
  .muted { opacity: 0.7; }
  .legend { font-size: 0.8rem; opacity: 0.75; cursor: help; align-self: center; }
  .vendor { font-size: 0.85em; opacity: 0.8; cursor: help; }
  .lat { display: inline-block; margin-left: 0.5rem; padding: 0.05rem 0.45rem; border-radius: 999px;
    background: #8882; font-size: 0.75rem; font-variant-numeric: tabular-nums; vertical-align: middle;
    cursor: help; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #8882; }
  tr.win { background: #7c3aed22; font-weight: 600; }
  /* Outranked the chosen model on score but had no API key to call it with. */
  tr.skipped { opacity: 0.55; }
  tr.skipped td:nth-child(2) { text-decoration: line-through; }
  .tag { display: inline-block; margin-left: 0.4rem; padding: 0.02rem 0.35rem; border-radius: 999px;
    background: #7c3aed33; font-size: 0.7rem; font-weight: 500; vertical-align: middle; }
  .tag.muted { background: #8882; }
  .badges span { display: inline-block; padding: 0.1rem 0.5rem; margin: 0.15rem; border-radius: 999px;
    background: #8882; font-size: 0.8rem; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; font-size: 0.9rem; }
  .warn { color: #b45309; }
  details { margin-top: 0.6rem; }
  pre { overflow-x: auto; background: #8881; padding: 0.6rem; border-radius: 6px; font-size: 0.8rem; }
  .err { color: #b91c1c; }
  @media (max-width: 760px) { .layout { flex-direction: column; } .sidebar { width: auto; } }
</style>
</head>
<body>
  <h1>Router decision inspector</h1>
  <p class="sub">Submit a prompt — or click a gold preset — to see how the router would route it. No completion is run.</p>
  ${
    opts.coldStartHint
      ? `<div class="coldstart">⏳ <b>First request may take a few seconds.</b> This demo scales to zero when idle, so the very first inspection after a quiet spell waits for the container to wake up. Everything after that is fast.</div>`
      : ""
  }

  <div class="layout">
    <aside class="sidebar">
      <h2>Gold presets</h2>
      <div id="presets"></div>
    </aside>

    <main class="main">
      <textarea id="prompt" placeholder="Type a request, e.g. 'Prove the square root of 2 is irrational'"></textarea>
      <div class="row">
        <label>Strategy
          <select id="strategy">
            <option value="value">value</option>
            <option value="best">best</option>
            <option value="fast">fast</option>
          </select>
        </label>
        <label>Force model
          <select id="force">${modelOptions}</select>
        </label>
        <button class="go" id="go">Inspect routing</button>
        <span class="legend" title="A model is routable when this deployment holds an API key for its provider. Models without one are still ranked — the router just can't forward to them.">
          🟢 ${availableCount}/${models.length} routable · ⚪ no key
        </span>
      </div>
      <div id="out"></div>
    </main>
  </div>

<script>
  var PRESETS = ${presetsJson};
  var AVAILABLE = ${availabilityJson};
  var VENDORS = ${vendorsJson};

  // groq (Llama/Gemma inference) and xai (Grok) are easy to confuse at a
  // glance, so the cell carries a tooltip spelling out which is which.
  var VENDOR_HINT = {
    groq: 'Groq - LPU inference for open-weights models (Llama, Gemma). Not xAI.',
    xai: 'xAI - the Grok family. Not Groq.',
    together: 'Together AI - hosted open-weights models',
    google: 'Google - Gemini',
    openai: 'OpenAI',
    anthropic: 'Anthropic - Claude',
    mistral: 'Mistral',
    deepseek: 'DeepSeek',
    cohere: 'Cohere'
  };

  function vendorCell(provider) {
    var p = provider || '-';
    var hint = VENDOR_HINT[p];
    var title = hint ? ' title="' + esc(hint) + '"' : '';
    return '<span class="vendor"' + title + '>' + esc(p) + '</span>';
  }

  /** For rows that carry only a model id (the excluded list). */
  function vendorOf(model) {
    return vendorCell(VENDORS[model]);
  }

  // 🟢 the deployment holds a key for this model's provider; ⚪ it does not, so
  // the model is ranked but could not actually be forwarded to.
  function avail(model) {
    return AVAILABLE[model] ? '🟢' : '⚪';
  }

  // The router scores on capability and price, not on whether a key exists, so
  // the winner can be a model this deployment cannot actually call. Say so here
  // rather than letting it surface later as a 401 from the provider.
  // groq and grok are one letter apart and mean entirely different things:
  // groq is the LPU inference vendor (Llama, Gemma); Grok is xAI's model family,
  // served by the xai provider. Spell it out wherever a provider is blamed.
  // (No backticks here - this script lives inside an outer template literal.)
  function providerLabel(p) {
    if (p === 'groq') return 'groq <span class="muted">(Llama/Gemma inference — not xAI\\u2019s Grok)</span>';
    if (p === 'xai') return 'xai <span class="muted">(Grok)</span>';
    return esc(p);
  }

  function unroutableNote(decision) {
    if (!decision || AVAILABLE[decision.model]) return '';
    return '<br><span class="warn">⚪ no API key for ' + providerLabel(decision.provider) +
      ' — ranked first, but this deployment could not forward to it</span>';
  }
  var btn = document.getElementById('go');
  var out = document.getElementById('out');

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }
  function pct(x) { return Math.round(x * 100) + '%'; }

  // The response headers a real client would read off /v1/chat/completions.
  // /v1/router/explain emits the same set (ADR 0002).
  function headersCard(hdrs) {
    var names = Object.keys(hdrs || {});
    if (!names.length) return '';
    var rows = names.map(function (n) {
      return '<tr><td><code>' + esc(n) + '</code></td><td>' + esc(hdrs[n]) + '</td></tr>';
    }).join('');
    return '<div class="card"><h3>Response headers</h3>' +
      '<p class="muted">What an OpenAI client reads off the real <code>/v1/chat/completions</code> response.</p>' +
      '<table>' + rows + '</table></div>';
  }

  // Routing latency — the proxy's own overhead, excluding any upstream call.
  function latency(data) {
    if (data.routingMs == null) return '';
    return '<span class="lat" title="Time spent routing: detection, signal, filtering and scoring. ' +
      'Excludes the upstream model call.">' + esc(data.routingMs) + ' ms</span>';
  }

  // Which signal provider ran — varies by strategy (ADR 0012). fast uses a
  // fast provider (heuristic ~0ms or RouteLLM ~250ms), the rest the classifier.
  function signalSource(data, c) {
    var p = data.signalProvider || (c.degraded ? 'heuristic' : 'llm-classifier');
    var label = { 'llm-classifier': 'LLM classifier (~1s)', 'routellm': 'RouteLLM (~250ms)', 'heuristic': 'heuristic (~0ms)' }[p] || esc(p);
    if (c.degraded && p !== 'heuristic') {
      return '<span class="warn">' + label + ' — degraded to heuristic defaults (key/sidecar unavailable?)</span>';
    }
    return label;
  }

  function render(data, status, hdrs) {
    if (status !== 200 || data.error) {
      out.innerHTML = '<div class="card err">Error ' + status + ': ' +
        esc(data && data.error ? (data.error.message || JSON.stringify(data.error)) : 'request failed') +
        '</div>';
      return;
    }
    if (data.bypassed) {
      out.innerHTML = '<div class="card banner">' +
        (data.decision ? avail(data.decision.model) + ' ' : '') +
        'Forced to <b>' + esc(data.decision ? data.decision.model : '-') + '</b> ' +
        (data.decision ? '<span class="muted">(' + esc(data.decision.provider) + ')</span>' : '') +
        latency(data) +
        '<br><span class="muted">routing skipped (X-Router-Bypass) — the model is used verbatim</span>' +
        unroutableNote(data.decision) + '</div>' +
        headersCard(hdrs) +
        '<details><summary>Raw JSON</summary><pre>' + esc(JSON.stringify(data, null, 2)) + '</pre></details>';
      return;
    }

    var html = '';

    if (data.decision) {
      html += '<div class="card banner">' + avail(data.decision.model) + ' Routed to <b>' +
        esc(data.decision.model) + '</b> ' +
        '<span class="muted">(' + esc(data.decision.provider) + ')</span>' + latency(data) + '<br>' +
        '<span class="muted">' + esc(data.decision.reason) + '</span>' +
        unroutableNote(data.decision) + '</div>';
    } else {
      html += '<div class="card err">No eligible model for this request.</div>';
    }

    var c = data.classifier || {};
    html += '<div class="card"><h3>Signals</h3><div class="kv">' +
      '<div>complexity</div><div>' + (c.complexity != null ? pct(c.complexity) : '-') + '</div>' +
      '<div>reasoning depth</div><div>' + (c.reasoningDepth != null ? pct(c.reasoningDepth) : '-') + '</div>' +
      '<div>task type</div><div>' + esc(c.taskType || '-') + '</div>' +
      '<div>expected output</div><div>' + esc(c.expectedOutputTokens) + ' tokens</div>' +
      '<div>data sensitivity</div><div>' + (c.dataSensitivity != null ? pct(c.dataSensitivity) : '-') + '</div>' +
      '<div>input tokens</div><div>' + esc(data.inputTokens) + '</div>' +
      '<div>signal source</div><div>' + signalSource(data, c) + '</div>' +
      '</div></div>';

    var rl = data.routellm;
    if (rl) {
      var rlBody;
      if (!rl.enabled) {
        rlBody = '<span class="muted">disabled — enable <code>routellm</code> in server.yaml and run the sidecar</span>';
      } else if (rl.available) {
        rlBody = 'win-rate <b>' + pct(rl.winRate) + '</b> <span class="muted">(P a strong model is needed)</span> · confidence ' + pct(rl.confidence);
      } else {
        rlBody = '<span class="warn">sidecar unavailable</span>';
      }
      html += '<div class="card"><h3>RouteLLM (learned signal)</h3>' + rlBody + '</div>';
    }

    var d = data.detected || {};
    var reqs = [];
    if (d.requiresVision) reqs.push('vision');
    if (d.requiresTools) reqs.push('tools');
    if (d.requiresStructuredOutput) reqs.push('structured output');
    if (d.requiresAudio) reqs.push('audio');
    html += '<div class="card"><h3>Detected requirements</h3><div class="badges">' +
      (reqs.length ? reqs.map(function (r) { return '<span>' + esc(r) + '</span>'; }).join('') : '<span class="muted">none</span>') +
      '</div></div>';

    if (data.ranked && data.ranked.length) {
      // Highlight the model actually chosen, which is not always the top score:
      // a higher-ranked model with no API key is passed over. Mark that one too,
      // so the gap between "scored best" and "was used" is visible rather than
      // implied by the ⚪.
      var chosen = data.decision ? data.decision.model : null;
      var topScorer = data.ranked[0].model;
      var passedOver = chosen !== null && topScorer !== chosen;

      function compCell(r) {
        var k = r.competency;
        if (!k) return '<td class="muted" title="generic task — competency not applied">—</td>';
        var tip = (k.fallback ? 'tier fallback: ' : '') + k.source + (k.updated ? ' · updated ' + k.updated : '');
        return '<td title="' + esc(tip) + '">' + k.score.toFixed(3) +
          (k.fallback ? '<span class="muted">†</span>' : '') + '</td>';
      }
      var rows = data.ranked.map(function (r) {
        var cls = r.model === chosen ? 'win' : (passedOver && r.model === topScorer ? 'skipped' : '');
        var note = '';
        if (r.model === chosen) note = ' <span class="tag">chosen</span>';
        else if (passedOver && r.model === topScorer) note = ' <span class="tag muted">top score, no key</span>';
        return '<tr class="' + cls + '"><td>' + avail(r.model) + '</td><td>' +
          esc(r.model) + note + '</td><td>' + vendorCell(r.provider) + '</td><td>' + esc(r.tier) +
          '</td>' + compCell(r) + '<td>' + r.score.toFixed(3) + '</td><td>$' + r.estimatedCost.toFixed(5) + '</td></tr>';
      }).join('');
      var compTask = data.ranked[0] && data.ranked[0].competency ? data.ranked[0].competency.task : null;
      html += '<div class="card"><h3>Ranked candidates</h3><table>' +
        '<tr><th></th><th>model</th><th>vendor</th><th>tier</th>' +
        '<th title="Per-task competency (0-1) that fed the task_type rule for the detected task (ADR 0010). Hover a value for its source; † = tier fallback (no benchmark data).">comp.</th>' +
        '<th>score</th><th>est. cost</th></tr>' + rows + '</table>' +
        (compTask ? '<div class="muted" style="margin-top:.4rem">comp. = competency for detected task <code>' +
          esc(compTask) + '</code>; † = tier fallback (no benchmark data). Hover a value for its source.</div>' : '') +
        '</div>';
    }

    if (data.excluded && data.excluded.length) {
      var ex = data.excluded.map(function (e) {
        return '<tr><td>' + avail(e.model) + '</td><td>' + esc(e.model) + '</td><td>' +
          vendorOf(e.model) + '</td><td class="muted">' +
          esc((e.failedConstraints || []).join(', ')) + '</td></tr>';
      }).join('');
      html += '<div class="card"><h3>Excluded by constraints</h3><table>' +
        '<tr><th></th><th>model</th><th>vendor</th><th>failed</th></tr>' + ex + '</table></div>';
    }

    if (data.warnings && data.warnings.length) {
      html += '<div class="card warn">' + data.warnings.map(esc).join('<br>') + '</div>';
    }

    html += headersCard(hdrs);

    html += '<details><summary>Raw JSON</summary><pre>' + esc(JSON.stringify(data, null, 2)) + '</pre></details>';
    out.innerHTML = html;
  }

  async function submit(bodyOverride) {
    var prompt = document.getElementById('prompt').value;
    if (!bodyOverride && !prompt.trim()) { return; }
    var strategy = document.getElementById('strategy').value;
    var force = document.getElementById('force').value;
    var body = bodyOverride || { messages: [{ role: 'user', content: prompt }] };
    var headers = { 'Content-Type': 'application/json', 'X-Router-Strategy': strategy };
    // Force a specific model: pin it in the body and bypass routing.
    if (force && force !== 'auto') {
      body = Object.assign({}, body, { model: force });
      headers['X-Router-Bypass'] = 'true';
    }
    btn.disabled = true;
    out.innerHTML = '<div class="card muted">Inspecting…</div>';
    try {
      var res = await fetch('/v1/router/explain', {
        method: 'POST', headers: headers, body: JSON.stringify(body)
      });
      var data = await res.json();
      var hdrs = {};
      ['X-Router-Model', 'X-Router-Reason', 'X-Router-Duration-Ms', 'X-Router-Warning'].forEach(function (n) {
        var v = res.headers.get(n);
        if (v) hdrs[n] = v;
      });
      render(data, res.status, hdrs);
    } catch (e) {
      out.innerHTML = '<div class="card err">' + esc(e.message) + '</div>';
    } finally {
      btn.disabled = false;
    }
  }

  function runPreset(p) {
    document.getElementById('prompt').value = p.prompt;
    document.getElementById('strategy').value = p.strategy;
    document.getElementById('force').value = (p.bypass && p.body && p.body.model) ? p.body.model : 'auto';
    submit(p.body);
  }

  (function renderPresets() {
    var box = document.getElementById('presets');
    if (!PRESETS.length) { box.innerHTML = '<p class="muted">none found</p>'; return; }
    PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'preset';
      b.title = p.id;
      b.innerHTML = '<span class="pl">' + esc(p.label) + '</span><span class="chip">' + esc(p.strategy) + '</span>';
      b.addEventListener('click', function () { runPreset(p); });
      box.appendChild(b);
    });
  })();

  btn.addEventListener('click', function () { submit(); });
</script>
</body>
</html>`;
}
