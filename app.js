/* Model Consensus — one question, every model.
   Quest #19183 · Credit Pollinations — Made with pollinations.ai */

const APP_KEY = 'pk_OPaGyG1ZLe4qlyQ3';
const SUMMARIZER_MODEL = 'openai/gpt-5.4-nano';

const state = {
  models: [],          // all text models
  selected: new Set(), // model ids
  results: [],         // {model, runs:[{text, ms, ok}], error}
  asking: false,
};

const PRESETS = {
  big8: ['openai/gpt-5.4-nano', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash', 'x-ai/grok-4.6', 'deepseek/deepseek-v4-flash', 'meta/llama-4-maverick', 'mistralai/mistral-large-4', 'moonshotai/kimi-k3'],
  fast6: ['openai/gpt-5.4-nano', 'google/gemini-3.5-flash-lite', 'deepseek/deepseek-v4-flash', 'qwen/qwen3.8-flash', 'mistralai/mistral-small-4', 'minimax/minimax-m3.1-flash'],
  frontier: ['openai/gpt-6.1-terra', 'anthropic/claude-opus-5.5', 'google/gemini-4-carbon', 'x-ai/grok-4.7', 'moonshotai/kimi-k3.1-pro'],
  open: ['meta/llama-4-maverick', 'mistralai/mistral-large-4', 'qwen/qwen3.8-27b', 'deepseek/deepseek-v4-flash', 'google/gemma-4-31b-it'],
};

const SUGGESTIONS = [
  'What is your most controversial take about humans?',
  'What is the meaning of life, in one sentence?',
  'Which number is more interesting: 7 or 1729? Why?',
  'If you could ask humans one question, what would it be?',
  'What will people in 2100 find absurd about today?',
  'Is a hot dog a sandwich? Argue your case.',
];

/* ---------- init page chrome ---------- */

PolliPage.init({
  title: 'Model Consensus',
  tagline: 'one question · every model',
  appKey: APP_KEY,
  budget: 10,
  models: 'text',
  permissions: 'profile usage',
  onKey() { /* ready to ask */ },
});

/* ---------- model list ---------- */

async function loadModels() {
  const listEl = $('#model-list');
  try {
    const all = await new PolliClient(null).models();
    state.models = all.filter((m) => {
      if (m.category !== 'text') return false;
      if (m.community) return false;
      if (m.health && m.health.status && m.health.status !== 'healthy') return false;
      return (m.supported_endpoints || []).includes('/v1/chat/completions');
    });
    renderModelList();
    pickPreset('big8');
  } catch (e) {
    listEl.innerHTML = '';
    listEl.appendChild(el('div', { class: 'error-box', style: 'margin:10px', text: 'Could not load models: ' + e.message }));
  }
}

function renderModelList() {
  const listEl = $('#model-list');
  const q = ($('#model-search').value || '').toLowerCase();
  listEl.innerHTML = '';
  const shown = state.models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.title || '').toLowerCase().includes(q));
  if (!shown.length) {
    listEl.appendChild(el('div', { class: 'faint', style: 'padding:12px', text: 'no models match' }));
  }
  for (const m of shown) {
    const row = el('label', { class: 'model-row' + (state.selected.has(m.id) ? ' picked' : '') },
      el('input', { type: 'checkbox', checked: state.selected.has(m.id) ? '' : null }),
      el('span', { class: 'name', text: m.title || m.id }),
      el('span', { class: 'faint small', text: (m.owned_by || '').slice(0, 12) })
    );
    row.querySelector('input').addEventListener('change', (ev) => {
      if (ev.target.checked) state.selected.add(m.id);
      else state.selected.delete(m.id);
      row.classList.toggle('picked', ev.target.checked);
      updateCount();
    });
    listEl.appendChild(row);
  }
}

function pickPreset(name) {
  state.selected = new Set(PRESETS[name] || []);
  renderModelList();
  updateCount();
}

function updateCount() {
  $('#model-count').textContent = state.selected.size + ' selected';
}

/* ---------- ask ---------- */

async function ask() {
  if (state.asking) return;
  const question = $('#question').value.trim();
  if (!question) { alert('Type a question first.'); return; }
  if (!state.selected.size) { alert('Pick at least one model.'); return; }
  if (!PolliPage.client) { alert('Connect your Pollen first (top right), then ask.'); return; }

  state.asking = true;
  const askBtn = $('#ask');
  askBtn.disabled = true;
  askBtn.textContent = 'Asking…';

  const threeX = $('#ask3x').checked;
  const modelIds = Array.from(state.selected);
  state.results = [];

  const answersEl = $('#answers');
  answersEl.innerHTML = '';
  $('#results-card').style.display = '';
  $('#consensus-card').style.display = 'none';
  $('#summarize').style.display = 'none';

  let done = 0;
  const total = modelIds.length;
  const progress = $('#progress-chip');
  progress.textContent = '0 / ' + total;

  const cards = new Map();
  for (const id of modelIds) {
    const card = makeAnswerCard(id, threeX ? 3 : 1);
    cards.set(id, card);
    answersEl.appendChild(card.root);
  }

  await Promise.all(modelIds.map(async (id) => {
    const runs = threeX ? 3 : 1;
    const result = { model: id, runs: [], error: null };
    state.results.push(result);
    // sequential per model (3x), parallel across models
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      try {
        const client = PolliPage.needClient();
        const j = await client.chat(id, [
          { role: 'system', content: 'Answer directly and concisely (max ~120 words). You are being asked the same question as many other AI models; give YOUR answer, first-person, no disclaimers about being an AI unless asked.' },
          { role: 'user', content: question },
        ], { temperature: 0.9, maxTokens: 400 });
        const text = j.choices[0].message.content || '';
        result.runs.push({ text, ms: performance.now() - t0, ok: true });
      } catch (e) {
        result.error = e.message;
        result.runs.push({ text: null, ms: performance.now() - t0, ok: false });
        break; // model-level failure: stop retrying this model
      }
      updateCard(cards.get(id), result, threeX);
    }
    updateCard(cards.get(id), result, threeX);
    done += 1;
    progress.textContent = done + ' / ' + total;
  }));

  state.asking = false;
  askBtn.disabled = false;
  askBtn.textContent = 'Ask every model';
  $('#summarize').style.display = '';
}

