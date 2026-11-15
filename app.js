/* Pollen Towers — build your own tower of AI-run companies.
   Quest #17999 · inspired by Towers (thetowers.ai → towers.app)
   Credit Pollinations — Made with pollinations.ai */

const APP_KEY = 'pk_HoExZJIrsjeK3i46';
const MODEL = 'openai/gpt-5.4-nano';
const FLOOR_COUNT = 30;
const FLOOR_STEP = 22;      // px between floors along the tower axis
const BASE_ROT_X = 62;      // looking up at the tower
const BASE_ROT_Y = -18;
const LS_KEY = 'pollen-towers-v1';
const CATEGORIES = ['Food', 'Games', 'Logistics', 'Home', 'Services', 'Music', 'Energy', 'Tech', 'Other'];

const AGENTS = [
  { role: 'Researcher', emoji: '🔍', blurb: 'watches the market, brings one insight a day' },
  { role: 'Marketer', emoji: '📣', blurb: 'turns the insight into a social post' },
  { role: 'Ops', emoji: '⚙️', blurb: 'ships a changelog and one decision card for the owner' },
];

/* ---------- seed data: floors 2-8 ---------- */

const SEED_COMPANIES = [
  {
    name: 'Moonlight Bakery', emoji: '🥐', pitch: 'sourdough by night', industry: 'Food',
    tagline: 'Slow bread for fast cities.',
    story: 'One oven, one baker, zero daytime hours. Dough is prepared by an agent-scheduled proofing plan in the evening and baked between 2 and 5 a.m., so commuters get still-warm loaves at 7.',
    products: ['Night sourdough loaf', '2 a.m. croissant box (pre-order)', 'Weekend misfit-bread subscription'],
    customer: 'Early-rising commuters and home bread lovers in walkable neighborhoods',
    launch: 'Neighbors — I quit the day shift. Moonlight Bakery bakes sourdough while the city sleeps: proofed by agents, shaped by hand, out of the oven at 5 a.m. First 50 loaves are half price if you knock before sunrise. 🥐',
  },
  {
    name: 'Pixel & Pine', emoji: '🌲', pitch: 'indie game studio', industry: 'Games',
    tagline: 'Small games about quiet forests.',
    story: 'A one-person studio making short, cozy games set in the Pacific Northwest. An agent pipeline handles playtest telemetry, localization drafts and patch notes while the human designs levels.',
    products: ['Pine: A Walking Mystery (short game)', 'Seasonal soundtrack EPs', 'Cozy-game asset packs for other indies'],
    customer: 'Cozy-game players and streamers looking for 1-2 hour experiences',
    launch: 'Pixel & Pine is alive. One dev, three agents, and a forest full of mysteries. Our first short game ships this winter — wishlists open today. Agents already wrote the patch notes for a game that does not exist yet. 🌲',
  },
  {
    name: 'Drift Courier', emoji: '🛵', pitch: 'same-day bike delivery', industry: 'Logistics',
    tagline: 'Fast things, zero exhaust.',
    story: 'A cargo-bike delivery service for local shops. Agents batch and route parcels every 20 minutes; the owner rides the routes that need a human touch and handles the client relationships.',
    products: ['Same-day parcel runs (under 5 kg)', 'Standing shop-to-door route contracts', 'Event-day courier retainer'],
    customer: 'Independent boutiques, bakeries and pharmacies without their own delivery staff',
    launch: 'Drift Courier is on the road. Same-day delivery by cargo bike, routed minute-by-minute by agents, ridden by one very fit human. Local shops: first week of deliveries is on us. 🛵',
  },
  {
    name: 'Hedge & Home', emoji: '🪴', pitch: 'plant care subscriptions', industry: 'Home',
    tagline: 'Plants that survive you.',
    story: 'A plant-care subscription that ships a curated houseplant each month with an agent-written care plan tuned to your apartment’s light, detected from a photo you upload once.',
    products: ['Monthly houseplant box', 'Photo-based light audit + care plan', 'Rescue service for dying plants'],
    customer: 'New plant owners and serial plant killers in apartments',
    launch: 'Hedge & Home opens its greenhouse. One plant person, three agents, a mission: no more dead ferns. Send one photo of your window and we will tell you exactly what will survive there. 🪴',
  },
  {
    name: 'Tally & Twine', emoji: '🧵', pitch: 'handmade bookkeeping for makers', industry: 'Services',
    tagline: 'Numbers for people who make things by hand.',
    story: 'Bookkeeping built for crafters, potters and woodworkers. Agents categorize marketplace payouts and material receipts nightly; the owner reviews edge cases and calls the clients who need a human voice.',
    products: ['Monthly maker bookkeeping', 'Craft-fair profit calculator', 'Tax-prep binder for sole proprietors'],
    customer: 'Etsy and market-stall sellers who file as sole proprietors',
    launch: 'Tally & Twine is open for ledger business. Bookkeeping for makers, by a maker: agents do the categorizing at night, a human answers the phone by day. Bring us your shoebox of receipts. 🧵',
  },
  {
    name: 'Echo Lessons', emoji: '🎵', pitch: 'music teachers marketplace', industry: 'Music',
    tagline: 'Every instrument, one hallway.',
    story: 'A marketplace matching students with vetted independent music teachers. Agents handle scheduling, reminders and practice-report drafts; teachers just teach and get paid.',
    products: ['Lesson matching (any instrument)', 'Teacher tools: scheduling + practice notes', 'Student recital nights (hybrid)'],
    customer: 'Adult beginners and parents looking for reliable local teachers',
    launch: 'Echo Lessons is live. Finding a music teacher should not be harder than learning the instrument. Agents match, schedule and remind; teachers teach. First lesson is pay-what-you-can. 🎵',
  },
  {
    name: 'Solar Snacks', emoji: '☀️', pitch: 'solar-roasted nuts', industry: 'Energy',
    tagline: 'Roasted by the sun, shipped by a person.',
    story: 'Nuts roasted in a mirrored solar array on a rooftop, packaged by hand. Agents monitor temperature curves and predict roast batches from the weather forecast; the owner runs the roaster and the stall.',
    products: ['Solar-roasted almond packs', 'Sunless Days mix (rainy-week batch)', 'Rooftop tour + tasting'],
    customer: 'Farmers-market shoppers and climate-curious snackers',
    launch: 'Solar Snacks is hot. A rooftop mirror array, one roaster, a weather model and three agents: nuts roasted with zero gas. If the sun does not show, the Sunless Days mix does. ☀️',
  },
];

