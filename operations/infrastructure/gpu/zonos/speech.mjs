import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const maxConcurrent = 6;
const speakerId = "default_853b30a7338f306e";
let active = 0;

const port = Number(process.env.ZONOS_PORT) || 1920;
const modelUrl =
    process.env.ZONOS_MODEL_URL || "http://127.0.0.1:1919/v2/generate";
// A wedged model server or encoder must not hold one of the six slots (and
// the GPU rental) until the client gives up, so every request carries a
// time-to-first-byte deadline plus an overall watchdog. Defaults leave room
// for the full 10,000-character request on slow hardware; tests override them.
const ttfbTimeoutMs = Number(process.env.ZONOS_TTFB_TIMEOUT_MS) || 60_000;
const maxSpeechMs = Number(process.env.ZONOS_MAX_SPEECH_MS) || 20 * 60_000;

function unavailable(response, status, message) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: message }));
}

async function handleSpeech(request, response) {
    if (request.method !== "POST" || request.url !== "/speech") {
        unavailable(response, 404, "Unknown route");
        return;
    }
    if (active >= maxConcurrent) {
        unavailable(response, 429, "All six speech slots are busy");
        return;
    }

    // Hold the slot through the end of the audio stream or cancellation.
    active++;
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    const watchdog = setTimeout(() => abort.abort(), maxSpeechMs);
    let ffmpeg;
    let exited;
    try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > 64 * 1024) {
                unavailable(response, 413, "Request is too large");
                return;
            }
            chunks.push(chunk);
        }
        let input;
        try {
            input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
            unavailable(response, 400, "Invalid JSON");
            return;
        }
        if (
            typeof input?.text !== "string" ||
            !input.text.trim() ||
            input.text.length > 10000 ||
            !["mp3", "pcm"].includes(input.format)
        ) {
            unavailable(response, 400, "Expected text and mp3 or pcm format");
            return;
        }
        const firstByte = setTimeout(() => abort.abort(), ttfbTimeoutMs);
        let upstream;
        try {
            upstream = await fetch(modelUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    text: input.text,
                    speaker_embedding_id: speakerId,
                    stream: true,
                }),
                signal: abort.signal,
            });
        } finally {
            clearTimeout(firstByte);
        }
        const sampleRate = Number(upstream.headers.get("x-audio-sample-rate"));
        if (
            !upstream.ok ||
            !upstream.body ||
            upstream.headers.get("x-audio-format") !== "float32" ||
            upstream.headers.get("x-audio-channels") !== "1" ||
            !Number.isSafeInteger(sampleRate) ||
            sampleRate < 8000 ||
            sampleRate > 192000
        ) {
            unavailable(
                response,
                502,
                "Invalid response from the speech runtime",
            );
            return;
        }
        const pcm = input.format === "pcm";
        ffmpeg = spawn(
            "ffmpeg",
            [
                "-loglevel",
                "error",
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
                "-f",
                "f32le",
                "-ar",
                String(sampleRate),
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-ar",
                "24000",
                "-f",
                pcm ? "s16le" : "mp3",
                "-flush_packets",
                "1",
                "pipe:1",
            ],
            { stdio: ["pipe", "pipe", "inherit"] },
        );
        exited = once(ffmpeg, "close");
        const encode = pipeline(Readable.fromWeb(upstream.body), ffmpeg.stdin, {
            signal: abort.signal,
        });
        const write = async () => {
            for await (const chunk of ffmpeg.stdout) {
                if (!response.headersSent) {
                    response.writeHead(200, {
                        "content-type": pcm ? "audio/pcm" : "audio/mpeg",
                    });
                }
                if (!response.write(chunk)) {
                    await once(response, "drain", { signal: abort.signal });
                }
            }
        };
        const [[status]] = await Promise.all([exited, encode, write()]);
        if (status !== 0 || !response.headersSent) {
            throw new Error("Audio encoder did not finish");
        }
        response.end();
    } catch {
        if (response.headersSent) response.destroy();
        else if (!response.destroyed)
            unavailable(response, 502, "Speech failed");
    } finally {
        clearTimeout(watchdog);
        abort.abort();
        if (ffmpeg) {
            ffmpeg.kill();
            await exited?.catch(() => undefined);
        }
        active--;
    }
}

createServer(handleSpeech).listen(port, "127.0.0.1");
