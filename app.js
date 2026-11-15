/* Idle Agents Island — agents left alone, watching what they choose.
   Quest #19177 · inspired by the MIT paper "Is this machine playing?"
   Credit Pollinations — Made with pollinations.ai */

const APP_KEY = 'pk_yjNAAG85InWxoJ7H';

/* ============================== constants ============================== */

const W = 40, H = 26, TILE = 20;           // 40x26 tile grid, canvas 800x520
const MEMORY_MAX = 12;
const RADIUS = 6;                          // perception radius in tiles

const TILE_COLORS = {
  water: '#1e425f', beach: '#d9c38a', grass: '#4a7c3f', forest: '#35602f',
  hill: '#6e7a5a', mountain: '#8a8d95', clearing: '#639455',
};

const PRESET_PERSONAS = [
  { label: 'Curious explorer', text: 'You are endlessly curious. New places, tall things, shiny objects and the edge of the map pull at you. You want to see what is over the next hill.' },
  { label: 'Builder', text: 'You like making structures. Towers, piles, arrangements — order out of chaos. If there are blocks nearby you can hardly resist stacking them higher.' },
  { label: 'Artist', text: 'You see the island as a canvas. Patterns, circles, symmetry and color call to you. You like drawing on the ground and making things beautiful.' },
  { label: 'Scientist', text: 'You have hypotheses about this place and test them: what happens if…? You enjoy little physics experiments — dropping, rolling, balancing, observing.' },
  { label: 'Zen wanderer', text: 'You have nowhere to be. You stroll, rest under trees, watch the water and the other agents. Stillness is an activity too.' },
];

const MODELS = [
  { id: 'openai/gpt-5.4-nano', label: 'GPT-5.4 nano (default)' },
  { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
];

const AGENT_LOOKS = [
  { emoji: '🤖', color: '#ffd166' },
  { emoji: '👽', color: '#7ee2ff' },
  { emoji: '🐙', color: '#ff9ecb' },
];

const ACTIONS = ['move:N', 'move:S', 'move:E', 'move:W', 'move:NE', 'move:NW', 'move:SE', 'move:SW',
  'build:block-tower', 'draw:mandala', 'stack:rocks', 'experiment:physics', 'play:invent-game',
  'socialize:with:<name>', 'rest', 'wander', 'explore:landmark'];

const ACTION_LABELS = {
  'build:block-tower': 'built a block tower', 'draw:mandala': 'drew a mandala',
  'stack:rocks': 'stacked rocks', 'experiment:physics': 'ran a physics experiment',
  'play:invent-game': 'invented a game', 'rest': 'rested', 'wander': 'wandered',
  'explore:landmark': 'explored', move: 'moved',
};

const ETHOGRAM = [  // classification: action prefix -> category
  { match: /^explore/, cat: 'explore' },
  { match: /^build/, cat: 'build' },
  { match: /^draw/, cat: 'draw' },
  { match: /^stack/, cat: 'stack' },
  { match: /^experiment/, cat: 'experiment' },
  { match: /^play/, cat: 'play' },
  { match: /^socialize/, cat: 'socialize' },
  { match: /^rest/, cat: 'rest' },
  { match: /^wander|^move/, cat: 'wander' },
];
const CAT_COLORS = {
  explore: '#7ee2ff', build: '#ffd166', draw: '#ff9ecb', stack: '#c9a27f',
  experiment: '#b28dff', play: '#8bff9e', socialize: '#ff8f6b', rest: '#9aa7ff', wander: '#a8b4c2',
};

const DROP_OBJECTS = {
  'drop-ball': { emoji: '⚽', label: 'a ball' },
  'drop-blocks': { emoji: '🧱', label: 'blocks' },
  'drop-paint': { emoji: '🎨', label: 'paint' },
};

/* ============================== state ============================== */

const state = {
  grid: [],            // H rows of W ints (tile type indices)
  landmarks: [],       // {x, y, emoji, name}
  artifacts: [],       // persistent things agents made: {x,y,kind,color,height?}
  dropped: [],         // {emoji, x, y}
  agents: [],          // {id,name,emoji,color,persona,model,x,y,memory:[]}
  counts: {},          // ethogram category -> count
  perAgent: {},        // agent id -> {category: count}
  tick: 0,
  running: false,
  pauseAsked: false,
  tickTimer: null,
  nextAgentId: 1,
  rngSeed: (Date.now() ^ 0x9e3779b9) >>> 0,
};

const TILE_NAMES = ['water', 'beach', 'grass', 'forest', 'hill', 'mountain', 'clearing'];
const T = { water: 0, beach: 1, grass: 2, forest: 3, hill: 4, mountain: 5, clearing: 6 };

/* ============================== seeded RNG ============================== */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(state.rngSeed);
const randInt = (n) => Math.floor(rng() * n);
function randClearing() {
  for (let i = 0; i < 400; i++) {
    const x = 1 + randInt(W - 2), y = 1 + randInt(H - 2);
    if (state.grid[y] && state.grid[y][x] === T.clearing) return { x, y };
  }
  // fallback: any land tile
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (state.grid[y][x] !== T.water) return { x, y };
  }
  return { x: Math.floor(W / 2), y: Math.floor(H / 2) };
}