/* ---------- state ---------- */

function seedFloors() {
  const floors = [];
  for (let n = 1; n <= FLOOR_COUNT; n++) {
    if (n === 1) floors.push({ n, company: null, lobby: true, standups: [], decisions: [] });
    else if (n <= 8) floors.push({ n, company: Object.assign({ seed: true }, SEED_COMPANIES[n - 2]), standups: [], decisions: [] });
    else floors.push({ n, company: null, standups: [], decisions: [] });
  }
  return floors;
}

const state = {
  floors: [],
  view: { rx: BASE_ROT_X, ry: BASE_ROT_Y },
  dirCat: 'All',
};

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && Array.isArray(j.floors) && j.floors.length === FLOOR_COUNT) {
        state.floors = j.floors;
        return;
      }
    }
  } catch (e) { /* corrupted: reseed */ }
  state.floors = seedFloors();
  saveState();
}

function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ floors: state.floors })); }
  catch (e) { /* private mode */ }
}

function resetTower() {
  if (!confirm('Reset the tower? All user-founded companies, standups and decisions will be erased.')) return;
  state.floors = seedFloors();
  saveState();
  renderAll();
}

/* ---------- page chrome ---------- */

PolliPage.init({
  title: 'Pollen Towers',
  tagline: '30 floors · one human per floor · agents do the daily work',
  bee: '🏢',
  appKey: APP_KEY,
  budget: 10,
  models: 'text',
  permissions: 'profile usage',
  onKey() { /* enable rent / standup buttons */ },
});

