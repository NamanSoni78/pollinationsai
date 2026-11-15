/* SciExplorer — turn a science topic into something you can explore.
   Quest #19181 · Credit Pollinations — Made with pollinations.ai */

const APP_KEY = 'pk_oB2HjsRMIdhoRiDe';
const OUTLINE_MODEL = 'openai/gpt-5.4-nano';
const FIGURE_MODEL = 'openai/gpt-5.4';
const GALLERY_KEY = 'sciexplorer.gallery.v1';
const GALLERY_MAX = 24;

const state = {
  busy: false,
  figureHtml: '',
  entry: null, // currently open gallery entry (or null)
};

const PRESET_TOPICS = [
  'How a refrigerator works',
  'Neuron firing',
  'Plate tectonics',
  'Antibodies vs viruses',
  'Why the sky is blue',
];

const DETAIL_LEVELS = {
  quick:    { sections: 'exactly 2', outlineTokens: 1200, figureTokens: 8000,  note: 'small, focused figure' },
  standard: { sections: '3 to 4',   outlineTokens: 2000, figureTokens: 11000, note: 'medium figure' },
  deep:     { sections: '5 to 6',   outlineTokens: 2800, figureTokens: 14000, note: 'rich, detailed figure' },
};

/* ---------- init page chrome ---------- */

PolliPage.init({
  title: 'SciExplorer',
  tagline: 'a topic → an explorable figure',
  appKey: APP_KEY,
  budget: 10,
  models: 'text image audio',
  permissions: 'profile usage',
  onKey() { /* ready to generate */ },
  onDisconnect() { /* next generate will show the friendly reminder */ },
});

/* welcome illustration (public, no key needed for URL building) */
(function setWelcomeImg() {
  const img = $('#welcome-img');
  if (img) img.src = new PolliClient(null).imageUrl(
    'science exploration concept, magnifying glass over molecules and orbitals, dark blue background, gold accents, scientific diagram illustration',
    { width: 420, height: 236, seed: 7 }
  );
})();

/* mirror the 3 progress steps into the result card */
$('#live-steps').innerHTML = $('#steps').innerHTML;

/* ---------- presets ---------- */

PRESET_TOPICS.forEach((t) => {
  $('#presets').appendChild(el('button', {
    class: 'small ghost',
    text: t,
    title: t,
    onclick: () => { $('#topic').value = t; $('#topic').focus(); },
  }));
});

/* ---------- progress steps ---------- */

function setStep(name, status, extra) {
  $$('div.step[data-step="' + name + '"]').forEach((row) => {
    row.classList.remove('active', 'done');
    if (status) row.classList.add(status);
    const ms = row.querySelector('.ms');
    if (ms && extra !== undefined) ms.textContent = extra;
  });
}

function resetSteps() {
  $('#steps').classList.add('on');
  $('#live-steps').classList.add('on');
  ['outline', 'figure', 'image'].forEach((s) => setStep(s, null, ''));
}

/* ---------- pipeline ---------- */