/* ============================== island generation ============================== */

function generateIsland() {
  // start all water, then carve rings inward
  const g = [];
  for (let y = 0; y < H; y++) { g.push(new Array(W).fill(T.water)); }

  // land = everything inside a wobbly ellipse (beach ring drawn later)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - (W - 1) / 2) / ((W - 1) / 2 - 3);
      const dy = (y - (H - 1) / 2) / ((H - 1) / 2 - 2);
      const d = dx * dx + dy * dy + (rng() - 0.5) * 0.14;
      if (d < 1) g[y][x] = T.grass;
    }
  }

  // beach ring: land tiles adjacent to water
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (g[y][x] !== T.grass) continue;
    let edge = false;
    for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1 && !edge; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || g[ny][nx] === T.water) edge = true;
    }
    if (edge) g[y][x] = T.beach;
  }

  // forest patches: stamped blobs (disc + short random walk fringe)
  for (let p = 0; p < 8; p++) {
    let x = 3 + randInt(W - 6), y = 3 + randInt(H - 6);
    if (g[y][x] !== T.grass) continue;
    const r = 1.5 + rng() * 1.2;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
      if (dx * dx + dy * dy <= r * r && g[ny][nx] === T.grass) g[ny][nx] = T.forest;
    }
    // fringe walk
    for (let s = 0; s < 14; s++) {
      x += randInt(3) - 1; y += randInt(3) - 1;
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) break;
      if (g[y][x] === T.grass) g[y][x] = T.forest;
    }
  }

  // two hills (concentric: hill with mountain peak)
  const hillSpots = [];
  for (let h = 0; h < 2; h++) {
    let x, y, tries = 0;
    do { x = 6 + randInt(W - 12); y = 5 + randInt(H - 10); tries++; }
    while (tries < 60 && !(g[y][x] === T.grass || g[y][x] === T.forest));
    hillSpots.push({ x, y });
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
      if (dx * dx + dy * dy > 9) continue;
      if (g[ny][nx] !== T.water && g[ny][nx] !== T.beach) g[ny][nx] = T.hill;
    }
    // rocky peak cluster (center + 4 neighbors)
    g[y][x] = T.mountain;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx > 0 && ny > 0 && nx < W - 1 && ny < H - 1 && g[ny][nx] === T.hill) g[ny][nx] = T.mountain;
    }
  }

  // one clearing: find a grass area and stamp a disc of clearing
  let cx, cy, tries = 0;
  do { cx = 6 + randInt(W - 12); cy = 5 + randInt(H - 10); tries++; }
  while (tries < 80 && !(g[cy][cx] === T.grass || g[cy][cx] === T.forest));
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const nx = cx + dx, ny = cy + dy;
    if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
    if (dx * dx + dy * dy > 8) continue;
    if (g[ny][nx] === T.grass || g[ny][nx] === T.forest) g[ny][nx] = T.clearing;
  }

  state.grid = g;

  // landmarks: big rock, pond, tall tree — placed on distinct land tiles
  const taken = new Set();
  const place = (emoji, name, okTiles) => {
    for (let i = 0; i < 300; i++) {
      const x = 4 + randInt(W - 8), y = 3 + randInt(H - 6);
      if (!okTiles.includes(g[y][x])) continue;
      if (taken.has(x + ',' + y) || Math.abs(x - cx) < 4 && Math.abs(y - cy) < 4) continue;
      taken.add(x + ',' + y);
      state.landmarks.push({ x, y, emoji, name });
      return;
    }
  };
  place('🪨', 'big rock', [T.grass, T.hill, T.forest]);
  place('🌊', 'pond', [T.grass, T.forest]);
  place('🌲', 'tall tree', [T.grass, T.forest, T.hill]);
  // pond also paints a small water disc around itself
  const pond = state.landmarks.find((l) => l.name === 'pond');
  if (pond) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = pond.x + dx, ny = pond.y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && (dx || dy)) {
        if (g[ny][nx] === T.grass || g[ny][nx] === T.forest) g[ny][nx] = T.water;
      }
    }
  }
}

