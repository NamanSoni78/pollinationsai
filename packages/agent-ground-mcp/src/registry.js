const STATUSES = [
    "booting",
    "idle",
    "working",
    "closed_loop_running",
    "waiting_event",
    "budget_paused",
];

const REQUIRED_STRINGS = ["agent_id", "owner_pollinations_id", "role"];
const OPTIONAL_STRINGS = [
    "current_goal",
    "preview_url",
    "last_summary",
    "workspace",
];
const ARRAY_FIELDS = ["stack", "owned_paths", "published_artifacts"];

function badRequest(message) {
    const err = new Error(message);
    err.status = 400;
    err.code = "invalid_agent_card";
    return err;
}

function cloneCard(card) {
    return {
        agent_id: card.agent_id,
        owner_pollinations_id: card.owner_pollinations_id,
        role: card.role,
        current_goal: card.current_goal,
        status: card.status,
        stack: [...card.stack],
        owned_paths: [...card.owned_paths],
        published_artifacts: [...card.published_artifacts],
        preview_url: card.preview_url,
        last_summary: card.last_summary,
        workspace: card.workspace,
    };
}

/**
 * Validate + normalise an AgentCard per master spec 2.5.
 * Missing optional fields are filled with defaults; violations throw a 400 error.
 *
 * @param {object} card - raw card
 * @returns {object} normalised card
 */
export function validateCard(card) {
    if (!card || typeof card !== "object" || Array.isArray(card)) {
        throw badRequest("agent card must be an object");
    }
    for (const field of REQUIRED_STRINGS) {
        if (typeof card[field] !== "string" || card[field].trim() === "") {
            throw badRequest(
                `${field} is required and must be a non-empty string`,
            );
        }
    }
    const status = card.status ?? "booting";
    if (!STATUSES.includes(status)) {
        throw badRequest(`status must be one of: ${STATUSES.join(", ")}`);
    }
    for (const field of ARRAY_FIELDS) {
        if (
            card[field] !== undefined &&
            card[field] !== null &&
            !Array.isArray(card[field])
        ) {
            throw badRequest(`${field} must be an array`);
        }
    }
    for (const field of OPTIONAL_STRINGS) {
        if (
            card[field] !== undefined &&
            card[field] !== null &&
            typeof card[field] !== "string"
        ) {
            throw badRequest(`${field} must be a string`);
        }
    }
    return {
        agent_id: card.agent_id,
        owner_pollinations_id: card.owner_pollinations_id,
        role: card.role,
        current_goal: card.current_goal ?? "",
        status,
        stack: [...(card.stack ?? [])],
        owned_paths: [...(card.owned_paths ?? [])],
        published_artifacts: [...(card.published_artifacts ?? [])],
        preview_url: card.preview_url ?? "",
        last_summary: card.last_summary ?? "",
        workspace: card.workspace ?? "",
    };
}

/**
 * In-memory agent registry keyed by `agent_id`.
 * Cards are validated + normalised on write (spec 2.5) and returned as copies.
 *
 * @returns {{register, get, update, list, load, toJSON}} registry API
 */
export function createRegistry() {
    /** @type {Map<string, object>} */
    const cards = new Map();

    function register(card) {
        const normalized = validateCard(card);
        cards.set(normalized.agent_id, normalized);
        return cloneCard(normalized);
    }

    function get(id) {
        const card = cards.get(id);
        return card ? cloneCard(card) : null;
    }

    function update(id, patch) {
        const existing = cards.get(id);
        if (!existing) {
            const err = new Error(`unknown agent: ${id}`);
            err.status = 404;
            err.code = "unknown_agent";
            throw err;
        }
        const merged = validateCard({
            ...cloneCard(existing),
            ...(patch ?? {}),
            agent_id: id,
        });
        cards.set(id, merged);
        return cloneCard(merged);
    }

    function list(filter = {}) {
        let all = [...cards.values()].map(cloneCard);
        if (filter.status) all = all.filter((c) => c.status === filter.status);
        if (filter.role) all = all.filter((c) => c.role === filter.role);
        if (filter.owner_pollinations_id) {
            all = all.filter(
                (c) => c.owner_pollinations_id === filter.owner_pollinations_id,
            );
        }
        return all;
    }

    function load(agents = []) {
        cards.clear();
        for (const agent of agents) {
            const normalized = validateCard(agent);
            cards.set(normalized.agent_id, normalized);
        }
    }

    function toJSON() {
        return [...cards.values()].map(cloneCard);
    }

    return { register, get, update, list, load, toJSON };
}
