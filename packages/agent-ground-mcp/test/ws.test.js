import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGround } from "../src/index.js";
import { acceptKey, encodeFrame } from "../src/ws.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ground-ws-"));
}

function parseServerFrames(buffer) {
    let offset = 0;
    const frames = [];
    while (buffer.length - offset >= 2) {
        let length = buffer[offset + 1] & 0x7f;
        let cursor = offset + 2;
        if (length === 126) {
            if (buffer.length - cursor < 2) break;
            length = buffer.readUInt16BE(cursor);
            cursor += 2;
        } else if (length === 127) {
            if (buffer.length - cursor < 8) break;
            length = Number(buffer.readBigUInt64BE(cursor));
            cursor += 8;
        }
        if (buffer.length - cursor < length) break;
        frames.push({
            opcode: buffer[offset] & 0x0f,
            payload: buffer.subarray(cursor, cursor + length),
        });
        offset = cursor + length;
    }
    return { frames, rest: buffer.subarray(offset) };
}

function maskedClientFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    const header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | masked.length; // payload < 126 in tests
    return Buffer.concat([header, mask, masked]);
}

/** Minimal raw-socket WebSocket client. */
function wsConnect(port) {
    const socket = net.connect(port, "127.0.0.1");
    const key = crypto.randomBytes(16).toString("base64");
    const state = {
        handshake: null,
        raw: Buffer.alloc(0),
        buffer: Buffer.alloc(0),
        frames: [],
        waiters: [],
    };

    socket.on("data", (chunk) => {
        state.raw = Buffer.concat([state.raw, chunk]);
        if (!state.handshake) {
            const index = state.raw.indexOf("\r\n\r\n");
            if (index === -1) return;
            state.handshake = state.raw.subarray(0, index).toString();
            state.buffer = state.raw.subarray(index + 4);
        } else {
            state.buffer = Buffer.concat([state.buffer, chunk]);
        }
        const { frames, rest } = parseServerFrames(state.buffer);
        state.buffer = rest;
        for (const frame of frames) {
            if (state.waiters.length > 0) state.waiters.shift().resolve(frame);
            else state.frames.push(frame);
        }
    });

    socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );

    return {
        socket,
        key,
        handshake: () => state.handshake,
        readFrame(timeoutMs = 3000) {
            if (state.frames.length > 0)
                return Promise.resolve(state.frames.shift());
            return new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error("timed out waiting for a ws frame")),
                    timeoutMs,
                );
                state.waiters.push({
                    resolve: (frame) => {
                        clearTimeout(timer);
                        resolve(frame);
                    },
                });
            });
        },
        send(opcode, payload) {
            socket.write(maskedClientFrame(opcode, payload));
        },
    };
}

test("acceptKey computes the RFC 6455 handshake digest", () => {
    assert.equal(
        acceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        "RFC 6455 example vector",
    );
});

test("encodeFrame produces unmasked text frames", () => {
    const frame = encodeFrame(0x1, Buffer.from("hi"));
    assert.deepEqual([...frame], [0x81, 0x02, 0x68, 0x69]);
});

test("WS handshake, hello frame, event fan-out, injected emitter and ping->pong over a raw socket", async (t) => {
    const dir = tmpDir();
    const extra = new EventEmitter();
    const ground = await createGround({
        port: 0,
        stateDir: dir,
        emitters: [extra],
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const client = wsConnect(ground.port);
    t.after(() => client.socket.destroy());

    // handshake: wait for the 101 + correct Sec-WebSocket-Accept
    await new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error("handshake timeout")),
            3000,
        );
        const check = () => {
            if (client.handshake()) {
                clearTimeout(timer);
                resolve();
            }
        };
        client.socket.on("data", check);
        check();
    });
    const handshake = client.handshake();
    assert.ok(handshake.startsWith("HTTP/1.1 101"));
    const accept = handshake
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"))
        ?.slice(22)
        .trim();
    assert.equal(
        accept,
        crypto
            .createHash("sha1")
            .update(`${client.key}${WS_GUID}`)
            .digest("base64"),
    );

    // hello frame on connect
    const hello = await client.readFrame();
    assert.equal(hello.opcode, 0x1);
    const helloJson = JSON.parse(hello.payload.toString("utf8"));
    assert.equal(helloJson.type, "hello");
    assert.ok(!Number.isNaN(Date.parse(helloJson.at)));

    // every hub event is forwarded as a text frame {type, at, ...payload}
    ground.broadcast({
        kind: "milestone",
        from: "agent-alpha",
        summary: "auth module shipped",
    });
    const eventFrame = await client.readFrame();
    assert.equal(eventFrame.opcode, 0x1);
    const event = JSON.parse(eventFrame.payload.toString("utf8"));
    assert.equal(event.type, "ground.broadcast");
    assert.equal(event.kind, "milestone");
    assert.equal(event.from, "agent-alpha");
    assert.equal(event.summary, "auth module shipped");
    assert.ok(!Number.isNaN(Date.parse(event.at)));

    // events from injected emitters are fanned out too
    const at = new Date("2025-01-01T00:00:00.000Z").toISOString();
    extra.emit("budget.threshold", { level: "conservation", pct: 75, at });
    const proxyFrame = await client.readFrame();
    const proxyEvent = JSON.parse(proxyFrame.payload.toString("utf8"));
    assert.deepEqual(proxyEvent, {
        type: "budget.threshold",
        level: "conservation",
        pct: 75,
        at,
    });

    // client ping -> server pong with the same payload; client text frames are ignored
    client.send(0x9, Buffer.from("heartbeat"));
    client.send(0x1, Buffer.from("client text frames are ignored"));
    const pong = await client.readFrame();
    assert.equal(pong.opcode, 0xa);
    assert.equal(pong.payload.toString("utf8"), "heartbeat");
    await ground.stop(); // close the hub; nothing else may arrive after the pong
});

test("upgrade requests to non-/ws paths are rejected", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({ port: 0, stateDir: dir });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const result = await new Promise((resolve) => {
        const socket = net.connect(ground.port, "127.0.0.1");
        socket.on("error", () => resolve("error"));
        socket.on("close", () => resolve("closed"));
        socket.on("data", (chunk) => {
            if (chunk.length > 0)
                resolve(`unexpected data: ${chunk.toString()}`);
        });
        socket.write(
            `GET /elsewhere HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
        setTimeout(() => resolve("timeout"), 3000);
    });
    assert.ok(
        result === "closed" || result === "error",
        `socket destroyed, got: ${result}`,
    );
});