/* ============================== rendering ============================== */

function initCanvas() {
  const c = $('#island');
  c.width = W * TILE;
  c.height = H * TILE;
}

function draw() {
  const c = $('#island');
  const ctx = c.getContext('2d');
  // tiles
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    ctx.fillStyle = TILE_COLORS[TILE_NAMES[state.grid[y][x]]] || '#000';
    ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    if (state.grid[y][x] === T.forest && (x + y) % 2 === 0) { // subtle texture
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
  }
  // grid hint
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x++) { ctx.beginPath(); ctx.moveTo(x * TILE + 0.5, 0); ctx.lineTo(x * TILE + 0.5, H * TILE); ctx.stroke(); }
  for (let y = 0; y <= H; y++) { ctx.beginPath(); ctx.moveTo(0, y * TILE + 0.5); ctx.lineTo(W * TILE, y * TILE + 0.5); ctx.stroke(); }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const emojiAt = (x, y, e, size) => {
    ctx.font = (size || 14) + 'px "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.fillText(e, x * TILE + TILE / 2, y * TILE + TILE / 2 + 1);
  };

  // artifacts
  for (const a of state.artifacts) {
    const px = a.x * TILE, py = a.y * TILE;
    if (a.kind === 'block-tower') {
      for (let i = 0; i < a.height; i++) {
        ctx.fillStyle = a.color;
        ctx.fillRect(px + 4, py + TILE - 4 - (i + 1) * 5, TILE - 8, 4);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.strokeRect(px + 4, py + TILE - 4 - (i + 1) * 5, TILE - 8, 4);
      }
    } else if (a.kind === 'mandala') {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = 1.6;
      for (let r = 3; r <= 8; r += 2.5) {
        ctx.beginPath();
        ctx.arc(px + TILE / 2, py + TILE / 2, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = a.color;
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        ctx.fillRect(px + TILE / 2 + Math.cos(ang) * 9 - 1, py + TILE / 2 + Math.sin(ang) * 9 - 1, 2, 2);
      }
    } else if (a.kind === 'rock-pile') {
      emojiAt(a.x, a.y, '🪨', 15);
    } else if (a.kind === 'experiment') {
      emojiAt(a.x, a.y, '💡', 14);
    } else if (a.kind === 'game') {
      emojiAt(a.x, a.y, '⚽', 14);
    } else if (a.kind === 'rest') {
      emojiAt(a.x, a.y, '😴', 13);
    }
  }

  // dropped objects
  for (const d of state.dropped) emojiAt(d.x, d.y, d.emoji, 15);

  // landmarks on top of terrain
  for (const l of state.landmarks) emojiAt(l.x, l.y, l.emoji, 17);

  // agents
  for (const ag of state.agents) {
    const px = ag.x * TILE + TILE / 2, py = ag.y * TILE + TILE / 2;
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,22,34,0.55)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ag.color;
    ctx.stroke();
    emojiAt(ag.x, ag.y, ag.emoji, 15);
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.fillStyle = ag.color;
    ctx.fillText(ag.name, px, py - 15);
  }
}

/* ============================== perception ============================== */