/* ---------- answer cards ---------- */

function makeAnswerCard(modelId, runs) {
  const model = state.models.find((m) => m.id === modelId);
  const body = el('div', { class: 'body' }, el('span', { class: 'spinner' }), ' thinking…');
  const foot = el('div', { class: 'foot' });
  const root = el('div', { class: 'card answer-card' },
    el('div', { class: 'head' },
      el('span', { class: 'chip gold', text: shortName(modelId) }),
      runs > 1 ? el('span', { class: 'chip faint', text: '3×' }) : null,
      el('span', { class: 'm faint', text: model ? (model.owned_by || '') : '' })),
    body, foot);
  return { root, body, foot };
}

function updateCard(card, result, threeX) {
  if (result.error) {
    card.root.classList.add('err', 'done');
    card.body.textContent = '✗ ' + result.error;
    card.foot.innerHTML = '';
    return;
  }
  const okRuns = result.runs.filter((r) => r.ok);
  if (!okRuns.length) return;
  card.root.classList.add('done');
  card.body.textContent = okRuns.map((r, i) => (threeX ? '— run ' + (i + 1) + ' —\n' : '') + (r.text || '').trim()).join('\n\n');
  const ms = okRuns.map((r) => Math.round(r.ms));
  const conviction = threeX ? convictionOf(okRuns) : null;
  card.foot.innerHTML = '';
  card.foot.appendChild(el('span', { text: '⏱ ' + ms.map((m) => fmtMs(m)).join(' / ') }));
  if (conviction !== null) {
    card.foot.appendChild(el('span', { text: 'conviction ' + Math.round(conviction * 100) + '%' }));
  }
}

function convictionOf(runs) {
  // crude semantic-overlap conviction: average pairwise 8-gram jaccard
  const sets = runs.map((r) => new Set(shingles((r.text || '').toLowerCase(), 6)));
  if (sets.length < 2) return 1;
  let acc = 0, pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let inter = 0;
      for (const s of sets[i]) if (sets[j].has(s)) inter += 1;
      const uni = sets[i].size + sets[j].size - inter;
      acc += uni ? inter / uni : 1;
      pairs += 1;
    }
  }
  return pairs ? acc / pairs : 1;
}

function shingles(text, n) {
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(' '));
  return out.length ? out : words;
}

function shortName(id) {
  const parts = id.split('/');
  return (parts[1] || parts[0]).slice(0, 22);
}

/* ---------- consensus ---------- */

async function summarize() {
  const btn = $('#summarize');
  btn.disabled = true;
  btn.textContent = 'Summarizing…';
  const question = $('#question').value.trim();
  const okResults = state.results.filter((r) => !r.error && r.runs.some((x) => x.ok));
  if (!okResults.length) { btn.disabled = false; btn.textContent = 'Summarize consensus'; return; }

  const digest = okResults.map((r) => {
    const texts = r.runs.filter((x) => x.ok).map((x) => (x.text || '').trim().slice(0, 500));
    return '### ' + r.model + '\n' + texts.join('\n[asked again] ');
  }).join('\n\n');

  $('#consensus-card').style.display = '';
  const bodyEl = $('#consensus-body');
  bodyEl.textContent = '';
  bodyEl.appendChild(el('span', { class: 'spinner' }));
  $('#consensus-model').textContent = SUMMARIZER_MODEL;

  try {
    const client = PolliPage.needClient();
    await client.chatStream(SUMMARIZER_MODEL, [
      { role: 'system', content: 'You are an analyst comparing answers from many AI models to ONE identical question. Produce a short report with exactly these sections:\n1. **The consensus** — what most models agree on (2-4 sentences).\n2. **The outliers** — which model(s) answered differently and how (name them; bullet list).\n3. **The surprises** — anything unexpected, funny or revealing.\nBe concrete and quote short phrases from the answers. Keep it under 200 words.' },
      { role: 'user', content: 'QUESTION: ' + question + '\n\nANSWERS:\n\n' + digest },
    ], {
      maxTokens: 700,
      onDelta: (piece) => {
        if (bodyEl.querySelector('.spinner')) bodyEl.textContent = '';
        bodyEl.textContent += piece;
        bodyEl.scrollTop = bodyEl.scrollHeight;
      },
    });
  } catch (e) {
    bodyEl.textContent = '✗ ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = 'Summarize consensus';
}

/* ---------- wire up ---------- */

$('#ask').addEventListener('click', () => PolliPage.run(ask));
$('#summarize').addEventListener('click', () => PolliPage.run(summarize));
$('#model-search').addEventListener('input', renderModelList);
$$('#presets-area, .quick-picks button').forEach((b) => b.addEventListener('click', () => pickPreset(b.dataset.pick)));

const presetBox = $('#presets');
SUGGESTIONS.forEach((s) => {
  presetBox.appendChild(el('button', { class: 'small ghost', text: s.length > 44 ? s.slice(0, 42) + '…' : s, title: s, onclick: () => { $('#question').value = s; } }));
});

loadModels();