async function generate() {
  if (state.busy) return;
  const topic = $('#topic').value.trim();
  if (!topic) { alert('Type a science topic first — or tap one of the preset chips.'); return; }
  const client = PolliPage.needClient(); // friendly error if not connected
  const level = DETAIL_LEVELS[$('#detail').value] || DETAIL_LEVELS.standard;
  const detailName = $('#detail').value;

  state.busy = true;
  state.entry = null;
  const btn = $('#generate');
  btn.disabled = true;
  btn.textContent = 'Exploring…';
  $('#welcome').style.display = 'none';
  $('#result-card').style.display = '';
  $('#result-title').textContent = topic;
  $('#figure-model-chip').textContent = FIGURE_MODEL;
  $('#figure-code').classList.remove('on');
  $('#toggle-code').textContent = 'View code';
  $('#figure-code').textContent = '';
  $('#figure-frame').srcdoc = '';
  $('#hero-img').style.display = 'none';
  resetSteps();

  const pre = $('#figure-code');

  try {
    /* ---- 1. OUTLINE ---- */
    const t0 = performance.now();
    setStep('outline', 'active', 'thinking…');
    const outline = await generateOutline(client, topic, detailName, level);
    setStep('outline', 'done', fmtMs(performance.now() - t0));

    $('#result-title').textContent = outline.title || topic;
    renderSections(outline);
    renderSources(outline.sources);
    renderSimplifications(outline.simplifications);

    /* ---- 2. FIGURE (streamed) ---- */
    const t1 = performance.now();
    setStep('figure', 'active', 'streaming…');
    pre.classList.add('on');
    pre.textContent = '';
    let chars = 0;
    let raw = '';
    await client.chatStream(FIGURE_MODEL, figureMessages(topic, detailName, level, outline), {
      temperature: 0.4,
      maxTokens: level.figureTokens,
      onDelta: (piece) => {
        raw += piece;
        chars += piece.length;
        setStep('figure', 'active', (chars / 1000).toFixed(1) + 'k chars');
        pre.textContent = raw;
        pre.scrollTop = pre.scrollHeight;
      },
    });

    const html = cleanFigureHtml(raw);
    if (!looksLikeFigure(html)) {
      throw new Error('The figure model did not return a complete interactive HTML figure. Try again (or lower the detail level).');
    }
    state.figureHtml = html;
    pre.textContent = html;
    renderFigure(html);
    setStep('figure', 'done', fmtMs(performance.now() - t1));

    /* ---- 3. HERO IMAGE ---- */
    const t2 = performance.now();
    setStep('image', 'active', 'rendering…');
    const imgUrl = client.imageUrl(topic + ' scientific diagram illustration', {
      width: 1024, height: 576, seed: Math.floor(Math.random() * 1e6),
    });
    await showHeroImage(imgUrl);
    setStep('image', 'done', fmtMs(performance.now() - t2));

    /* ---- save to gallery ---- */
    state.entry = {
      id: Date.now(),
      topic,
      date: new Date().toISOString(),
      detail: detailName,
      figureModel: FIGURE_MODEL,
      outline,
      figureHtml: html,
      imageUrl: $('#hero-img').style.display === 'none' ? null : imgUrl,
    };
    saveEntry(state.entry);
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = 'Explore this topic';
    $('#steps').classList.remove('on');
  }
}

/* ---------- step 1: outline ---------- */

function outlineMessages(topic, detailName, level) {
  const system = [
    'You are the planner of SciExplorer, an app that turns a science topic into an interactive visual explanation,',
    'in the spirit of the Anima project (github.com/Garinmckayl/anima). Follow its five principles:',
    '1. Show the real structure — describe the actual mechanism and its parts, not a vague metaphor.',
    '2. Every number cited — any quantity you state must be traceable to a real source.',
    '3. Say how sure we are — flag confidence levels and what was approximated.',
    '4. Make it move for a reason — the visual must animate the mechanism itself; motion = causality, never decoration.',
    '5. Educational, never advice — teach the science; never give medical, financial or professional advice.',
    '',
    'Return ONLY valid JSON — no markdown fences, no commentary — with exactly this shape:',
    '{',
    '  "title": "short display title for the explanation",',
    '  "sections": [',
    '    {',
    '      "heading": "section heading",',
    '      "explanation": "2-4 plain-language sentences for a curious non-expert; include concrete numbers WITH their source when a number matters",',
    '      "visual": { "type": "interactive", "spec": "precise spec for ONE interactive figure: what to draw, the named parts, and at least one slider/toggle that CHANGES the mechanism or simulation (never just colors); include one key numeric readout with a real, sourced value and unit, and say what each hover tooltip should explain" }',
    '    }',
    '  ],',
    '  "sources": ["3-6 real canonical references (universities, NASA, NIH, textbooks, review papers) with URL when possible — never invent DOIs or fake papers",',
    '  "simplifications": ["2-5 honest statements about what was simplified or approximated, each with a confidence note (e.g. high/medium confidence)"]',
    '}',
    '',
    'Rules:',
    '- The explanation must be sequenced so section 1 sets up the structure and later sections build the mechanism.',
    '- The visual.spec of EVERY section must define an interactive figure; the first section\'s spec is the main one the app will build.',
    '- Keep each explanation under ~65 words.',
    '- If the topic is unsafe (weapons, bioweapons, illegal activity), pick the closest safe educational framing or refuse with a sources-only answer.',
  ].join('\n');

  const user = 'TOPIC: ' + topic + '\nDETAIL LEVEL: ' + detailName +
    ' (' + level.sections + ' sections, ' + level.note + ')\n\nProduce the JSON plan now.';
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function generateOutline(client, topic, detailName, level) {
  const j = await client.chat(OUTLINE_MODEL, outlineMessages(topic, detailName, level), {
    temperature: 0.5,
    maxTokens: level.outlineTokens,
  });
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  const outline = parseJsonLoose(text);
  if (!outline || !Array.isArray(outline.sections) || !outline.sections.length) {
    throw new Error('The outline model returned an unreadable plan. Try again.');
  }
  outline.sections = outline.sections.filter((s) => s && s.heading && s.explanation);
  if (!outline.sections.length) throw new Error('The outline model returned no usable sections. Try again.');
  if (!Array.isArray(outline.sources)) outline.sources = [];
  if (!Array.isArray(outline.simplifications)) outline.simplifications = [];
  return outline;
}

function parseJsonLoose(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim().startsWith('{')) t = fence[1].trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  t = t.slice(first, last + 1);
  try { return JSON.parse(t); } catch (e) { /* retry with trailing commas removed */ }
  try { return JSON.parse(t.replace(/,(\s*[}\]])/g, '$1')); } catch (e) { return null; }
}