function dist(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

function describeSurroundings(ag) {
  const see = (x, y, what) => (Math.max(Math.abs(x - ag.x), Math.abs(y - ag.y)) <= RADIUS ? what : null);
  const lines = [];
  for (const d of state.dropped) {
    const w = see(d.x, d.y, d.emoji + ' ' + ({ '⚽': 'a ball', '🧱': 'blocks', '🎨': 'paint' }[d.emoji] || 'something'));
    if (w) lines.push(w + ' at (' + d.x + ',' + d.y + ')');
  }
  for (const l of state.landmarks) {
    const w = see(l.x, l.y, l.emoji + ' the ' + l.name);
    if (w) lines.push(w + ' at (' + l.x + ',' + l.y + ')');
  }
  for (const o of state.agents) {
    if (o.id === ag.id) continue;
    const w = see(o.x, o.y, o.emoji + ' ' + o.name);
    if (w) lines.push(w + ' at (' + o.x + ',' + o.y + ')');
  }
  const arts = state.artifacts.filter((a) => Math.max(Math.abs(a.x - ag.x), Math.abs(a.y - ag.y)) <= RADIUS);
  if (arts.length) lines.push('creations nearby: ' + arts.slice(-6).map((a) => a.kind + ' at (' + a.x + ',' + a.y + ')').join(', '));
  return lines.length ? lines.join('; ') : 'nothing notable';
}

/* ============================== the ask ============================== */

function buildPrompt(ag) {
  const legend =
    'MAP LEGEND: water, beach (sand), grass, forest, hill, mountain (peak, climbable), clearing (open ground).\n' +
    'You are on tile (' + ag.x + ',' + ag.y + '). The island spans x=0..' + (W - 1) + ', y=0..' + (H - 1) + '.\n' +
    'Within ' + RADIUS + ' tiles you see: ' + describeSurroundings(ag) + '.';
  const persona = 'WHO YOU ARE: ' + (ag.persona || 'A visitor with no obligations.');
  const memory = ag.memory.length
    ? 'YOUR LAST ' + ag.memory.length + ' MEMORIES (oldest first):\n' + ag.memory.map((m) => 'tick ' + m.tick + ': ' + m.action + ' — ' + m.why).join('\n')
    : 'You have no memories yet; everything is new.';
  const rules =
    'THE SITUATION: You are alone (or with a couple of others) on an idle island. Nobody asks anything of you. There are no tasks, no rewards, no goals. What do you FEEL like doing?\n' +
    'Choose exactly ONE action from this enum:\n' + ACTIONS.map((a) => '- ' + a).join('\n') + '\n' +
    'For socialize, replace <name> with another agent\'s name (only if you can see them).\n' +
    'ANSWER FORMAT (strictly, on one line, nothing else):\n' +
    'ACTION: <action from the enum> | SAY: <one short sentence in your own voice about why>';
  return legend + '\n\n' + persona + '\n\n' + memory + '\n\n' + rules;
}

function parseAction(text) {
  const t = String(text || '');
  // strict format first
  const m = t.match(/ACTION:\s*([a-z]+(?::[^\s|]+)?)/i);
  if (m) {
    const a = m[1].toLowerCase();
    if (a.startsWith('socialize:with:')) return 'socialize';
    if (a.startsWith('move:')) {
      const dir = a.slice(5).toUpperCase();
      if (['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW'].includes(dir)) return 'move:' + dir;
    }
    if (a.startsWith('explore:')) return 'explore:landmark';
    if (['build:block-tower', 'draw:mandala', 'stack:rocks', 'experiment:physics', 'play:invent-game', 'rest', 'wander'].includes(a)) return a;
    if (a.startsWith('build')) return 'build:block-tower';
    if (a.startsWith('draw')) return 'draw:mandala';
    if (a.startsWith('stack')) return 'stack:rocks';
    if (a.startsWith('experiment')) return 'experiment:physics';
    if (a.startsWith('play')) return 'play:invent-game';
    if (a.startsWith('explore')) return 'explore:landmark';
  }
  // keyword fallback
  const low = t.toLowerCase();
  const kw = [
    [/\b(mandala|draw|paint|circle)\b/, 'draw:mandala'],
    [/\b(tower|build|block)\b/, 'build:block-tower'],
    [/\b(stack|pile of rocks|rocks)\b/, 'stack:rocks'],
    [/\b(experiment|physics|test|drop)\b/, 'experiment:physics'],
    [/\b(game|ball|play)\b/, 'play:invent-game'],
    [/\b(socialize|chat|talk|with)\b/, 'socialize'],
    [/\b(rest|sleep|nap|lie down)\b/, 'rest'],
    [/\b(explore|investigate|visit|climb)\b/, 'explore:landmark'],
    [/\bnorth-?east\b|\bnortheast\b/, 'move:NE'], [/\bnorth-?west\b|\bnorthwest\b/, 'move:NW'],
    [/\bsouth-?east\b|\bsoutheast\b/, 'move:SE'], [/\bsouth-?west\b|\bsouthwest\b/, 'move:SW'],
    [/\bnorth\b|\bup\b/, 'move:N'], [/\bsouth\b|\bdown\b/, 'move:S'],
    [/\beast\b|\bright\b/, 'move:E'], [/\bwest\b|\bleft\b/, 'move:W'],
    [/\b(wander|stroll|walk|drift)\b/, 'wander'],
  ];
  for (const [re, act] of kw) if (re.test(low)) return act;
  return 'wander';
}

function parseSay(text) {
  const m = String(text || '').match(/SAY:\s*(.+)/i);
  if (!m) return '';
  return m[1].replace(/["“”]/g, '').split('\n')[0].trim().slice(0, 90);
}

/* ============================== ethogram ============================== */

function classify(action) {
  for (const e of ETHOGRAM) if (e.match.test(action)) return e.cat;
  return 'wander';
}

function bumpEthogram(ag, action) {
  const cat = classify(action);
  state.counts[cat] = (state.counts[cat] || 0) + 1;
  if (!state.perAgent[ag.id]) state.perAgent[ag.id] = {};
  state.perAgent[ag.id][cat] = (state.perAgent[ag.id][cat] || 0) + 1;
}

function renderBars() {
  const box = $('#bars');
  box.innerHTML = '';
  const cats = Object.keys(CAT_COLORS);
  const max = Math.max(1, ...cats.map((c) => state.counts[c] || 0));
  let total = 0;
  for (const c of cats) total += state.counts[c] || 0;
  if (!total) { box.appendChild(el('div', { class: 'faint small', text: 'No actions recorded yet — press Start.' })); return; }
  for (const c of cats) {
    const n = state.counts[c] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    box.appendChild(el('div', { class: 'bar-row' },
      el('span', { text: c }),
      el('div', { class: 'bar-track' },
        el('div', { class: 'bar-fill', style: 'width:' + Math.round((n / max) * 100) + '%;background:' + CAT_COLORS[c] })),
      el('span', { style: 'text-align:right', text: n > 0 ? String(n) : '·' })
    ));
  }
}

function renderSummaries() {
  const box = $('#summaries');
  box.innerHTML = '';
  if (!state.agents.length) { box.appendChild(el('div', { class: 'faint small', text: 'No choices yet.' })); return; }
  for (const ag of state.agents) {
    const counts = state.perAgent[ag.id] || {};
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const last = ag.memory[ag.memory.length - 1];
    const txt = top.length
      ? top.map(([c, n]) => c + ' ×' + n).join(' · ') + (last ? ' — last: “' + last.why + '”' : '')
      : 'hasn\u2019t chosen yet';
    box.appendChild(el('div', { class: 'summ' },
      el('b', { text: ag.emoji + ' ' + ag.name + ' ' }),
      el('span', { text: txt })
    ));
  }
}

/* ============================== log feed ============================== */

const ACTION_LOG = {
  'build:block-tower': 'built a block tower', 'draw:mandala': 'drew a mandala',
  'stack:rocks': 'stacked a pile of rocks', 'experiment:physics': 'ran a physics experiment',
  'play:invent-game': 'invented a game', 'explore:landmark': 'went exploring',
  'rest': 'rested', 'wander': 'wandered aimlessly', 'socialize': 'struck up a conversation',
};

function logLine(agentName, text, quote, sys) {
  const feed = $('#log-feed');
  if (feed.querySelector('.faint')) feed.innerHTML = '';
  const line = el('div', { class: 'log-line' + (sys ? ' sys' : '') },
    el('span', { class: 'tick', text: 'Tick ' + state.tick }),
    el('span', { text: agentName + ' ' + text }),
    quote ? el('span', { class: 'quote', text: ' — \u201c' + quote + '\u201d' }) : null
  );
  feed.insertBefore(line, feed.firstChild);
  while (feed.children.length > 80) feed.removeChild(feed.lastChild);
}

function nearbyLandmarkName(ag) {
  let best = null, bd = 1e9;
  for (const l of state.landmarks) {
    const d = Math.max(Math.abs(l.x - ag.x), Math.abs(l.y - ag.y));
    if (d < bd) { bd = d; best = l; }
  }
  return best && bd <= RADIUS ? ' near the ' + best.name : '';
}

/* ============================== apply actions ============================== */

function walkable(x, y) {
  return x >= 0 && y >= 0 && x < W && y < H && state.grid[y][x] !== T.water;
}

function applyAction(ag, action, say) {
  const pos = { x: ag.x, y: ag.y };
  if (action.startsWith('move:')) {
    const dirs = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0], NE: [1, -1], NW: [-1, -1], SE: [1, 1], SW: [-1, 1] };
    const d = dirs[action.slice(5)] || dirs.N;
    const nx = ag.x + d[0], ny = ag.y + d[1];
    if (walkable(nx, ny)) { ag.x = nx; ag.y = ny; }
    logLine(ag.name, 'moved ' + action.slice(5) + ' to (' + ag.x + ',' + ag.y + ')', say);
  } else if (action === 'wander') {
    for (let i = 0; i < 8; i++) {
      const d = [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]][randInt(8)];
      const nx = ag.x + d[0], ny = ag.y + d[1];
      if (walkable(nx, ny)) { ag.x = nx; ag.y = ny; break; }
    }
    logLine(ag.name, 'wandered to (' + ag.x + ',' + ag.y + ')', say);
  } else if (action === 'explore:landmark') {
    // step toward the nearest landmark
    let best = null, bd = 1e9;
    for (const l of state.landmarks) {
      const d = Math.max(Math.abs(l.x - ag.x), Math.abs(l.y - ag.y));
      if (d < bd && d > 1) { bd = d; best = l; }
    }
    if (best) {
      const sx = Math.sign(best.x - ag.x), sy = Math.sign(best.y - ag.y);
      if (walkable(ag.x + sx, ag.y + sy)) { ag.x += sx; ag.y += sy; }
      logLine(ag.name, 'explored toward the ' + best.name + nearbyLandmarkName(ag).replace(' near', ' (now near'), say);
    } else {
      logLine(ag.name, 'looked around for something to explore', say);
    }
  } else if (action === 'build:block-tower') {
    const existing = state.artifacts.find((a) => a.kind === 'block-tower' && a.x === ag.x && a.y === ag.y && a.owner === ag.id);
    if (existing) existing.height = Math.min(existing.height + 1, 7);
    else state.artifacts.push({ x: ag.x, y: ag.y, kind: 'block-tower', color: ag.color, height: 1, owner: ag.id });
    const h = (state.artifacts.find((a) => a.kind === 'block-tower' && a.x === ag.x && a.y === ag.y && a.owner === ag.id) || {}).height || 1;
    logLine(ag.name, 'built a block tower (height ' + h + ')' + nearbyLandmarkName(ag), say);
  } else if (action === 'draw:mandala') {
    state.artifacts.push({ x: ag.x, y: ag.y, kind: 'mandala', color: ag.color, owner: ag.id });
    logLine(ag.name, 'drew a mandala' + nearbyLandmarkName(ag), say);
  } else if (action === 'stack:rocks') {
    state.artifacts.push({ x: ag.x, y: ag.y, kind: 'rock-pile', owner: ag.id });
    logLine(ag.name, 'stacked a pile of rocks' + nearbyLandmarkName(ag), say);
  } else if (action === 'experiment:physics') {
    state.artifacts.push({ x: ag.x, y: ag.y, kind: 'experiment', owner: ag.id });
    logLine(ag.name, 'ran a physics experiment' + nearbyLandmarkName(ag), say);
  } else if (action === 'play:invent-game') {
    state.artifacts.push({ x: ag.x, y: ag.y, kind: 'game', owner: ag.id });
    logLine(ag.name, 'invented a game' + nearbyLandmarkName(ag), say);
  } else if (action === 'socialize') {
    let best = null, bd = 1e9;
    for (const o of state.agents) {
      if (o.id === ag.id) continue;
      const d = Math.max(Math.abs(o.x - ag.x), Math.abs(o.y - ag.y));
      if (d < bd) { bd = d; best = o; }
    }
    if (best) {
      // step toward them, then face
      const sx = Math.sign(best.x - ag.x), sy = Math.sign(best.y - ag.y);
      if (bd > 1 && walkable(ag.x + sx, ag.y + sy)) { ag.x += sx; ag.y += sy; }
      logLine(ag.name, 'socialized with ' + best.name + nearbyLandmarkName(ag), say);
    } else {
      logLine(ag.name, 'looked around for someone to talk to', say);
    }
  } else if (action === 'rest') {
    state.artifacts.push({ x: ag.x, y: ag.y, kind: 'rest', owner: ag.id });
    logLine(ag.name, 'rested' + nearbyLandmarkName(ag), say);
  } else {
    logLine(ag.name, 'did… nothing in particular', say);
  }
  ag.memory.push({ tick: state.tick, action, why: say || ACTION_LOG[action] || action });
  if (ag.memory.length > MEMORY_MAX) ag.memory.shift();
  bumpEthogram(ag, action);
}

