import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const FANNED_FLAG = Symbol.for("pollinations.agent-ground.fanned");

/** RFC 6455 Sec-WebSocket-Accept for a given client key. */
export function acceptKey(key) {
    return crypto
        .createHash("sha1")
        .update(`${key}${WS_GUID}`)
        .digest("base64");
}

/** Encode an unmasked (server-to-client) frame with the given opcode. */
export function encodeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
        header = Buffer.alloc(2);
        header[1] = length;
    } else if (length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    return Buffer.concat([header, payload]);
}

/**
 * Parse as many complete frames as available in `buffer`.
 * Returns { rest, closed }. Every complete frame is passed to `onFrame`;
 * text/binary frames from the client are intentionally ignored by callers
 * (only ping -> pong and close are acted on).
 */
function parseFrames(buffer, onFrame) {
    let offset = 0;
    let closed = false;
    while (!closed) {
        if (buffer.length - offset < 2) break;
        const opcode = buffer[offset] & 0x0f;
        const masked = (buffer[offset + 1] & 0x80) !== 0;
        let length = buffer[offset + 1] & 0x7f;
        let cursor = offset + 2;
        if (length === 126) {
            if (buffer.length - cursor < 2) break;
            length = buffer.readUInt16BE(cursor);
            cursor += 2;
        } else if (length === 127) {
            if (buffer.length - cursor < 8) break;
            const big = buffer.readBigUInt64BE(cursor);
            cursor += 8;
            if (big > BigInt(MAX_FRAME_BYTES)) {
                closed = true;
                break;
            }
            length = Number(big);
        }
        let mask = null;
        if (masked) {
            if (buffer.length - cursor < 4) break;
            mask = buffer.subarray(cursor, cursor + 4);
            cursor += 4;
        }
        if (buffer.length - cursor < length) break;
        let payload = buffer.subarray(cursor, cursor + length);
        if (mask) {
            payload = Buffer.from(payload);
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        if (opcode === 0x8) closed = true;
        onFrame(opcode, payload);
        offset = cursor + length;
    }
    return { rest: buffer.subarray(offset), closed };
}

/**
 * Attach a minimal WebSocket endpoint (`GET /ws` upgrades) to an http server.
 * Sends `{type:"hello", at}` on connect, broadcasts text frames to all
 * clients, answers pings with pongs, and echoes close then ends.
 *
 * @param {import("node:http").Server} server - HTTP server to upgrade
 * @param {{onConnect?: (client: object) => void}} [options]
 * @returns {{size: number, broadcast, broadcastEvent, closeAll}} ws API
 */
export function attachWs(server, options = {}) {
    const clients = new Set();

    server.on("upgrade", (req, socket) => {
        const pathname = (req.url ?? "/").split("?")[0];
        const key = req.headers["sec-websocket-key"];
        const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
        if (pathname !== "/ws" || !key || upgrade !== "websocket") {
            socket.destroy();
            return;
        }
        socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
        );
        socket.setNoDelay(true);
        const client = {
            socket,
            send(text) {
                if (!socket.destroyed)
                    socket.write(
                        encodeFrame(0x1, Buffer.from(String(text), "utf8")),
                    );
            },
        };
        clients.add(client);
        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const result = parseFrames(buffer, (opcode, payload) => {
                if (opcode === 0x9 && !socket.destroyed)
                    socket.write(encodeFrame(0x0a, payload));
            });
            buffer = result.rest;
            if (result.closed) {
                clients.delete(client);
                if (!socket.destroyed) {
                    try {
                        socket.write(encodeFrame(0x8, Buffer.alloc(0)));
                    } catch {
                        /* socket already gone */
                    }
                    socket.end();
                }
            }
        });
        socket.on("close", () => clients.delete(client));
        socket.on("error", () => {
            clients.delete(client);
            socket.destroy();
        });
        client.send(
            JSON.stringify({ type: "hello", at: new Date().toISOString() }),
        );
        options.onConnect?.(client);
    });

    const ws = {
        get size() {
            return clients.size;
        },
        broadcast(text) {
            for (const client of clients) client.send(text);
        },
        broadcastEvent(type, evt) {
            const { at, ...rest } = evt ?? {};
            ws.broadcast(
                JSON.stringify({
                    type,
                    at: at ?? new Date().toISOString(),
                    ...rest,
                }),
            );
        },
        closeAll() {
            for (const client of clients) client.socket.destroy();
            clients.clear();
        },
    };
    return ws;
}

/**
 * Fan every event emitted by `emitters` (and every emitter in `options.emitters`)
 * out to WS clients as text frames `{type, at, ...payload}`. Implemented by
 * wrapping each EventEmitter's `emit`; idempotent per emitter.
 */
export function fanOut(ws, emitters = []) {
    for (const emitter of emitters) {
        if (
            !emitter ||
            typeof emitter.emit !== "function" ||
            emitter[FANNED_FLAG]
        )
            continue;
        emitter[FANNED_FLAG] = true;
        const original = emitter.emit.bind(emitter);
        emitter.emit = (type, evt) => {
            if (type !== "newListener" && type !== "removeListener") {
                ws.broadcastEvent(type, evt);
            }
            return original(type, evt);
        };
    }
}
