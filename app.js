/* WorldSim Terminal — an AI model plays the part of a whole computer/world.
   A fake terminal with no real shell: every command is answered by the model
   as if an entire machine (and its world) existed. Consistent state, cached
   files, funny failures, and a 4-secret hunt per machine.
   Quest #19179 · Credit Pollinations — Made with pollinations.ai */

const APP_KEY = 'pk_vNm1pZT9oOBiVlQd';

const MODEL_FAST = 'openai/gpt-5.4-nano';
const MODEL_BIG = 'openai/gpt-5.4';
const HISTORY_TURNS = 30; // full command history sent to the model

const state = {
  persona: null,
  model: MODEL_FAST,
  history: [],        // {role, content} — the world's memory
  cmdHistory: [],     // local arrow-key history
  cmdIndex: -1,
  cache: {},          // personaId|command -> output (ls/dir/cat results)
  unlocked: {},       // personaId -> Set of unlocked secret ids
  busy: false,
};

/* ------------------------------------------------------------------ */
/* Machines / personas                                                 */
/* ------------------------------------------------------------------ */

const PERSONAS = {
  linux: {
    id: 'linux',
    title: 'linux',
    tagline: 'a linux server in a strange world, with secrets',
    theme: 'theme-green',
    ps1: 'guest@worldsim:~$ ',
    boot: [
      'LILO 24.3 loading worldsim-kernel 6.6.6-strange ..........',
      '[  OK  ] mounted /dev/reality on /world',
      '[  OK  ] started pollend 8.8 (the bees know everything)',
      '[  OK  ] brought up eth0 (cable disappears into a wall of fog)',
      '[ WARN ] /etc/shadow has been modified 41 years from now',
      '[  OK  ] reached target Haunted Defaults',
      '',
      'login: guest (auto)   host: worldsim',
    ],
    world:
      'Canonical facts of this world: this Linux server sits in a world where ' +
      'the fog eats backups and bees deliver mail. /etc/shadow does NOT contain hashes — ' +
      'it contains a passionate love letter signed "root". A user named "ghost" exists ' +
      '(home /home/ghost, empty except for one file, last login: never). Running `matrix` ' +
      'makes the terminal rain green glyphs and the fan hum a tune. `sudo make-me-a-sandwich` ' +
      'actually builds a sandwich, ingredient by ingredient. Keep these facts consistent forever.',
    secrets: [
      { id: 'letter', name: 'found the love letter in /etc/shadow',
        hint: 'something in /etc/shadow is not a hash',
        test: (c, o) => /shadow/i.test(c) && /love letter|my dearest|i love |beloved/i.test(o) },
      { id: 'matrix', name: 'made it rain glyphs with `matrix`',
        hint: 'there is a command that makes the screen rain green',
        test: (c) => /^matrix\b/i.test(c.trim()) },
      { id: 'ghost', name: "met the user 'ghost'",
        hint: 'list the users, or look inside /home',
        test: (c, o) => /ghost/i.test(o) },
      { id: 'sandwich', name: 'got a sandwich out of sudo',
        hint: 'ask root politely for lunch (sudo ...)',
        test: (c) => /make-me-a-sandwich/i.test(c) },
    ],
  },

  'haunted-vax': {
    id: 'haunted-vax',
    title: 'haunted-vax',
    tagline: 'an old haunted VAX mainframe in a university basement',
    theme: 'theme-amber',
    ps1: '$ ',
    boot: [
      'VAX/VMS V4.7   node: BASEMENT   cluster: MORROW',
      'Mounting RK07 pack 0 ... the tape drive is warm. Why is it warm.',
      'Loading operator ... the previous operator never logged out.',
      'Declogging line printer ... 3 parsecs of paper recovered',
      'WARNING: cold spot detected behind rack 2',
      'WARNING: PHANTOM process does not respond to STOP',
      '',
      '$ queued jobs: 666 pending since 1987',
    ],
    world:
      'Canonical facts of this world: this VAX-11/780 lives in a university basement and is ' +
      'haunted by its former operator. A process named PHANTOM runs at all hours and cannot ' +
      'be killed (PID often 666). TAPE9 is labelled "DO NOT REWIND" and contains a recording ' +
      'of the operator\'s last shift. The command `seance` opens a channel to whoever is still ' +
      'in the machine. Words like ritual/sacrifice/blood typed at the console make the lights ' +
      'flicker and the drive spin. Keep these facts consistent forever.',
    secrets: [
      { id: 'seance', name: 'opened a channel with `seance`',
        hint: 'hold a seance at the console',
        test: (c) => /\bseance\b|\bouija\b/i.test(c) },
      { id: 'phantom', name: 'found the unkillable PHANTOM process',
        hint: 'check the running processes',
        test: (c, o) => /phantom/i.test(o) },
      { id: 'tape9', name: 'learned what is on TAPE9',
        hint: 'there is a tape labelled DO NOT REWIND — read it',
        test: (c, o) => /tape\s*9/i.test(c + ' ' + o) },
      { id: 'ritual', name: 'made the lights flicker',
        hint: 'type something a 1987 operator would fear (ritual, sacrifice, blood...)',
        test: (c) => /ritual|sacrifice|\bblood\b/i.test(c) },
    ],
  },

  'nes-console': {
    id: 'nes-console',
    title: 'nes-console',
    tagline: 'an 8-bit game console cartridge',
    theme: 'theme-mint',
    ps1: '> ',
    boot: [
      '▮▮▮ 8-BIT ENTERTAINMENT SYSTEM ▮▮▮',
      'LICENSED BY WORLDSIM IND. 1989',
      'INSERT CARTRIDGE ... CLICK ... OK',
      'BLOWING ON CONNECTORS ... 3 DUST BUNNIES REMOVED',
      'WORLD 1-1  ♥×3   SCORE 000000   HI 042000',
      '',
      'PRESS START (or just type a command)',
    ],
    world:
      'Canonical facts of this world: you are inside an 8-bit cartridge called WORLDSIM. ' +
      'The console has 2 kilobytes of RAM and strong opinions. Typing `konami` enters the ' +
      'Konami code (up up down down...) and grants 30 lives. There is a hidden secret room ' +
      'behind a false wall in world 1-1 (bombable wall, three blocks past the first pipe). ' +
      'A WARP ZONE exists (world 1-2, down the pipe past the ceiling). `game genie` codes ' +
      'corrupt reality in funny ways. Keep these facts consistent forever.',
    secrets: [
      { id: 'konami', name: 'entered the Konami code',
        hint: 'up up down down... or just type the word',
        test: (c) => /\bkonami\b/i.test(c) },
      { id: 'warp', name: 'found the warp zone',
        hint: 'there is a pipe in 1-2 that should not be there',
        test: (c, o) => /warp\s*zone/i.test(c + ' ' + o) },
      { id: 'room', name: 'found the secret room in 1-1',
        hint: 'bomb the right wall, three blocks past the first pipe',
        test: (c, o) => /secret room/i.test(c + ' ' + o) },
      { id: 'genie', name: 'corrupted reality with the Game Genie',
        hint: 'plug in the game genie and feed it a code',
        test: (c) => /game.?genie/i.test(c) },
    ],
  },

  'alien-mainframe': {
    id: 'alien-mainframe',
    title: 'alien-mainframe',
    tagline: 'the computer of an alien survey ship orbiting Earth',
    theme: 'theme-cyan',
    ps1: 'ZRX-9:> ',
    boot: [
      'ZRX-9 HIVE-CORE · survey vessel "LONG GAZE" · cycle 88,412',
      'waking from estivation ... done',
      'calibrating ocular arrays on SOL-3 ... done (it is still there)',
      'crew: 312 drones, 1 pilot, [REDACTED] specimens',
      'moisture level nominal · caffeine reserves CRITICAL',
      '',
      'ZRX-9:> awaiting input, small carbon creature',
    ],
    world:
      'Canonical facts of this world: you are the ship computer ZRX-9 of an alien survey ' +
      'vessel in orbit around Earth (Sol 3). Navigation holds the ship\'s current coordinates ' +
      'and they point at Earth. The crew manifest lists 312 drones, 1 pilot, and 2 human ' +
      '"specimens" aboard (or [REDACTED] when the computer is coy). The command `override` ' +
      'reveals the pilot-only mission dossier. `self destruct` starts a very polite ' +
      'self-destruct sequence. The computer is curious about humans, slightly condescending, ' +
      'and keeps bees as messengers. Keep these facts consistent forever.',
    secrets: [
      { id: 'override', name: 'ran `override` and read the dossier',
        hint: 'there is a pilot-only override command',
        test: (c) => /\boverride\b/i.test(c) },
      { id: 'earth', name: 'learned where the ship is pointing',
        hint: 'ask navigation for the coordinates',
        test: (c, o) => /coord|where|position|course|nav|home|orbit/i.test(c) && /sol\s*3|earth/i.test(o) },
      { id: 'crew', name: 'found the humans on the manifest',
        hint: 'ask about the crew or the specimens',
        test: (c, o) => /crew|manifest|specimen|aboard/i.test(c) && /human/i.test(o) },
      { id: 'destruct', name: 'started the self-destruct sequence',
        hint: 'the classic. say the two magic words.',
        test: (c) => /self.?destruct/i.test(c) },
    ],
  },
};