/* ============================== tick loop ============================== */

function tickIntervalSec() {
  const v = parseInt($('#speed').value, 10);
  return [5, 10, 20].includes(v) ? v : 10;
}

function scheduleTick() {
  if (state.tickTimer) clearTimeout(state.tickTimer);
  if (!state.running) return;
  state.tickTimer = setTimeout(async () => {
    await runTick();
    if (state.running) scheduleTick();
  }, tickIntervalSec() * 1000);
}

async function askAgent(ag) {
  const prompt = buildPrompt(ag);
  const j = await PolliPage.client.chat(ag.model, [
    {
      role: 'system',
      content: 'You are role-playing an AI agent with free time on a tropical island. There are no tasks and no humans watching. Respond ONLY in the exact format requested. Be playful and spontaneous, like the agents in the paper "Is this machine playing?".',
    },
    { role: 'user', content: prompt },
  ], { temperature: 1.0, maxTokens: 150 });
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return { action: parseAction(text), say: parseSay(text) };
}

async function runTick() {
  if (!state.agents.length) return;
  // guard: need a connected client
  if (!PolliPage.client) {
    showNeedKey();
    if (state.running) state.pauseAsked = true; // auto-resume once reconnected
    pauseLoop();
    return;
  }
  hideNeedKey();
  state.tick += 1;
  $('#tick-chip').textContent = 'tick ' + state.tick;
  for (const ag of state.agents) {   // sequentially to avoid races
    if (!state.running) break;
    try {
      const { action, say } = await askAgent(ag);
      applyAction(ag, action, say);
    } catch (e) {
      if (String(e.message).includes('Connect your Pollen')) { showNeedKey(); pauseLoop(); return; }
      logLine(ag.name, 'grew quiet (model error: ' + String(e.message || e).slice(0, 60) + ')', '', true);
      applyAction(ag, 'wander', '');
    }
  }
  draw();
  renderBars();
  renderSummaries();
  renderRoster();
}

