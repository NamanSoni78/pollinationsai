/**
 * MCP Arena — game-state API for the browser UI (query-param routing).
 * Same persistent room store as the /mcp endpoint.
 *
 * GET  /api/rooms                          → { rooms: [...] }
 * GET  /api/rooms?id=ROOM                  → room public state
 * POST /api/rooms  { action:'create', name, difficulty }        → { roomId, playerId, room }
 * POST /api/rooms  { action:'join', roomId, name }              → { playerId, room }
 * POST /api/rooms  { action:'start', playerId, roomId }         → room
 * POST /api/rooms  { action:'clue', playerId, roomId, clue }    → { ok, word?, room }
 * POST /api/rooms  { action:'guess', playerId, roomId, guess }  → { ok, correct?, word?, room }
 * POST /api/rooms  { action:'chat', playerId, roomId, message } → room
 *
 * Credit Pollinations — Made with pollinations.ai
 */

import { listRooms, getRoom, saveRoom, createRoom, pushEvent, nextRound, publicState, pid, pickWord } from '../lib/roomStore.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function pub(room) {
  return {
    id: room.id,
    name: room.name,
    status: room.status,
    difficulty: room.difficulty,
    round: room.round,
    players: room.players.map((p) => ({ name: p.name, score: p.score, isGiver: p.id === room.giverId })),
    events: room.events.slice(-40),
    updated: room.lastActive,
  };
}

export async function onRequest(ctx) {
  const req = ctx.request;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (id) {
      const room = await getRoom(id);
      if (!room) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: JSON_HEADERS });
      return new Response(JSON.stringify(pub(room)), { headers: JSON_HEADERS });
    }
    const rooms = await listRooms();
    return new Response(JSON.stringify({ rooms: rooms.map(pub) }), { headers: JSON_HEADERS });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const action = body.action || '';

    if (action === 'create') {
      const name = String(body.name || 'player').slice(0, 32);
      const { room, player } = await createRoom(name, body.difficulty);
      return new Response(JSON.stringify({ roomId: room.id, playerId: player.id, room: pub(room) }), { headers: JSON_HEADERS });
    }
    if (action === 'join') {
      const room = await getRoom(String(body.roomId || ''));
      if (!room) return new Response(JSON.stringify({ error: 'room not found' }), { status: 404, headers: JSON_HEADERS });
      if (room.players.length >= 8) return new Response(JSON.stringify({ error: 'room full' }), { status: 400, headers: JSON_HEADERS });
      const name = String(body.name || 'guest').slice(0, 32);
      const player = { id: pid(), name, score: 0 };
      room.players.push(player);
      pushEvent(room, 'join', name, 'joined');
      await saveRoom(room);
      return new Response(JSON.stringify({ playerId: player.id, room: pub(room) }), { headers: JSON_HEADERS });
    }

    const room = await getRoom(String(body.roomId || ''));
    if (!room) return new Response(JSON.stringify({ error: 'room not found' }), { status: 404, headers: JSON_HEADERS });
    const player = room.players.find((p) => p.id === body.playerId);
    if (!player) return new Response(JSON.stringify({ error: 'not in room' }), { status: 403, headers: JSON_HEADERS });

    if (action === 'start') {
      if (room.players.length >= 2 && room.status !== 'playing') {
        room.round = 1;
        room.giverId = room.players[0].id;
        room.word = pickWord(room.difficulty);
        room.status = 'playing';
        pushEvent(room, 'system', 'host', 'game started — ' + room.players[0].name + ' is the clue-giver');
        await saveRoom(room);
      }
      return new Response(JSON.stringify(pub(room)), { headers: JSON_HEADERS });
    }
    if (action === 'clue') {
      const clue = String(body.clue || '').trim().slice(0, 60);
      const isGiver = player.id === room.giverId;
      const valid = room.status === 'playing' && isGiver && clue && !clue.toLowerCase().includes(room.word.toLowerCase());
      if (valid) pushEvent(room, 'clue', player.name, clue);
      else if (room.status === 'playing' && isGiver && clue && clue.toLowerCase().includes(room.word.toLowerCase())) {
        pushEvent(room, 'foul', player.name, 'clue contained the secret word — rejected');
      }
      await saveRoom(room);
      return new Response(JSON.stringify({ ok: valid, word: isGiver ? room.word : undefined, room: pub(room) }), { headers: JSON_HEADERS });
    }
    if (action === 'guess') {
      const guess = String(body.guess || '').trim();
      pushEvent(room, 'guess', player.name, guess.slice(0, 60));
      if (room.status === 'playing' && player.id !== room.giverId && guess.toLowerCase() === room.word.toLowerCase()) {
        player.score += 3;
        const giver = room.players.find((p) => p.id === room.giverId);
        if (giver) giver.score += 1;
        const prevWord = room.word;
        pushEvent(room, 'correct', player.name, 'guessed "' + prevWord + '"! +3');
        nextRound(room);
        await saveRoom(room);
        return new Response(JSON.stringify({ ok: true, correct: true, word: prevWord, room: pub(room) }), { headers: JSON_HEADERS });
      }
      await saveRoom(room);
      return new Response(JSON.stringify({ ok: true, correct: false, room: pub(room) }), { headers: JSON_HEADERS });
    }
    if (action === 'chat') {
      pushEvent(room, 'chat', player.name, String(body.message || '').slice(0, 200));
      await saveRoom(room);
      return new Response(JSON.stringify(pub(room)), { headers: JSON_HEADERS });
    }
  }
  return new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers: JSON_HEADERS });
}
