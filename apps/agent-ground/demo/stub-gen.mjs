/**
 * Offline stub of gen.pollinations.ai for the demo's scripted mode: real HTTP,
 * real shapes (profile/balance/models/chat), deterministic "generations" from
 * demo/fixtures. The BYOP proxy costs these calls exactly like production
 * (usage × pricing), so the budget firewall runs the real code path offline.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Pricing in Pollen per token (matches what the proxy fetches from /v1/models). */
export const STUB_PRICING = {
    promptTextTokens: "0.0000001",
    completionTextTokens: "0.0000005",
};
export const STUB_USAGE = { prompt_tokens: 5000, completion_tokens: 1000 };
/** Cost per scripted call: 5000×1e-7 + 1000×5e-7 = 0.001 Pollen. */
export const STUB_CALL_COST = 0.001;

const fixture = (name) => {
    try {
        return readFileSync(join(FIXTURES_DIR, `${name}.txt`), "utf8");
    } catch {
        return null;
    }
};

export function startStubGen({ port = 0, startBalance = 2, profile } = {}) {
    let balance = startBalance;
    const state = { calls: 0 };
    const server = createServer((req, res) => {
        const url = new URL(req.url, "http://stub");
        const send = (status, body) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(`${JSON.stringify(body)}\n`);
        };
        if (req.method === "GET" && url.pathname === "/account/profile") {
            return send(
                200,
                profile ?? { githubUsername: "NamanSoni78", image: "" },
            );
        }
        if (req.method === "GET" && url.pathname === "/account/balance") {
            return send(200, { balance: Math.round(balance * 1e8) / 1e8 });
        }
        if (req.method === "GET" && url.pathname === "/v1/models") {
            return send(200, {
                data: [
                    {
                        id: "openai/gpt-5.4-nano",
                        paid_only: false,
                        pricing: STUB_PRICING,
                    },
                    {
                        id: "openai/gpt-6-sol",
                        paid_only: false,
                        pricing: STUB_PRICING,
                    },
                    {
                        id: "openai/gpt-6.1-terra",
                        paid_only: false,
                        pricing: STUB_PRICING,
                    },
                ],
            });
        }
        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                state.calls += 1;
                const cost = STUB_CALL_COST;
                balance = Math.max(0, Math.round((balance - cost) * 1e8) / 1e8);
                let parsed = {};
                try {
                    parsed = JSON.parse(body || "{}");
                } catch {}
                const first = String(parsed?.messages?.[0]?.content ?? "");
                const fixtureMatch = first.match(/^fixture:([a-z0-9._-]+)$/);
                let content = "OK";
                if (fixtureMatch) {
                    const text = fixture(fixtureMatch[1]);
                    content = text ?? `(fixture not found: ${fixtureMatch[1]})`;
                }
                return send(200, {
                    id: `stub-${state.calls}`,
                    object: "chat.completion",
                    model: parsed?.model ?? "openai/gpt-6-sol",
                    choices: [
                        {
                            index: 0,
                            message: { role: "assistant", content },
                            finish_reason: "stop",
                        },
                    ],
                    usage: {
                        ...STUB_USAGE,
                        total_tokens:
                            STUB_USAGE.prompt_tokens +
                            STUB_USAGE.completion_tokens,
                    },
                });
            });
            return undefined;
        }
        return send(404, {
            error: { code: "not_found", message: url.pathname },
        });
    });
    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
            resolve({
                server,
                port: server.address().port,
                url: `http://127.0.0.1:${server.address().port}`,
                state,
                balance: () => balance,
                stop: () => new Promise((done) => server.close(done)),
            });
        });
    });
}