/* ---------- 3D tower ---------- */

const world = () => document.getElementById('tower-world');
const stage = () => document.getElementById('tower-stage');

function floorClasses(f) {
  if (f.lobby) return 'floor lobby';
  if (f.company) return 'floor rented';
  return 'floor empty';
}

function faceContent(f) {
  if (f.lobby) {
    return el('div', { class: 'face' },
      el('span', { class: 'glyph', text: '🏢' }),
      el('span', { class: 'info' },
        el('div', { class: 'name', text: 'Lobby' }),
        el('div', { class: 'tag', text: 'tower directory & front desk' })),
      el('span', { class: 'fnum', text: '1' }));
  }
  if (f.company) {
    const c = f.company;
    return el('div', { class: 'face' },
      c.logoUrl
        ? el('img', { class: 'icon', src: c.logoUrl, alt: '', loading: 'lazy' })
        : el('span', { class: 'glyph', text: c.emoji || '🏢' }),
      el('span', { class: 'info' },
        el('div', { class: 'name', text: c.name }),
        el('div', { class: 'tag', text: c.pitch || c.tagline || c.industry })),
      el('span', { class: 'fnum', text: String(f.n) }));
  }
  return el('div', { class: 'face' },
    el('span', { class: 'glyph', text: '🪧' }),
    el('span', { class: 'info' },
      el('div', { class: 'name', text: 'For rent' }),
      el('div', { class: 'tag', text: 'found an office here' })),
    el('span', { class: 'fnum', text: String(f.n) }));
}

function renderTower() {
  const w = world();
  w.innerHTML = '';
  const mid = (FLOOR_COUNT + 1) / 2;
  for (const f of state.floors) {
    const y = (f.n - mid) * FLOOR_STEP; // stack along the Y axis; rotation handled by world
    const node = el('div', { class: floorClasses(f), style: 'top:50%;left:50%;width:300px;height:40px;margin:-20px 0 0 -150px;transform-style:preserve-3d;transform:translateY(' + (-y) + 'px)' });
    // four walls of the floor box (300 wide x 40 tall x 220 deep)
    const front = faceContent(f);
    front.style.transform = 'translateZ(110px)';
    const back = el('div', { class: 'face wall', style: 'transform:rotateY(180deg) translateZ(110px)' });
    const left = el('div', { class: 'face wall', style: 'transform:rotateY(-90deg) translateZ(150px);width:220px;margin-left:-110px' });
    const right = el('div', { class: 'face wall', style: 'transform:rotateY(90deg) translateZ(150px);width:220px;margin-left:-110px' });
    node.appendChild(front); node.appendChild(back); node.appendChild(left); node.appendChild(right);
    node.addEventListener('click', (ev) => { if (!dragMoved) openOffice(f.n); });
    w.appendChild(node);
  }
  applyRotation();
}

function applyRotation() {
  world().style.transform =
    'rotateX(' + state.view.rx + 'deg) rotateY(' + state.view.ry + 'deg)';
}

let dragMoved = false;

function initDrag() {
  const st = stage();
  let down = false, sx = 0, sy = 0, rx0 = 0, ry0 = 0;
  st.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('.face') === null && ev.target !== st && !ev.target.closest('.floor')) return;
    down = true; dragMoved = false;
    sx = ev.clientX; sy = ev.clientY; rx0 = state.view.rx; ry0 = state.view.ry;
    st.classList.add('dragging');
    st.setPointerCapture && st.setPointerCapture(ev.pointerId);
  });
  st.addEventListener('pointermove', (ev) => {
    if (!down) return;
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) dragMoved = true;
    state.view.ry = ry0 + dx * 0.35;                       // horizontal drag spins the tower
    state.view.rx = Math.max(35, Math.min(80, rx0 - dy * 0.2));
    applyRotation();
  });
  const up = () => { down = false; st.classList.remove('dragging'); setTimeout(() => { dragMoved = false; }, 0); };
  st.addEventListener('pointerup', up);
  st.addEventListener('pointercancel', up);
  st.addEventListener('pointerleave', () => { if (down) up(); });
}

