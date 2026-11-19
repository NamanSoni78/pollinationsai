import crypto from "node:crypto";

function badRequest(message, code = "invalid_input") {
    const err = new Error(message);
    err.status = 400;
    err.code = code;
    return err;
}

function matchesSubscription(subscription, artifact) {
    const byKey =
        Array.isArray(subscription.artifact_keys) &&
        subscription.artifact_keys.includes(artifact.key);
    const byPublisher =
        Array.isArray(subscription.agent_ids) &&
        subscription.agent_ids.includes(artifact.publisher);
    return Boolean(byKey || byPublisher);
}

/**
 * Versioned artifact blackboard + subscriptions.
 * Artifacts are immutable per (key, version); versions auto-increment when omitted.
 *
 * @returns {{publish, fetch, subscribe, list, all, subscriptionsList, load, toJSON}} blackboard API
 */
export function createBlackboard() {
    /** @type {Map<string, object[]>} key -> artifacts sorted by version */
    const artifacts = new Map();
    /** @type {object[]} */
    let subscriptions = [];

    function publish({
        key,
        version,
        content_type = "application/json",
        payload,
        changelog = "",
        publisher = "unknown",
    }) {
        if (typeof key !== "string" || key.trim() === "") {
            throw badRequest("artifact key is required", "invalid_artifact");
        }
        if (
            version !== undefined &&
            (!Number.isInteger(version) || version < 1)
        ) {
            throw badRequest(
                "version must be a positive integer",
                "invalid_artifact",
            );
        }
        const existing = artifacts.get(key) ?? [];
        const nextVersion =
            version ??
            (existing.length > 0
                ? existing[existing.length - 1].version + 1
                : 1);
        if (existing.some((a) => a.version === nextVersion)) {
            const err = new Error(
                `artifact ${key}@${nextVersion} already exists (immutable per key+version)`,
            );
            err.status = 409;
            err.code = "artifact_exists";
            throw err;
        }
        const artifact = {
            key,
            version: nextVersion,
            content_type,
            payload: payload ?? null,
            changelog,
            publisher,
            at: new Date().toISOString(),
        };
        existing.push(artifact);
        existing.sort((a, b) => a.version - b.version);
        artifacts.set(key, existing);
        return {
            artifact,
            subscribers: subscriptions.filter((s) =>
                matchesSubscription(s, artifact),
            ),
        };
    }

    function fetch(key, version) {
        if (typeof key !== "string") return null;
        const versions = artifacts.get(key);
        if (!versions || versions.length === 0) return null;
        if (version === undefined || version === null) {
            return { ...versions[versions.length - 1] };
        }
        const found = versions.find((a) => a.version === version);
        return found ? { ...found } : null;
    }

    function subscribe({ agent_id, artifact_keys, agent_ids } = {}) {
        if (typeof agent_id !== "string" || agent_id.trim() === "") {
            throw badRequest("agent_id is required", "invalid_subscription");
        }
        if (artifact_keys !== undefined && !Array.isArray(artifact_keys)) {
            throw badRequest(
                "artifact_keys must be an array",
                "invalid_subscription",
            );
        }
        if (agent_ids !== undefined && !Array.isArray(agent_ids)) {
            throw badRequest(
                "agent_ids must be an array",
                "invalid_subscription",
            );
        }
        const subscription = {
            subscription_id: crypto.randomUUID(),
            agent_id,
            ...(artifact_keys ? { artifact_keys: [...artifact_keys] } : {}),
            ...(agent_ids ? { agent_ids: [...agent_ids] } : {}),
        };
        subscriptions.push(subscription);
        return { ...subscription };
    }

    /** Metadata-only view (no payloads) for /api/session. */
    function list() {
        return [...artifacts.values()].map((versions) => ({
            key: versions[0].key,
            versions: versions.map(
                ({ version, content_type, changelog, publisher, at }) => ({
                    version,
                    content_type,
                    changelog,
                    publisher,
                    at,
                }),
            ),
        }));
    }

    /** Flat view with payloads for /api/artifacts. */
    function all() {
        return [...artifacts.values()].flat().map((a) => ({ ...a }));
    }

    function subscriptionsList() {
        return subscriptions.map((s) => ({ ...s }));
    }

    function load(serializedArtifacts = {}, serializedSubscriptions = []) {
        artifacts.clear();
        for (const [key, versions] of Object.entries(serializedArtifacts)) {
            if (!Array.isArray(versions)) continue;
            const restored = versions
                .filter((a) => a && Number.isInteger(a.version))
                .map((a) => ({ ...a }))
                .sort((a, b) => a.version - b.version);
            if (restored.length > 0) artifacts.set(key, restored);
        }
        subscriptions = serializedSubscriptions
            .filter(
                (s) =>
                    s &&
                    typeof s.subscription_id === "string" &&
                    typeof s.agent_id === "string",
            )
            .map((s) => ({ ...s }));
    }

    function toJSON() {
        return {
            artifacts: Object.fromEntries(artifacts),
            subscriptions: [...subscriptions],
        };
    }

    return {
        publish,
        fetch,
        subscribe,
        list,
        all,
        subscriptionsList,
        load,
        toJSON,
    };
}
