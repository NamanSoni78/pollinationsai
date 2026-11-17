export type UserMediaUrlValidation =
    | { ok: true; url: URL }
    | { ok: false; reason: "invalid" | "protocol" | "private" };

const BLOCKED_HOSTNAMES = /^localhost$/i;

/** Hop budget for user-media redirects: three covers every shortener/CDN chain in practice. */
export const MAX_USER_MEDIA_REDIRECTS = 3;

/**
 * A redirect hop whose destination failed the URL policy. Callers map this to
 * their own error contract; the refused destination is on `target`.
 */
export class UserMediaRedirectError extends Error {
    readonly target: URL;
    readonly reason: "invalid" | "protocol" | "private";

    constructor(target: URL, reason: "invalid" | "protocol" | "private") {
        super(
            `Media URL redirects to ${target.toString()}, which is not an allowed media destination.`,
        );
        this.name = "UserMediaRedirectError";
        this.target = target;
        this.reason = reason;
    }
}

/**
 * A redirect chain that exceeded the hop budget. Distinct from
 * {@link UserMediaRedirectError} so callers can report "too many redirects"
 * rather than implying the destination was refused.
 */
export class UserMediaTooManyRedirectsError extends Error {
    constructor() {
        super(
            `Media URL redirects more than ${MAX_USER_MEDIA_REDIRECTS} times.`,
        );
        this.name = "UserMediaTooManyRedirectsError";
    }
}

function isBlockedUserMediaHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, "");
    const normalized = host.toLowerCase();
    if (
        BLOCKED_HOSTNAMES.test(normalized) ||
        normalized.endsWith(".localhost")
    ) {
        return true;
    }

    if (normalized.includes(":")) return true;

    const parts = normalized.split(".").map(Number);
    return (
        parts.length === 4 &&
        parts.every(
            (part) => Number.isInteger(part) && part >= 0 && part <= 255,
        )
    );
}

/**
 * Apply the same URL policy to every user-supplied media fetch: HTTP(S) only,
 * with credentialed hosts, loopback names, and literal IP addresses refused.
 */
export function validateUserMediaUrl(value: string): UserMediaUrlValidation {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return { ok: false, reason: "invalid" };
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, reason: "protocol" };
    }

    if (url.username || url.password || isBlockedUserMediaHost(url.hostname)) {
        return { ok: false, reason: "private" };
    }

    return { ok: true, url };
}

/**
 * Fetch a user-supplied media URL, following redirects manually and applying
 * the URL policy to every hop.
 *
 * The runtime default (`redirect: "follow"`) would let a public host bounce
 * the worker's fetch to exactly the destinations this policy exists to refuse
 * (loopback, private ranges, literal IPs, credentialed URLs). Following
 * manually and re-validating each `Location` keeps shorteners and CDN
 * redirects working — the reason these paths follow at all — without opening
 * that hole. Callers still receive the terminal response, including non-2xx
 * statuses, so their existing status handling is unchanged.
 */
export async function fetchValidatedUserMedia(
    url: URL,
    init: {
        headers?: Record<string, string>;
        signal?: AbortSignal;
    } = {},
): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_USER_MEDIA_REDIRECTS; hop += 1) {
        const response = await fetch(current, {
            redirect: "manual",
            ...(init.headers ? { headers: init.headers } : {}),
            ...(init.signal ? { signal: init.signal } : {}),
        });
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.get("location");
        // A 3xx without a location is the server's answer; surface it as-is.
        if (!location) return response;
        let next: URL;
        try {
            next = new URL(location, current);
        } catch {
            return response;
        }
        const validation = validateUserMediaUrl(next.toString());
        if (!validation.ok) {
            throw new UserMediaRedirectError(next, validation.reason);
        }
        current = validation.url;
    }
    throw new UserMediaTooManyRedirectsError();
}