/* ---------- stats ---------- */

function renderStats() {
  const rented = state.floors.filter((f) => f.company);
  const standups = rented.reduce((a, f) => a + f.standups.length, 0);
  document.getElementById('stat-companies').textContent = rented.length + ' companies';
  document.getElementById('stat-occupied').textContent = rented.length + ' / ' + FLOOR_COUNT + ' floors';
  document.getElementById('stat-standups').textContent = standups + ' standups run';
}

function renderAll() {
  renderTower();
  renderStats();
  renderDirectory();
}

/* ---------- directory ---------- */

function renderDirectory() {
  const chipsEl = document.getElementById('dir-chips');
  const listEl = document.getElementById('dir-list');
  const q = (document.getElementById('dir-search').value || '').toLowerCase();
  chipsEl.innerHTML = '';
  for (const cat of ['All'].concat(CATEGORIES)) {
    const b = el('button', { class: state.dirCat === cat ? 'on' : '', text: cat });
    b.addEventListener('click', () => { state.dirCat = cat; renderDirectory(); });
    chipsEl.appendChild(b);
  }
  listEl.innerHTML = '';
  const companies = state.floors.filter((f) => f.company);
  const shown = companies.filter((f) => {
    const c = f.company;
    if (state.dirCat !== 'All' && (c.industry || 'Other') !== state.dirCat) return false;
    if (!q) return true;
    return (c.name + ' ' + (c.pitch || '') + ' ' + (c.tagline || '') + ' ' + (c.industry || '')).toLowerCase().includes(q);
  });
  if (!shown.length) {
    listEl.appendChild(el('div', { class: 'faint', text: companies.length ? 'no companies match' : 'no companies yet — rent a floor in the tower' }));
  }
  for (const f of shown) {
    const c = f.company;
    const item = el('div', { class: 'dir-item' },
      el('div', { class: 'top' },
        c.logoUrl ? el('img', { class: 'icon', src: c.logoUrl, alt: '', loading: 'lazy' }) : el('span', { class: 'glyph', text: c.emoji || '🏢' }),
        el('div', {},
          el('div', { class: 'nm', text: c.name }),
          el('div', { class: 'tg', text: (c.pitch || c.tagline || '') })),
        el('span', { class: 'chip faint', style: 'margin-left:auto', text: 'F' + f.n })));
    item.addEventListener('click', () => openOffice(f.n));
    listEl.appendChild(item);
  }
}

/* ---------- modal helpers ---------- */

function openModal(content) {
  const back = el('div', { class: 'modal-back' });
  const box = el('div', { class: 'modal' });
  const close = el('button', { class: 'small ghost close-x', text: '✕' });
  close.addEventListener('click', () => back.remove());
  back.addEventListener('click', (ev) => { if (ev.target === back) back.remove(); });
  box.appendChild(close);
  box.appendChild(content);
  back.appendChild(box);
  document.body.appendChild(back);
  return back;
}

/* ---------- office panel ---------- */

function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  catch (e) { return ''; }
}