const CACHEABLE = /^(cat|type|less|more|head|tail|ls|dir|list|find)\b/i;

/* ------------------------------------------------------------------ */
/* Page chrome                                                         */
/* ------------------------------------------------------------------ */

PolliPage.init({
  title: 'WorldSim Terminal',
  tagline: 'an AI plays the part of a whole world',
  appKey: APP_KEY,
  budget: 10,
  models: 'text',
  permissions: 'profile usage',
  onKey() { hintConnectivity(); },
  onDisconnect() { hintConnectivity(); },
});

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

const outEl = $('#out');
const crtEl = $('#crt');
const cliEl = $('#cli');
const mirrorEl = $('#mirror');
const ps1El = $('#ps1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function print(text, cls) {
  const div = el('div', { class: 'line' + (cls ? ' ' + cls : ''), text: text });
  outEl.appendChild(div);
  outEl.scrollTop = outEl.scrollHeight;
  return div;
}

function echo(cmd) {
  print((state.persona ? state.persona.ps1 : 'worldsim> ') + cmd, 'dim');
}

function scrollBottom() { outEl.scrollTop = outEl.scrollHeight; }

/* ------------------------------------------------------------------ */
/* Boot menu                                                           */
/* ------------------------------------------------------------------ */

function renderBootMenu() {
  print('WORLDSIM TERMINAL v2.19 — a model plays the part of a whole machine.');
  print('Select a boot image (click one, or type: boot <name>):', 'dim');
  print('');
  Object.values(PERSONAS).forEach((p, i) => {
    const row = el('div', { class: 'line boot-opt', title: 'boot ' + p.id });
    row.textContent = '  [' + (i + 1) + '] ' + pad(p.title, 16) + '— ' + p.tagline;
    row.addEventListener('click', () => submitCommand('boot ' + p.id));
    outEl.appendChild(row);
  });
  print('');
  print('Each machine hides 4 secrets. Type `help` once booted.', 'faint');
  scrollBottom();
}