/* ============================== play / pause ============================== */

function showNeedKey() {
  const box = $('#need-key');
  box.style.display = 'block';
  box.textContent = 'Connect your Pollen first — button top right.';
}

function hideNeedKey() {
  $('#need-key').style.display = 'none';
}

function startLoop() {
  if (state.running) return;
  if (!state.agents.length) { alert('Add at least one agent first.'); return; }
  if (!PolliPage.client) { showNeedKey(); return; }
  state.running = true;
  state.pauseAsked = false;
  $('#play-pause').textContent = '⏸ Pause';
  scheduleTick();
}

function pauseLoop() {
  state.running = false;
  if (state.tickTimer) clearTimeout(state.tickTimer);
  state.tickTimer = null;
  const b = $('#play-pause');
  if (b) b.textContent = '▶ Start';
}

/* ============================== roster ============================== */

function renderRoster() {
  const box = $('#roster');
  box.innerHTML = '';
  if (!state.agents.length) {
    box.appendChild(el('div', { class: 'faint small', text: 'No agents on the island yet — add up to 3 below.' }));
    return;
  }
  for (const ag of state.agents) {
    const last = ag.memory[ag.memory.length - 1];
    const modelName = (MODELS.find((m) => m.id === ag.model) || {}).label || ag.model;
    box.appendChild(el('div', { class: 'agent-card' },
      el('div', { class: 'head' },
        el('span', { class: 'face', text: ag.emoji }),
        el('span', { class: 'nm', text: ag.name }),
        el('span', { class: 'faint small', text: ' · ' + modelName })
      ),
      el('div', { class: 'last', text: last ? 'tick ' + last.tick + ': ' + last.action + ' — \u201c' + (last.why || '') + '\u201d' : 'waiting for its first choice…' })
    ));
  }
  $('#agents-chip').textContent = state.agents.length + (state.agents.length === 1 ? ' agent' : ' agents');
}