function openOffice(n) {
  const f = state.floors.find((x) => x.n === n);
  if (!f) return;
  if (!f.company && !f.lobby) { openRentModal(n); return; }
  if (f.lobby) { openLobby(); return; }
  const c = f.company;

  const head = el('div', { class: 'office-head' },
    c.logoUrl ? el('img', { class: 'logo-big', src: c.logoUrl, alt: 'logo' }) : el('span', { style: 'font-size:56px', text: c.emoji || '🏢' }),
    el('div', {},
      el('div', {}, el('span', { class: 'chip violet', text: 'Floor ' + f.n }), ' ',
        el('span', { class: 'chip faint', text: c.industry || 'Other' })),
      el('h2', { style: 'margin:8px 0 2px', text: c.name }),
      el('div', { class: 'dim', text: c.tagline || c.pitch || '' })));

  const body = el('div', {});
  if (c.story) {
    body.appendChild(el('h3', { text: 'The company' }));
    body.appendChild(el('p', { class: 'small', text: c.story }));
  }
  if (c.products && c.products.length) {
    body.appendChild(el('h3', { text: 'Products & services' }));
    const ul = el('ul', { class: 'small' });
    c.products.forEach((p) => ul.appendChild(el('li', { text: p })));
    body.appendChild(ul);
  }
  if (c.customer) {
    body.appendChild(el('h3', { text: 'Target customer' }));
    body.appendChild(el('p', { class: 'small', text: c.customer }));
  }
  if (c.launch) {
    body.appendChild(el('h3', { text: 'Launch post' }));
    body.appendChild(el('p', { class: 'small dim', style: 'border-left:3px solid var(--accent);padding-left:10px', text: c.launch }));
  }

  body.appendChild(el('h3', { text: 'AI agents' }));
  const agentsRow = el('div', { class: 'chips' });
  AGENTS.forEach((a) => agentsRow.appendChild(el('span', { class: 'chip', title: a.blurb, text: a.emoji + ' ' + a.role })));
  body.appendChild(agentsRow);

  body.appendChild(el('h3', { text: 'Standup history' }));
  const standupBtn = el('button', { class: 'primary', text: 'Run today\'s standup' });
  const pollenNote = el('div', { class: 'small faint', style: 'margin-top:6px', text: '~3 chat calls on ' + MODEL.split('/')[1] + ' · needs Pollen' });
  const standupErr = el('div', {});
  const histEl = el('div', {});
  standupBtn.addEventListener('click', () => runSafe(() => runStandup(f, histEl), standupErr));
  body.appendChild(standupBtn);
  body.appendChild(pollenNote);
  body.appendChild(standupErr);
  body.appendChild(histEl);
  renderStandupHistory(f, histEl);

  body.appendChild(el('h3', { text: 'Decision log' }));
  const decEl = el('div', { class: 'declog' });
  renderDecisions(f, decEl);
  body.appendChild(decEl);

  openModal(el('div', {}, head, body));
}

function openLobby() {
  const body = el('div', {},
    el('h2', { text: '🏢 Lobby' }),
    el('p', { class: 'small', text: 'Welcome to Pollen Towers — a 30-floor tower of one-person companies. Each floor is one business run by a human owner plus three AI agents (Researcher 🔍, Marketer 📣, Ops ⚙️). The agents do the daily work and bring decisions to the owner.' }),
    el('p', { class: 'small dim', text: 'Pick a lit floor to visit a company, or drag the tower and click any dashed floor to rent an office and found your own. The directory below lists everyone in the building.' }));
  openModal(body);
}

function renderStandupHistory(f, histEl) {
  histEl.innerHTML = '';
  if (!f.standups.length) {
    histEl.appendChild(el('div', { class: 'faint small', text: 'No standups yet. Run one — your agents will each bring something back.' }));
    return;
  }
  f.standups.slice(-3).reverse().forEach((s) => {
    const card = el('div', { class: 'standup' },
      el('div', { class: 'small faint', text: fmtDate(s.ts) + ' · cost ~3 calls' }));
    AGENTS.forEach((a) => {
      if (!s[a.role]) return;
      card.appendChild(el('div', { class: 'agent', text: a.emoji + ' ' + a.role }));
      card.appendChild(el('div', { class: 'out', text: s[a.role] }));
    });
    histEl.appendChild(card);
  });
}