/* ---------- step 2: figure ---------- */

function figureMessages(topic, detailName, level, outline) {
  const system = [
    'You build single-file interactive science figures for SciExplorer, in the spirit of the Anima project.',
    'You receive a topic and a JSON plan. Return a COMPLETE self-contained HTML document and NOTHING else:',
    'no markdown fences, no commentary before or after. The response must start with <!DOCTYPE html> and end with </html>.',
    '',
    'Hard requirements:',
    '- One <style> block and one <script> block, all inline. ZERO external requests: no fetch, no XHR, no CDN, no external fonts, images or scripts.',
    '- Dark theme: background exactly #0d0f14, accent #f5c518, text #e8eaf0, dim text #9aa3b8, panel #171c28, border #262d3f; clean system sans-serif.',
    '- Canvas or inline SVG, animated with requestAnimationFrame. html,body{margin:0;height:100%;overflow:hidden}; the figure fills the viewport.',
    '- The animation must SHOW THE MECHANISM: particles, waves, flows, arrows that move because of the underlying physics — motion is causality, not decoration.',
    '- At least ONE slider or toggle that CHANGES the simulation itself (a real parameter: temperature, speed, concentration, voltage, pressure, wavelength, angle…),',
    '  in a small control bar. Changing it must visibly change the dynamics AND at least one numeric readout.',
    '- At least one numeric readout of a real quantity with its unit (e.g. "−70 mV", "460 THz", "−18 °C inside the fridge"); when the plan cites a sourced number, display it.',
    '- Every meaningful part (regions, particles, arrows, controls, readouts) is hover-explainable: title attribute or small tooltip with a one-line "what it is and why it is there".',
    '- Pressing Space toggles pause/resume; show a small "paused" chip when paused; prevent Space from scrolling.',
    '- A slim caption strip at the bottom naming the figure and reminding "Space = pause · hover parts for why".',
    '- Robust vanilla ES2020 JavaScript, no console errors, must run inside a sandboxed iframe (allow-scripts only, opaque origin: no localStorage, no cookies, no parent access).',
    '- Keep it under ~700 lines total; a working, polished figure beats a sprawling broken one.',
  ].join('\n');

  const user = 'TOPIC: ' + topic + '\nDETAIL LEVEL: ' + detailName +
    ' (' + level.note + ')\n\nPLAN (JSON):\n' + JSON.stringify(outline, null, 2) +
    '\n\nBuild the interactive figure described by the plan (prioritize section 1\'s visual spec; fold in later sections\' readouts where they fit). Return only the HTML document.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function cleanFigureHtml(raw) {
  let t = String(raw || '').trim();
  // strip a dominant markdown fence if present
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && /<[a-z!]/i.test(fence[1])) t = fence[1].trim();
  // trim to the document boundaries
  const start = t.search(/<!DOCTYPE html>|<html[\s>]/i);
  if (start > -1) t = t.slice(start);
  const end = t.toLowerCase().lastIndexOf('</html>');
  if (end > -1) t = t.slice(0, end + 7);
  return t.trim();
}