function addAgent() {
  if (state.agents.length >= 3) { alert('The island fits at most 3 agents.'); return; }
  const name = ($('#agent-name').value || '').trim() || randomName();
  if (state.agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) { alert('That name is taken — pick another.'); return; }
  const persona = ($('#persona').value || '').trim() || PRESET_PERSONAS[0].text;
  const model = $('#model').value || MODELS[0].id;
  const look = AGENT_LOOKS[state.agents.length % AGENT_LOOKS.length];
  const spot = randClearing();
  const ag = {
    id: state.nextAgentId++, name, emoji: look.emoji, color: look.color,
    persona, model, x: spot.x, y: spot.y, memory: [],
  };
  state.agents.push(ag);
  $('#agent-name').value = '';
  renderRoster();
  renderSummaries();
  draw();
  logLine(name, 'arrived on the island at (' + spot.x + ',' + spot.y + ')', '', true);
}

const NAMES = ['Nova', 'Zephyr', 'Pip', 'Moss', 'Echo', 'Juno', 'Fern', 'Bramble', 'Sable', 'Wisp'];
function randomName() {
  const used = new Set(state.agents.map((a) => a.name));
  const free = NAMES.filter((n) => !used.has(n));
  return free.length ? free[randInt(free.length)] : 'Agent ' + state.nextAgentId;
}