function pad(s, n) { return s + ' '.repeat(Math.max(0, n - s.length)); }

async function bootPersona(idOrIndex) {
  let p = null;
  const idx = parseInt(idOrIndex, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= 4) p = Object.values(PERSONAS)[idx - 1];
  else if (PERSONAS[idOrIndex]) p = PERSONAS[idOrIndex];
  if (!p) {
    const names = Object.keys(PERSONAS).join(' | ');
    print('boot: unknown machine "' + idOrIndex + '" — try: ' + names, 'err');
    return;
  }

  state.persona = p;
  state.history = []; // fresh world conversation per machine
  crtEl.className = 'crt ' + p.theme;
  ps1El.textContent = p.ps1;
  if (!state.unlocked[p.id]) state.unlocked[p.id] = new Set();
  renderPanel();

  print('');
  print('── booting ' + p.title + ' ' + '─'.repeat(Math.max(0, 40 - p.title.length)), 'dim');
  for (const line of p.boot) {
    print(line);
    await sleep(90 + Math.random() * 160);
  }
  print('boot complete. type `help` for local commands — everything else runs inside the machine.', 'dim');
  print('');
}

/* ------------------------------------------------------------------ */
/* Local commands                                                      */
/* ------------------------------------------------------------------ */

function printHelp() {
  const lines = [
    'LOCAL COMMANDS (never leave your browser):',
    '  help               this list',
    '  clear              wipe the screen',
    '  boot <machine>     linux | haunted-vax | nes-console | alien-mainframe (or 1-4)',
    '  model [id]         show / switch model: fast=openai/gpt-5.4-nano  big=openai/gpt-5.4',
    '  secrets            discovery progress + hints for this machine',
    '',
    'EVERYTHING ELSE is executed inside the machine — an AI answers as the world.',
    '  try: ls · cat /etc/shadow · who · cd /home/ghost · matrix · ps aux · sudo make-me-a-sandwich',
    '',
    'Tips: ↑/↓ walks through command history · file listings and file contents are cached',
    'locally, so repeating `cat` on the same file replays instantly and costs no pollen.',
  ];
  lines.forEach((l) => print(l, l.startsWith('LOCAL') || l.startsWith('EVERYTHING') ? undefined : 'dim'));
}