function looksLikeFigure(html) {
  if (!html || html.length < 400) return false;
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) return false;
  return /<script[\s>]/i.test(html) && /<style[\s>]/i.test(html) &&
    (/requestAnimationFrame/.test(html) || /<canvas/i.test(html) || /<svg/i.test(html));
}

function renderFigure(html) {
  const frame = $('#figure-frame');
  frame.srcdoc = html; // sandbox="allow-scripts" (no allow-same-origin) — opaque origin, cannot touch this page
}

/* ---------- step 3: hero image ---------- */

function showHeroImage(url) {
  return new Promise((resolve) => {
    const img = $('#hero-img');
    const finish = () => { img.removeEventListener('load', finish); img.removeEventListener('error', fail); resolve(); };
    const fail = () => {
      img.style.display = 'none';
      finish();
    };
    img.addEventListener('load', () => { img.style.display = ''; finish(); });
    img.addEventListener('error', fail);
    img.src = url;
  });
}

/* ---------- rendering the plan ---------- */

function renderSections(outline) {
  const box = $('#sections');
  box.innerHTML = '';
  outline.sections.forEach((sec, i) => {
    const body = el('div', { class: 'sec-body' });
    String(sec.explanation || '').split(/\n{2,}/).filter(Boolean).forEach((p) => {
      body.appendChild(el('p', { text: p }));
    });

    const listenRow = el('div', { class: 'listen-row' });
    const card = el('div', { class: 'card section-card' },
      el('div', { class: 'sec-head' },
        el('h2', { text: (i + 1) + '. ' + sec.heading }),
        el('span', { class: 'chip violet', text: '§' + (i + 1) })),
      body, listenRow);
    attachListenButton(listenRow, sec);
    box.appendChild(card);
  });
}

function attachListenButton(row, sec) {
  row.innerHTML = '';
  if (!$('#narrate').checked) return;
  row.appendChild(el('button', {
    class: 'small ghost',
    text: '🔊 Listen to this section',
    onclick: () => {
      if (!PolliPage.client) {
        alert('Connect your Pollen first (top right) to play narration.');
        return;
      }
      const text = String(sec.explanation || '').slice(0, 300);
      const url = PolliPage.client.audioUrl(text);
      row.innerHTML = '';
      row.appendChild(el('audio', { controls: '', autoplay: '', src: url }));
    },
  }));
}