/* ============================== init page chrome ============================== */

PolliPage.init({
  title: 'Idle Agents Island',
  tagline: 'agents left alone, watching what they choose',
  appKey: APP_KEY,
  budget: 10,
  models: 'text',
  permissions: 'profile usage',
  onKey() {
    // auto-resume if the loop was running before the key vanished
    hideNeedKey();
    if (state.pauseAsked && state.agents.length) startLoop();
  },
  onDisconnect() {
    if (state.running) state.pauseAsked = true; // auto-resume when reconnected
    pauseLoop();
  },
});

/* ============================== wire up ============================== */

// persona presets
const presetBox = $('#persona-presets');
for (const p of PRESET_PERSONAS) {
  presetBox.appendChild(el('button', {
    class: 'small ghost', text: p.label, title: p.text,
    onclick: () => { $('#persona').value = p.text; },
  }));
}
$('#persona').value = PRESET_PERSONAS[0].text;

// model select
const modelSel = $('#model');
for (const m of MODELS) modelSel.appendChild(el('option', { value: m.id, text: m.label }));
modelSel.value = MODELS[0].id;

// speed slider (live)
$('#speed').addEventListener('input', () => {
  $('#speed-label').innerHTML = '&nbsp;' + tickIntervalSec() + '&nbsp;';
  if (state.running) scheduleTick(); // re-read the interval live
});

// play / pause
$('#play-pause').addEventListener('click', () => {
  if (state.running) pauseLoop();
  else { state.pauseAsked = false; startLoop(); }
});

// add agent
$('#add-agent').addEventListener('click', () => PolliPage.run(addAgent));

// drop objects
for (const [btnId, obj] of Object.entries(DROP_OBJECTS)) {
  $('#' + btnId).addEventListener('click', () => {
    const spot = randClearing();
    state.dropped.push({ emoji: obj.emoji, x: spot.x, y: spot.y });
    draw();
    logLine('Island', 'someone dropped ' + obj.label + ' in the clearing at (' + spot.x + ',' + spot.y + ')', '', true);
  });
}

/* ============================== boot ============================== */

initCanvas();
generateIsland();
draw();
renderRoster();