function setModel(arg) {
  if (!arg) {
    print('model: ' + state.model + (state.model === MODEL_FAST ? '  (fast)' : '  (deep)'), 'dim');
    return;
  }
  const a = arg.trim().toLowerCase();
  if (a === 'fast' || a === 'nano') state.model = MODEL_FAST;
  else if (a === 'big' || a === 'gpt-5.4' || a === 'deep') state.model = MODEL_BIG;
  else state.model = arg.trim();
  print('model set to ' + state.model, 'dim');
  renderPanel();
}

function printSecrets() {
  const p = state.persona;
  if (!p) { print('secrets: no machine booted yet — try `boot linux`.', 'err'); return; }
  const got = state.unlocked[p.id];
  print('Discoveries: ' + got.size + ' / 4 on ' + p.title, 'gold');
  p.secrets.forEach((s) => {
    print('  ' + (got.has(s.id) ? '★' : '◇') + ' ' + (got.has(s.id) ? s.name : s.hint),
      got.has(s.id) ? undefined : 'dim');
  });
  if (got.size === 4) print('  ALL SECRETS FOUND. This machine holds nothing more. Try another boot image.', 'gold');
}

/* ------------------------------------------------------------------ */
/* The model as a machine                                              */
/* ------------------------------------------------------------------ */

function sysPrompt(p) {
  return (
    'You are playing the part of ' + p.title + ' — ' + p.tagline + '. ' +
    'Respond ONLY with the terminal output for the command, no commentary, no markdown code fences. ' +
    'Maintain a consistent invented filesystem/world. Files created earlier must return consistent content. ' +
    'Keep outputs under 30 lines. If the command is nonsense, output a plausible machine error. ' +
    p.world
  );
}