function renderDecisions(f, decEl) {
  decEl.innerHTML = '';
  if (!f.decisions.length) {
    decEl.appendChild(el('div', { class: 'faint small', text: 'No decisions yet. Approve or redirect the Ops agent\'s cards after a standup.' }));
    return;
  }
  f.decisions.slice().reverse().forEach((d) => {
    decEl.appendChild(el('div', { class: 'row' },
      el('span', { class: 'chip ' + (d.choice === 'approve' ? 'good' : 'violet'), text: d.choice === 'approve' ? '✅ Approved' : '↪ Redirected' }),
      ' ', el('span', { class: 'faint', text: fmtDate(d.ts) + (d.note ? ' · ' + d.note : '') }),
      el('div', { class: 'small dim', text: d.card })));
  });
}

/* run fn, showing any error inside errEl (a DOM node) */
async function runSafe(fn, errEl) {
  errEl.innerHTML = '';
  errEl.style.display = 'none';
  try {
    return await fn();
  } catch (e) {
    const box = el('div', { class: 'error-box', style: 'margin:10px 0', text: e.message || String(e) });
    errEl.style.display = 'block';
    errEl.appendChild(box);
    return null;
  }
}

/* ---------- rent flow (found a company) ---------- */

function openRentModal(floorN) {
  const errEl = el('div', {});
  const form = el('div', {},
    el('h2', { text: 'Rent floor ' + floorN }),
    el('p', { class: 'small dim', text: 'Found your company. Three generation calls (profile, launch post, logo) run on your own Pollen key.' }));

  const nameIn = el('input', { type: 'text', placeholder: 'Company name (e.g. Comet Coffee)' });
  const pitchIn = el('input', { type: 'text', placeholder: 'One-line pitch (e.g. espresso from a bike cart)' });
  const catSel = el('select', {});
  CATEGORIES.forEach((c) => catSel.appendChild(el('option', { value: c, text: c })));

  const steps = [
    'Company profile (gpt-5.4-nano)',
    'Launch post (gpt-5.4-nano)',
    'Logo (image gen)',
  ];
  const stepEls = steps.map((t) => el('div', { class: 'st', text: '○ ' + t }));
  const stepBar = el('div', { class: 'stepbar', style: 'display:none' }, ...stepEls);
  const submit = el('button', { class: 'primary', text: 'Rent office · found company' });

  form.appendChild(el('div', { class: 'fieldrow' }, el('label', { class: 'field', text: 'Company name' }), nameIn));
  form.appendChild(el('div', { class: 'fieldrow' }, el('label', { class: 'field', text: 'One-line pitch' }), pitchIn));
  form.appendChild(el('div', { class: 'fieldrow' }, el('label', { class: 'field', text: 'Industry' }), catSel));
  form.appendChild(stepBar);
  form.appendChild(errEl);
  form.appendChild(submit);

  submit.addEventListener('click', () => runSafe(async () => {
    const name = nameIn.value.trim();
    const pitch = pitchIn.value.trim();
    if (!name) { errEl.textContent = 'Give your company a name first.'; return; }
    let client = PolliPage.client;
    if (!client) throw new Error('Connect your Pollen first (button top-right) — renting an office needs 3 generation calls on your key.');

    submit.disabled = true;
    stepBar.style.display = 'flex';
    stepEls.forEach((s) => { s.className = 'st'; s.textContent = s.textContent.replace(/^[○✓] /, '○ '); });

    const setStep = (i, done) => {
      stepEls[i].className = 'st ' + (done ? 'done' : 'on');
      stepEls[i].textContent = (done ? '✓ ' : '● ') + steps[i];
    };

    // (a) company profile + (b) launch post + (c) logo prompt — 3 parallel calls
    setStep(0, false); setStep(1, false); setStep(2, false);
    const profilePromise = client.chat(MODEL, [
      { role: 'system', content: 'You generate tiny company profiles. Reply ONLY with JSON: {"tagline": string, "story": string (2-3 sentences), "products": [3 strings], "customer": string}. No markdown fences.' },
      { role: 'user', content: 'Company: ' + name + '\nPitch: ' + (pitch || '(none given)') + '\nIndustry: ' + catSel.value + '\nMake it concrete, warm and plausible for a one-person company with AI agents.' },
    ], { temperature: 0.8, maxTokens: 400 });
    const launchPromise = client.chat(MODEL, [
      { role: 'system', content: 'You are the founder of a tiny one-person company. Write an 80-word launch announcement in the founder\'s first-person voice, warm, specific, ending with one call to action. Plain text only.' },
      { role: 'user', content: 'Company: ' + name + '\nPitch: ' + (pitch || '(none given)') + '\nIndustry: ' + catSel.value },
    ], { temperature: 0.9, maxTokens: 300 });

    const emojiFor = { Food: '🥐', Games: '🎮', Logistics: '📦', Home: '🪴', Services: '🧾', Music: '🎵', Energy: '⚡', Tech: '💻', Other: '🏢' };
    const logoUrl = client.imageUrl('minimal logo emblem for ' + name + ', flat vector style', { width: 512, height: 512 });

    let profile = {}, launch = '';
    try {
      const [profRes, launchRes] = await Promise.all([profilePromise, launchPromise]);
      const raw = (profRes.choices[0].message.content || '').replace(/```json|```/g, '').trim();
      const m = raw.match(/\{[\s\S]*\}/);
      try { profile = m ? JSON.parse(m[0]) : {}; } catch (e) { profile = { tagline: pitch, story: '', products: [], customer: '' }; }
      setStep(0, true);
      launch = ((launchRes.choices[0].message.content || '').trim());
      setStep(1, true);
    } catch (e) {
      submit.disabled = false;
      throw e;
    }
    // image URL is instant (no await needed) — mark done once img resolves is overkill
    setStep(2, true);

    const f = state.floors.find((x) => x.n === floorN);
    f.company = {
      name: name,
      pitch: pitch,
      industry: catSel.value,
      tagline: profile.tagline || pitch,
      story: profile.story || '',
      products: Array.isArray(profile.products) ? profile.products : [],
      customer: profile.customer || '',
      launch: launch,
      logoUrl: logoUrl,
      emoji: emojiFor[catSel.value] || '🏢',
      foundedTs: Date.now(),
    };
    saveState();
    renderAll();
    document.querySelectorAll('.modal-back').forEach((m) => m.remove());
    openOffice(floorN);
  }, errEl));

  openModal(form);
}