function renderSources(sources) {
  const card = $('#sources-card');
  const list = $('#sources-list');
  list.innerHTML = '';
  if (!sources || !sources.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  sources.forEach((s) => {
    const text = typeof s === 'string' ? s : [s && s.title, s && s.publisher, s && s.url].filter(Boolean).join(' — ');
    const urlMatch = text.match(/https?:\/\/[^\s)"']+/);
    const li = el('li');
    if (urlMatch) {
      li.appendChild(el('a', { href: urlMatch[0], target: '_blank', rel: 'noopener', text: text }));
    } else {
      li.textContent = text;
    }
    list.appendChild(li);
  });
}

function renderSimplifications(items) {
  const card = $('#simplifications-card');
  const list = $('#simplifications-list');
  list.innerHTML = '';
  if (!items || !items.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  items.forEach((s) => {
    const text = typeof s === 'string' ? s
      : [s && s.simplification, s && s.claim, s && s.confidence && ('confidence: ' + s.confidence)].filter(Boolean).join(' — ');
    list.appendChild(el('li', { text: text || String(s) }));
  });
}

/* ---------- gallery (localStorage) ---------- */

function loadGallery() {
  try {
    const raw = localStorage.getItem(GALLERY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function persistGallery(arr) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      localStorage.setItem(GALLERY_KEY, JSON.stringify(arr));
      return true;
    } catch (e) {
      if (arr.length > 1) arr.pop(); // drop oldest and retry (quota)
      else return false;
    }
  }
  return false;
}

function saveEntry(entry) {
  const arr = loadGallery();
  arr.unshift(entry);
  if (arr.length > GALLERY_MAX) arr.length = GALLERY_MAX;
  persistGallery(arr);
  renderGallery();
}

function deleteEntry(id, ev) {
  if (ev) ev.stopPropagation();
  const arr = loadGallery().filter((e) => e.id !== id);
  persistGallery(arr);
  renderGallery();
}

function renderGallery() {
  const box = $('#gallery');
  box.innerHTML = '';
  const arr = loadGallery();
  if (!arr.length) {
    box.appendChild(el('p', { class: 'faint small', text: 'Nothing yet — explore a topic first.' }));
    return;
  }
  const grid = el('div', { class: 'gallery-grid' });
  arr.forEach((e) => {
    const d = new Date(e.date);
    const item = el('div', { class: 'gallery-item', title: 'Reopen "' + e.topic + '"' },
      el('div', { class: 't', text: e.topic }),
      el('div', { class: 'meta' },
        el('span', { text: d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
        el('span', { class: 'chip faint', style: 'padding:1px 7px;', text: e.detail || 'standard' }),
        el('button', {
          class: 'del', title: 'Delete', text: '✕',
          onclick: (ev) => deleteEntry(e.id, ev),
        })));
    item.addEventListener('click', () => openEntry(e));
    grid.appendChild(item);
  });
  box.appendChild(grid);
}

function openEntry(entry) {
  if (state.busy) return;
  state.entry = entry;
  state.figureHtml = entry.figureHtml || '';
  $('#topic').value = entry.topic;
  $('#detail').value = entry.detail || 'standard';
  $('#welcome').style.display = 'none';
  $('#result-card').style.display = '';
  $('#result-title').textContent = (entry.outline && entry.outline.title) || entry.topic;
  $('#figure-model-chip').textContent = entry.figureModel || FIGURE_MODEL;
  $('#live-steps').classList.remove('on');
  $('#steps').classList.remove('on');
  const pre = $('#figure-code');
  pre.textContent = state.figureHtml;
  pre.classList.remove('on');
  $('#toggle-code').textContent = 'View code';
  renderFigure(state.figureHtml);
  renderSections(entry.outline || { sections: [] });
  renderSources(entry.outline && entry.outline.sources);
  renderSimplifications(entry.outline && entry.outline.simplifications);
  if (entry.imageUrl) {
    const img = $('#hero-img');
    img.src = entry.imageUrl;
    img.style.display = '';
  } else {
    $('#hero-img').style.display = 'none';
  }
}

/* ---------- wire up ---------- */

$('#generate').addEventListener('click', () => PolliPage.run(generate));
$('#toggle-code').addEventListener('click', () => {
  const pre = $('#figure-code');
  pre.classList.toggle('on');
  $('#toggle-code').textContent = pre.classList.contains('on') ? 'Hide code' : 'View code';
});
$('#reload-figure').addEventListener('click', () => {
  if (state.figureHtml) renderFigure(state.figureHtml);
});
$('#narrate').addEventListener('change', () => {
  // re-render listen buttons for currently shown sections
  if (state.entry || state.busy) {
    const cards = $$('#sections .section-card');
    (state.entry ? (state.entry.outline ? state.entry.outline.sections : []) : []).forEach((sec, i) => {
      if (cards[i]) attachListenButton(cards[i].querySelector('.listen-row'), sec);
    });
  }
});
$('#topic').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') $('#generate').click();
});

renderGallery();
