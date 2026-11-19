// BYOP proxy: one local HTTP server that gives every paid Pollinations call
// an identity and a hard Pollen budget. It boots against GEN, forwards
// metered paths with the BYOP key, costs responses from usage x model
// pricing, reconciles against the live balance, and answers metered paths
// with 402 insufficient_pollen once the budget is cut off.

import { EventEmitter } from "node:events";
import http from "node:http";
import {
    isMeteredPath,
    pathOnly,
    pipeUpstream,
    requestUpstream,
} from "./forward.js";
import { computeCost, createMeter, extractUsageAndModel } from "./meter.js";

const DEFAULT_BASE_URL = "https://gen.pollinations.ai";
const DEFAULT_PORT = 8878;
const DEFAULT_MAX_POLLEN = 5;
const DEFAULT_RECONCILE_MS = 15000;
const PRICING_TTL_MS = 10 * 60 * 1000;
const LEDGER_WINDOW = 20;

/** Env-aware port resolution: explicit option wins, then AGENT_BYOP_PORT, then 8878. */
export function resolvePort(explicit) {
    if (explicit !== undefined && explicit !== null) {
        const port = Number(explicit);
        if (!Number.isInteger(port) || port < 0)
            throw new Error(`Invalid proxy port: ${explicit}`);
        return port;
    }
    const fromEnv = Number(process.env.AGENT_BYOP_PORT);
    return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

/** Env-aware GEN base URL (POLLINATIONS_BASE_URL), trailing slashes stripped. */
export function resolveBaseUrl(explicit) {
    const value =
        explicit ?? process.env.POLLINATIONS_BASE_URL ?? DEFAULT_BASE_URL;
    const raw = String(value).trim() || DEFAULT_BASE_URL;
    return raw.replace(/\/+$/, "");
}

function toIdentity(profile) {
    const username =
        typeof profile?.githubUsername === "string" && profile.githubUsername
            ? profile.githubUsername
            : null;
    if (!username) return null;
    const email =
        typeof profile?.email === "string" && profile.email
            ? profile.email
            : `${username}@users.noreply.github.com`;
    return { username, email, source: "pollinations" };
}

function buildPricingMap(modelsJson) {
    const map = new Map();
    for (const model of modelsJson?.data ?? []) {
        if (!model?.pricing) continue;
        const names = [
            model.id,
            model.name,
            ...(Array.isArray(model.aliases) ? model.aliases : []),
        ];
        for (const name of names) {
            if (typeof name === "string" && name) map.set(name, model.pricing);
        }
    }
    return map;
}

/**
 * Create the BYOP metering proxy.
 *
 * @param {object} options
 * @param {string} options.apiKey - Pollinations API key (kept in memory only).
 * @param {number} [options.port] - Listen port (env AGENT_BYOP_PORT, default 8878; 0 = ephemeral).
 * @param {string} [options.baseUrl] - GEN base URL (env POLLINATIONS_BASE_URL).
 * @param {number} [options.maxPollenBudget] - Hard cap in Pollen (default 5).
 * @param {number} [options.reconcileMs] - Balance poll interval (default 15000; <= 0 disables the timer).
 * @param {string} [options.host] - Listen host (default "127.0.0.1").
 * @returns {Promise<{port:number, server:object, events:object, state:object,
 *     setBudget:Function, topUp:Function, identity:Function, ledger:Function,
 *     reconcileNow:Function, stop:Function}>}
 */
export async function createByopProxy(options = {}) {
    const apiKey = options.apiKey;
    if (!apiKey || typeof apiKey !== "string")
        throw new Error("createByopProxy: options.apiKey is required");
    const maxPollen =
        options.maxPollenBudget === undefined
            ? DEFAULT_MAX_POLLEN
            : Number(options.maxPollenBudget);
    if (!Number.isFinite(maxPollen) || maxPollen <= 0) {
        throw new Error(
            "createByopProxy: options.maxPollenBudget must be a positive number",
        );
    }
    const baseUrl = resolveBaseUrl(options.baseUrl);
    const port = resolvePort(options.port);
    const host = options.host ?? "127.0.0.1";
    const reconcileMs =
        options.reconcileMs === undefined
            ? DEFAULT_RECONCILE_MS
            : Number(options.reconcileMs);

    const events = new EventEmitter();
    const meter = createMeter({ maxPollen, events });
    let baseline = null;
    let pricing = { at: 0, map: new Map() };
    let reconcileQueue = Promise.resolve();

    // Proxy-internal GETs always carry the BYOP key; errors never leak it.
    const getJson = async (url) => {
        const response = await requestUpstream({
            baseUrl,
            method: "GET",
            url,
            authorization: `Bearer ${apiKey}`,
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`GET ${url} failed with status ${response.status}`);
        }
        return JSON.parse(response.body.toString("utf8"));
    };

    const refreshPricing = async () => {
        const map = buildPricingMap(await getJson("/v1/models"));
        pricing = { at: Date.now(), map };
    };

    /** Poll the live balance; adopt the larger of counted spend vs baseline drop. */
    const doReconcile = async () => {
        if (baseline === null) return { updated: false, state: meter.state };
        const json = await getJson("/account/balance");
        meter.reconcile(baseline, Number(json?.balance));
        return { updated: true, state: meter.state };
    };

    // Calls queue behind each other so a poll in flight never makes a manual
    // call return a stale read (tests rely on reconcileNow being fresh).
    const reconcileNow = () => {
        const run = reconcileQueue.then(doReconcile);
        reconcileQueue = run.then(
            () => {},
            () => {},
        );
        return run;
    };

    // Runs synchronously when an upstream metered body completes.
    const onMeteredBody = (buffer, info) => {
        if (info.status < 200 || info.status >= 300) return;
        if (Date.now() - pricing.at > PRICING_TTL_MS)
            refreshPricing().catch(() => {});
        const extracted = extractUsageAndModel(
            buffer,
            String(info.headers?.["content-type"] ?? ""),
        );
        let requestModel = null;
        try {
            requestModel =
                JSON.parse(info.requestBody.toString("utf8"))?.model ?? null;
        } catch {
            requestModel = null;
        }
        const model = extracted.model ?? requestModel;
        const cost = extracted.usage
            ? computeCost(extracted.usage, pricing.map.get(model))
            : null;
        if (cost !== null) meter.addCost(cost);
        meter.record({
            model,
            usage: extracted.usage,
            cost,
            mode: cost === null ? "reconcile" : "usage",
        });
    };

    const handle = async (req, res) => {
        res.on("error", () => {});
        const url = req.url ?? "/";
        if (req.method === "GET" && pathOnly(url) === "/internal/state") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                `${JSON.stringify({ ...meter.state, ledger: meter.lastEntries(LEDGER_WINDOW) })}\n`,
            );
            return;
        }
        if (meter.state.phase === "cutoff" && isMeteredPath(url)) {
            res.writeHead(402, { "content-type": "application/json" });
            res.end(`${JSON.stringify(insufficientPollen(meter.state))}\n`);
            return;
        }
        const metered = isMeteredPath(url);
        await pipeUpstream({
            baseUrl,
            req,
            res,
            authorization: metered ? `Bearer ${apiKey}` : undefined,
            onBody: metered ? onMeteredBody : undefined,
        });
    };

    const server = http.createServer((req, res) => {
        handle(req, res).catch(() => {
            if (res.headersSent) return res.destroy();
            res.writeHead(502, { "content-type": "application/json" });
            res.end(
                `${JSON.stringify({ error: { code: "upstream_unavailable", message: "BYOP proxy could not reach the upstream" } })}\n`,
            );
        });
    });

    const readIdentity = async () => {
        meter.state.identity = toIdentity(await getJson("/account/profile"));
    };
    const readBaseline = async () => {
        const balance = Number((await getJson("/account/balance"))?.balance);
        if (Number.isFinite(balance)) baseline = balance;
    };
    // Startup probes are fail-open: identity/balance/pricing failures never block boot.
    await Promise.allSettled([
        readIdentity(),
        readBaseline(),
        refreshPricing(),
    ]);

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });

    let timer = null;
    if (Number.isFinite(reconcileMs) && reconcileMs > 0) {
        timer = setInterval(() => reconcileNow().catch(() => {}), reconcileMs);
        timer.unref?.();
    }

    const stop = () =>
        new Promise((resolve) => {
            if (timer) clearInterval(timer);
            server.closeAllConnections?.();
            server.close(() => resolve());
        });

    return {
        port: server.address().port,
        server,
        events,
        state: meter.state,
        setBudget(next) {
            return meter.setBudget(next);
        },
        topUp(amount) {
            return meter.topUp(amount);
        },
        identity() {
            return meter.state.identity;
        },
        ledger() {
            return [...meter.ledger];
        },
        reconcileNow,
        stop,
    };
}

function insufficientPollen(state) {
    return {
        error: {
            code: "insufficient_pollen",
            message: `Pollen budget exhausted: ${state.spent} of ${state.maxPollen} Pollen spent. Raise the budget (topUp) to resume metered calls.`,
            spent: state.spent,
            maxPollen: state.maxPollen,
        },
    };
}
