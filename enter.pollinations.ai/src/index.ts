import { handleError } from "@shared/error.ts";
import { requestId } from "@shared/middleware/request-id.ts";
import { getPublicOrigin } from "@shared/public-origin.ts";
import { rateLimit } from "@shared/rate-limit.ts";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { api } from "./api.ts";
import type { Env } from "./env.ts";
import { logger } from "./middleware/logger.ts";
import { createDocsRoutes } from "./routes/docs.ts";
import {
    LEADERBOARD_SLICE_PAUSE_MS,
    refreshQuestLeaderboard,
} from "./routes/quest-leaderboard.ts";
import { getCurrentGenOrigin, wellKnownRoutes } from "./routes/well-known.ts";
import { handleCodeAgentOutbound } from "./services/code-agent-outbound.ts";

function stripTrailingSlash(path: string): string {
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isApiDocsPath(path: string): boolean {
    return path === "/api/docs" || path.startsWith("/api/docs/");
}

function redirectLegacyDocs(c: Context<Env>): Response {
    const reqUrl = new URL(c.req.url);
    const publicOrigin = new URL(getPublicOrigin(c));
    const url = new URL(reqUrl.pathname + reqUrl.search, publicOrigin);
    url.hostname = url.hostname.replace(/(^|\.)enter\./, "$1gen.");
    url.protocol = "https:";
    url.pathname = url.pathname.replace(/^\/api\/docs(?=\/|$)/, "/docs");
    url.pathname = stripTrailingSlash(url.pathname);
    return c.redirect(url.toString(), 301);
}

const API_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Enter-wide request-body ceiling. Every route that consumes a request body
 * on this control plane read it unbounded before this gate: the Stripe and
 * GitHub webhook handlers buffer the whole raw body before the signature
 * check can reject it, the public OAuth/device token endpoints parse form or
 * JSON bodies of any size, and the account/auth JSON routes run
 * validator("json") ahead of their 401s. 8 MiB is the MCP-gateway body cap
 * precedent with headroom over the 5 MiB inline site deploy (the largest
 * legitimate enter body — site file bytes go directly to Cloudflare, never
 * through this worker).
 */
const apiBodyLimit = bodyLimit({
    maxSize: API_BODY_LIMIT_BYTES,
    onError: () => {
        throw new HTTPException(413, {
            message: `Request bodies on this API can be at most 8 MiB.`,
        });
    },
});

const app = new Hono<Env>()
    .use(
        "*",
        cors({
            origin: "*",
            allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allowHeaders: [],
            exposeHeaders: ["Content-Length", "Content-Disposition"],
            maxAge: 600,
        }),
    )
    .use("*", requestId())
    .use("*", logger)
    // Prevent search engines from indexing API responses (except docs)
    .use("/api/*", async (c, next) => {
        await next();
        if (!isApiDocsPath(c.req.path)) {
            c.header("X-Robots-Tag", "noindex, nofollow");
        }
    })
    // Bound request bodies before any handler — or limiter — can buffer
    // them (webhooks read the raw body before signature verification).
    .use("/api/*", apiBodyLimit)
    .use("/api/*", rateLimit({ byIp: false }))
    .route("/api/docs", createDocsRoutes(api))
    .all("/api/docs", redirectLegacyDocs)
    .all("/api/docs/", redirectLegacyDocs)
    .all("/api/docs/*", redirectLegacyDocs)
    .all("/api/generate/*", (c) => {
        const reqUrl = new URL(c.req.url);
        const publicOrigin = new URL(getPublicOrigin(c));
        const url = new URL(reqUrl.pathname + reqUrl.search, publicOrigin);
        url.hostname = url.hostname.replace(/(^|\.)enter\./, "$1gen.");
        url.protocol = "https:";
        url.pathname = url.pathname.replace(/^\/api\/generate/, "");
        c.header("Deprecation", "true");
        c.header(
            "Link",
            `<${getCurrentGenOrigin(c)}>; rel="successor-version"`,
        );
        return c.redirect(url.toString(), 308);
    })
    .route("/.well-known", wellKnownRoutes)
    .route("/api", api);

app.notFound(async (c: Context<Env>) => {
    return await handleError(new HTTPException(404), c);
});

app.onError(handleError);

export default {
    fetch(request, env, ctx) {
        if (env.CODE_AGENT_CONTEXT) {
            return handleCodeAgentOutbound(request, env.CODE_AGENT_CONTEXT);
        }
        return app.fetch(request, env, ctx);
    },
    // Every 15 minutes (wrangler.toml).
    async scheduled(_controller, env) {
        await refreshQuestLeaderboard(env, LEADERBOARD_SLICE_PAUSE_MS);
    },
} satisfies ExportedHandler<Env["Bindings"]>;
