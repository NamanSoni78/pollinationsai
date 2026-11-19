/**
 * Deployment URL verification.
 *
 * Zero-dependency: uses the global fetch available in Node >= 20.
 */

/** @typedef {{ok: boolean, status: number | "error", checkedAt: string, error?: string}} VerifyResult */

/**
 * Verify a deployed URL with an HTTP GET.
 * Any 2xx response counts as a live deployment; anything else (non-2xx
 * status or a network failure) is reported as not ok, never thrown.
 *
 * @param {string} url - Absolute URL of the deployment to check.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 *     fetchImpl (tests) and timeoutMs (default 15000) are optional.
 * @returns {Promise<VerifyResult>} `{ok, status, checkedAt}` where status is
 *     the HTTP status code or the literal "error" when the request failed.
 */
export async function verifyDeployment(
    url,
    { fetchImpl = fetch, timeoutMs = 15000 } = {},
) {
    const checkedAt = new Date().toISOString();
    try {
        const response = await fetchImpl(url, {
            method: "GET",
            redirect: "follow",
            signal: AbortSignal.timeout(timeoutMs),
        });
        return {
            ok: response.status >= 200 && response.status <= 299,
            status: response.status,
            checkedAt,
        };
    } catch (error) {
        return {
            ok: false,
            status: "error",
            checkedAt,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