/* ---------- agent standup (core loop) ---------- */

const PERSONAS = {
  Researcher: 'You are the Researcher agent 🔍 at a tiny one-person company. You watch the market every day. In under 90 words, produce "today\'s insight": one concrete market observation specific to this company\'s industry, then ONE recommendation ("Recommendation:"). Plain text, no headings.',
  Marketer: 'You are the Marketer agent 📣 at a tiny one-person company. The Researcher agent just shared today\'s insight. Draft one social post (under 80 words) for the company\'s feed that turns that insight into something worth sharing. Founder\'s voice, plain text, no hashtags spam (max 2).',
  Ops: 'You are the Ops agent ⚙️ at a tiny one-person company. Given the company profile, the Researcher\'s insight and the Marketer\'s post, write: (1) CHANGELOG — 2-3 short bullet lines (use "-") of what shipped today; then (2) DECISION CARD — one decision the human owner must make, phrased as one sentence starting with "Decision:". Under 120 words total, plain text.',
};

function companyBrief(c) {
  return 'Company: ' + c.name + '\nTagline: ' + (c.tagline || '') + '\nPitch: ' + (c.pitch || '') + '\nIndustry: ' + (c.industry || '') +
    '\nStory: ' + (c.story || '') + '\nProducts: ' + (c.products || []).join('; ') + '\nCustomer: ' + (c.customer || '');
}

