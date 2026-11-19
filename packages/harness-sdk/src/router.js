/**
 * Role router: maps agent roles to models (alias map, env overridable via
 * INDEXER_MODEL / WORKER_MODEL / RAG_MODEL / SUBAGENT_MODEL / EXPERT_MODEL /
 * WARDEN_MODEL) and resolves the git identity used for workspace commits.
 */

/** Quest-eligible defaults (spec §2.1). */
export const DEFAULT_ROLE_MODELS = {
    INDEXER: "openai/gpt-5.4-nano",
    SUBAGENT: "openai/gpt-5.4-nano",
    RAG: "openai/gpt-5.4-nano",
    WORKER: "openai/gpt-6-sol",
    EXPERT: "openai/gpt-6.1-sol",
    WARDEN: "openai/gpt-6.1-terra",
};

/**
 * Build a role router.
 *
 * @param {{env?: object}} [options] env source (defaults to process.env)
 * @returns {{defaults: Record<string, string>, resolve(role: string): {role: string, model: string}}}
 *   unknown roles fall back to the WORKER model
 */
export function roleRouter({ env = process.env } = {}) {
    const defaults = Object.fromEntries(
        Object.entries(DEFAULT_ROLE_MODELS).map(([role, model]) => [
            role,
            env[`${role}_MODEL`] ?? model,
        ]),
    );
    return {
        defaults,
        resolve(role) {
            const key = String(role ?? "WORKER").toUpperCase();
            return { role: key, model: defaults[key] ?? defaults.WORKER };
        },
    };
}

/**
 * Git identity from a Pollinations profile (spec §2.4): name is the GitHub
 * username, email falls back to the GitHub noreply form.
 *
 * @param {{githubUsername?: string, email?: string}} profile
 * @returns {{name: string, email: string}}
 */
export function resolveGitIdentity(profile = {}) {
    const username =
        profile?.githubUsername ?? profile?.username ?? "agent-ground";
    return {
        name: username,
        email: profile?.email ?? `${username}@users.noreply.github.com`,
    };
}
