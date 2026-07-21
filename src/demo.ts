/**
 * The /demo decision-inspector page (served by the API itself). A prompt box +
 * strategy selector; on submit it POSTs to /v1/router/explain and renders the
 * router's decision trace human-readably. It never runs the actual completion.
 *
 * Self-contained HTML (inline CSS/JS). The inner script uses string
 * concatenation (no template literals) to avoid clashing with this outer one.
 */

export const demoHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>llm-model-router — decision inspector</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 900px;
    margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .sub { opacity: 0.7; margin-top: 0; font-size: 0.9rem; }
  textarea { width: 100%; min-height: 90px; font: inherit; padding: 0.6rem; box-sizing: border-box; }
  .row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.6rem 0; }
  label { font-size: 0.85rem; opacity: 0.8; }
  select, input { font: inherit; padding: 0.35rem; }
  input.key { flex: 1; min-width: 180px; }
  button { font: inherit; padding: 0.5rem 1.1rem; cursor: pointer; border-radius: 6px; border: 1px solid #8888; }
  button:disabled { opacity: 0.5; cursor: wait; }
  .card { border: 1px solid #8883; border-radius: 8px; padding: 0.8rem 1rem; margin: 0.8rem 0; }
  .banner { font-size: 1.1rem; }
  .banner b { font-size: 1.25rem; }
  .muted { opacity: 0.7; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #8882; }
  tr.win { background: #7c3aed22; font-weight: 600; }
  .badges span { display: inline-block; padding: 0.1rem 0.5rem; margin: 0.15rem; border-radius: 999px;
    background: #8882; font-size: 0.8rem; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; font-size: 0.9rem; }
  .warn { color: #b45309; }
  details { margin-top: 0.6rem; }
  pre { overflow-x: auto; background: #8881; padding: 0.6rem; border-radius: 6px; font-size: 0.8rem; }
  .err { color: #b91c1c; }
</style>
</head>
<body>
  <h1>Router decision inspector</h1>
  <p class="sub">Submit a prompt to see how the router would route it — no completion is run.</p>

  <textarea id="prompt" placeholder="Type a request, e.g. 'Prove the square root of 2 is irrational'"></textarea>
  <div class="row">
    <label>Strategy
      <select id="strategy">
        <option value="balanced">balanced</option>
        <option value="cost">cost</option>
        <option value="quality">quality</option>
        <option value="latency">latency</option>
      </select>
    </label>
    <input class="key" id="key" type="password" placeholder="Proxy API key (only if auth is enabled)" />
    <button id="go">Inspect routing</button>
  </div>

  <div id="out"></div>

<script>
  var btn = document.getElementById('go');
  var out = document.getElementById('out');

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }
  function pct(x) { return Math.round(x * 100) + '%'; }

  function render(data, status) {
    if (status !== 200 || data.error) {
      out.innerHTML = '<div class="card err">Error ' + status + ': ' +
        esc(data && data.error ? (data.error.message || JSON.stringify(data.error)) : 'request failed') +
        '</div>';
      return;
    }
    var html = '';

    if (data.decision) {
      html += '<div class="card banner">Routed to <b>' + esc(data.decision.model) + '</b> ' +
        '<span class="muted">(' + esc(data.decision.provider) + ')</span><br>' +
        '<span class="muted">' + esc(data.decision.reason) + '</span></div>';
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
      '<div>signal source</div><div>' + (c.degraded ? '<span class="warn">degraded (heuristic defaults — is the classifier key set?)</span>' : 'classifier') + '</div>' +
      '</div></div>';

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
      var rows = data.ranked.map(function (r, i) {
        return '<tr class="' + (i === 0 ? 'win' : '') + '"><td>' + esc(r.model) + '</td><td>' + esc(r.tier) +
          '</td><td>' + r.score.toFixed(3) + '</td><td>$' + r.estimatedCost.toFixed(5) + '</td></tr>';
      }).join('');
      html += '<div class="card"><h3>Ranked candidates</h3><table>' +
        '<tr><th>model</th><th>tier</th><th>score</th><th>est. cost</th></tr>' + rows + '</table></div>';
    }

    if (data.excluded && data.excluded.length) {
      var ex = data.excluded.map(function (e) {
        return '<tr><td>' + esc(e.model) + '</td><td class="muted">' + esc((e.failedConstraints || []).join(', ')) + '</td></tr>';
      }).join('');
      html += '<div class="card"><h3>Excluded by constraints</h3><table>' +
        '<tr><th>model</th><th>failed</th></tr>' + ex + '</table></div>';
    }

    if (data.warnings && data.warnings.length) {
      html += '<div class="card warn">' + data.warnings.map(esc).join('<br>') + '</div>';
    }

    html += '<details><summary>Raw JSON</summary><pre>' + esc(JSON.stringify(data, null, 2)) + '</pre></details>';
    out.innerHTML = html;
  }

  async function submit() {
    var prompt = document.getElementById('prompt').value;
    if (!prompt.trim()) { return; }
    var strategy = document.getElementById('strategy').value;
    var key = document.getElementById('key').value.trim();
    btn.disabled = true;
    out.innerHTML = '<div class="card muted">Inspecting…</div>';
    try {
      var headers = { 'Content-Type': 'application/json', 'X-Router-Strategy': strategy };
      if (key) headers['Authorization'] = 'Bearer ' + key;
      var res = await fetch('/v1/router/explain', {
        method: 'POST', headers: headers,
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] })
      });
      var data = await res.json();
      render(data, res.status);
    } catch (e) {
      out.innerHTML = '<div class="card err">' + esc(e.message) + '</div>';
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', submit);
</script>
</body>
</html>`;