async function runStandup(f, histEl) {
  if (!PolliPage.client) throw new Error('Connect your Pollen first (button top-right) — standups run ~3 calls on your key.');
  const c = f.company;
  if (!c) return;

  histEl.innerHTML = '';
  const card = el('div', { class: 'standup' }, el('span', { class: 'spinner' }), ' agents are gathering…');
  histEl.appendChild(card);

  const brief = companyBrief(c);
  const standup = { ts: Date.now() };

  // chained: researcher → marketer (sees insight) → ops (sees both)
  const res = await PolliPage.client.chat(MODEL, [
    { role: 'system', content: PERSONAS.Researcher },
    { role: 'user', content: brief },
  ], { temperature: 0.8, maxTokens: 300 });
  standup.Researcher = ((res.choices[0].message.content || '')).trim();

  card.textContent = '';
  card.appendChild(el('div', { class: 'agent', text: '🔍 Researcher' }));
  card.appendChild(el('div', { class: 'out', text: standup.Researcher }));
  card.appendChild(el('div', { class: 'small faint', style: 'margin-top:8px' }, el('span', { class: 'spinner' }), ' 📣 Marketer drafting…'));

  const mkt = await PolliPage.client.chat(MODEL, [
    { role: 'system', content: PERSONAS.Marketer },
    { role: 'user', content: brief + '\n\nResearcher\'s insight today:\n' + standup.Researcher },
  ], { temperature: 0.9, maxTokens: 300 });
  standup.Marketer = ((mkt.choices[0].message.content || '')).trim();

  card.lastChild.remove();
  card.appendChild(el('div', { class: 'agent', text: '📣 Marketer' }));
  card.appendChild(el('div', { class: 'out', text: standup.Marketer }));
  card.appendChild(el('div', { class: 'small faint', style: 'margin-top:8px' }, el('span', { class: 'spinner' }), ' ⚙️ Ops writing changelog + decision card…'));

  const ops = await PolliPage.client.chat(MODEL, [
    { role: 'system', content: PERSONAS.Ops },
    { role: 'user', content: brief + '\n\nResearcher\'s insight:\n' + standup.Researcher + '\n\nMarketer\'s post:\n' + standup.Marketer },
  ], { temperature: 0.7, maxTokens: 350 });
  standup.Ops = ((ops.choices[0].message.content || '')).trim();

  // pull the decision sentence out of Ops output for the decision card
  const dm = standup.Ops.match(/Decision:\s*(.+)/i);
  standup.decision = dm ? dm[1].trim() : '';

  card.remove();
  f.standups.push(standup);
  if (f.standups.length > 12) f.standups = f.standups.slice(-12);
  saveState();
  renderStandupHistory(f, histEl);
  if (standup.decision) {
    const decCard = el('div', { class: 'decision-card' },
      el('div', { class: 'agent', text: '⚙️ Decision card for you, the owner' }),
      el('div', { class: 'out', text: standup.decision }));
    const noteIn = el('input', { type: 'text', placeholder: 'optional note for the log…' });
    const approveBtn = el('button', { class: 'small', style: 'margin-top:8px', text: 'Approve ✅' });
    const redirectBtn = el('button', { class: 'small ghost', style: 'margin-top:8px', text: 'Redirect ↪' });
    const done = () => {
      f.decisions.push({ ts: Date.now(), choice: choice, note: noteIn.value.trim(), card: standup.decision });
      if (f.decisions.length > 30) f.decisions = f.decisions.slice(-30);
      saveState();
      decCard.remove();
      renderStandupHistory(f, histEl);
      const decEl2 = histEl.parentElement.querySelector('.declog');
      if (decEl2) renderDecisions(f, decEl2);
    };
    let choice = 'approve';
    approveBtn.addEventListener('click', () => { choice = 'approve'; done(); });
    redirectBtn.addEventListener('click', () => { choice = 'redirect'; done(); });
    decCard.appendChild(noteIn);
    decCard.appendChild(approveBtn);
    decCard.appendChild(redirectBtn);
    histEl.insertBefore(decCard, histEl.firstChild);
  }
  renderStats();
}

/* ---------- boot ---------- */

document.getElementById('reset-tower').addEventListener('click', resetTower);
document.getElementById('dir-search').addEventListener('input', renderDirectory);

loadState();
renderAll();
initDrag();