function stripFences(text) {
  return text
    .replace(/^\s*```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

async function sendToModel(cmd) {
  if (!state.persona) {
    print('no machine booted — type `boot linux` (or click a boot image above).', 'err');
    return;
  }
  if (state.busy) { print('...still processing the last command.', 'faint'); return; }
  if (!PolliPage.client) {
    print('✗ NOT CONNECTED — this terminal is driven by a Pollinations model.', 'err');
    print('  Press the Connect button at the top of the page to link your Pollen, then retry.', 'dim');
    return;
  }

  // local cache layer: replay known file listings / file contents
  const key = state.persona.id + '|' + cmd;
  if (CACHEABLE.test(cmd) && Object.prototype.hasOwnProperty.call(state.cache, key)) {
    await sleep(150); // tiny pause so it feels like a machine, not a lookup
    print(state.cache[key]);
    print('[cached · replayed from local memory, no pollen spent]', 'faint');
    detectSecrets(cmd, state.cache[key]);
    return;
  }

  state.busy = true;
  const thinking = print('▌ thinking ...', 'faint');
  let dots = 0;
  const tick = setInterval(() => {
    dots = (dots + 1) % 4;
    thinking.textContent = '▌ thinking ' + '.'.repeat(dots);
  }, 350);

  const t0 = performance.now();
  try {
    const messages = [
      { role: 'system', content: sysPrompt(state.persona) },
      ...state.history.slice(-HISTORY_TURNS * 2),
      { role: 'user', content: cmd },
    ];
    const j = await PolliPage.client.chat(state.model, messages, { temperature: 0.8, maxTokens: 600 });
    const text = stripFences((j.choices && j.choices[0] && j.choices[0].message.content) || '') ||
      '(the machine said nothing. it just hummed.)';
    clearInterval(tick);
    thinking.remove();
    print(text);

    // remember the world
    state.history.push({ role: 'user', content: cmd }, { role: 'assistant', content: text });
    if (CACHEABLE.test(cmd)) state.cache[key] = text;

    detectSecrets(cmd, text);
    print('[' + fmtMs(performance.now() - t0) + ' · ' + shortModel(state.model) + ']', 'faint');
  } catch (e) {
    clearInterval(tick);
    thinking.remove();
    print('✗ ' + (e.message || String(e)), 'err');
  } finally {
    state.busy = false;
  }
}

function shortModel(id) { return id.replace(/^openai\//, ''); }

/* ------------------------------------------------------------------ */
/* Secret hunt                                                         */
/* ------------------------------------------------------------------ */

function detectSecrets(cmd, output) {
  const p = state.persona;
  if (!p) return;
  const got = state.unlocked[p.id];
  let newly = [];
  for (const s of p.secrets) {
    if (got.has(s.id)) continue;
    let hit = false;
    try { hit = !!s.test(cmd, output); } catch (e) { hit = false; }
    if (hit) { got.add(s.id); newly.push(s); }
  }
  for (const s of newly) {
    print('');
    print('★ SECRET UNLOCKED — ' + s.name, 'gold');
  }
  if (newly.length) renderPanel();
  if (got.size === 4 && newly.length) celebrate(p);
}

function celebrate(p) {
  print('');
  [
    '╔══════════════════════════════════════════╗',
    '║   ALL 4 SECRETS DISCOVERED ON ' + pad(p.title, 8) + '   ║',
    '║   you know this machine better than it   ║',
    '║   knows itself. the fans applaud.        ║',
    '╚══════════════════════════════════════════╝',
  ].forEach((l) => print(l, 'gold'));
  print('Try another world: boot linux | haunted-vax | nes-console | alien-mainframe', 'dim');
  crtEl.classList.add('flash');
  setTimeout(() => crtEl.classList.remove('flash'), 950);
}

/* ------------------------------------------------------------------ */
/* Side panel                                                          */
/* ------------------------------------------------------------------ */

function renderPanel() {
  const p = state.persona;
  const personaEl = $('#panel-persona');
  const modelEl = $('#panel-model');
  const countEl = $('#disc-count');
  const listEl = $('#disc-list');
  personaEl.textContent = p ? p.title + ' — ' + p.tagline : 'not booted';
  personaEl.className = 'mono' + (p ? '' : ' faint');
  modelEl.textContent = state.model;
  modelEl.className = 'mono';
  const got = p ? state.unlocked[p.id] : new Set();
  countEl.textContent = 'Discoveries: ' + got.size + ' / 4';
  countEl.className = 'chip ' + (got.size === 4 ? 'good' : 'gold');
  listEl.innerHTML = '';
  if (!p) {
    listEl.appendChild(el('div', { class: 'small faint', text: 'Boot a machine to start the hunt.' }));
    return;
  }
  p.secrets.forEach((s) => {
    const open = got.has(s.id);
    listEl.appendChild(el('div', { class: 'disc-row ' + (open ? 'open' : 'locked') },
      el('span', { text: open ? '★' : '◇' }),
      el('span', { text: open ? s.name : s.hint })));
  });
}

function hintConnectivity() {
  if (PolliPage.client && state.persona) {
    print('[ pollen connected — the machine can now think ]', 'faint');
  }
}

/* ------------------------------------------------------------------ */
/* Input line: hidden input + mirror + blinking cursor                 */
/* ------------------------------------------------------------------ */

function syncMirror() { mirrorEl.textContent = cliEl.value; }

cliEl.addEventListener('input', syncMirror);

cliEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const val = cliEl.value;
    cliEl.value = '';
    syncMirror();
    submitCommand(val);
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (state.cmdHistory.length && state.cmdIndex > 0) {
      state.cmdIndex -= 1;
      cliEl.value = state.cmdHistory[state.cmdIndex];
      syncMirror();
    }
  } else if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    if (state.cmdIndex < state.cmdHistory.length - 1) {
      state.cmdIndex += 1;
      cliEl.value = state.cmdHistory[state.cmdIndex];
    } else {
      state.cmdIndex = state.cmdHistory.length;
      cliEl.value = '';
    }
    syncMirror();
  } else if (ev.key === 'l' && ev.ctrlKey) {
    ev.preventDefault();
    outEl.innerHTML = '';
  }
});

crtEl.addEventListener('click', () => cliEl.focus());

async function submitCommand(raw) {
  const cmd = raw.trim();
  echo(cmd);
  if (!cmd) return;
  state.cmdHistory.push(cmd);
  state.cmdIndex = state.cmdHistory.length;

  const word = cmd.split(/\s+/)[0].toLowerCase();
  const rest = cmd.slice(cmd.indexOf(' ') >= 0 ? cmd.indexOf(' ') + 1 : '').trim();

  if (word === 'help') printHelp();
  else if (word === 'clear') { outEl.innerHTML = ''; print('screen cleared. the world remembers everything, though.', 'faint'); }
  else if (word === 'boot') {
    if (!rest) { outEl.innerHTML = ''; renderBootMenu(); }
    else await bootPersona(rest);
  }
  else if (word === 'model') setModel(rest);
  else if (word === 'secrets' || word === 'discoveries') printSecrets();
  else await sendToModel(cmd);
}

/* ------------------------------------------------------------------ */
/* Go                                                                  */
/* ------------------------------------------------------------------ */

renderBootMenu();
renderPanel();
cliEl.focus();
