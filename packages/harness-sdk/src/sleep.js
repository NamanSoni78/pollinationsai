/**
 * Event-aware sleep for autonomous agents: pure timers plus event wakes via
 * an EventEmitter and/or a registry Map, so ground events can interrupt a
 * waiting agent without polling.
 */

/** until_event alias → event name. */
export const EVENT_MAP = {
    ground_artifact: "ground.artifact",
    ground_reply: "ground.reply",
    process_exit: "process.exit",
};

const DEFAULT_MAX_WAIT_SEC = 3600;

/**
 * Sleep until a timer, a wake event, or the max wait — whichever comes first.
 *
 * @param {{seconds?: number, until_event?: "ground_artifact"|"ground_reply"|"process_exit",
 *   max_wait_sec?: number}} [options] timer mode uses `seconds`; event mode
 *   waits for the mapped event up to `max_wait_sec` (fallback: `seconds`,
 *   then 3600)
 * @param {{emitter?: object|null, registry?: Map<string, Set<Function>>|null}} [wires]
 * @returns {Promise<{wake_reason: "timer"|"event"|"max_wait", event_payload?: object}>}
 *   rejects on an unknown `until_event`
 */
export function sleepVia(
    { seconds, until_event, max_wait_sec } = {},
    { emitter = null, registry = null } = {},
) {
    const eventName =
        until_event === undefined ? null : (EVENT_MAP[until_event] ?? null);
    if (until_event !== undefined && !eventName) {
        return Promise.reject(new Error(`unknown until_event: ${until_event}`));
    }
    return new Promise((resolve) => {
        let timer = null;
        let waker = null;
        let settled = false;
        const finish = (wakeReason, payload) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (emitter && waker) emitter.removeListener(eventName, waker);
            if (registry && waker) {
                const waiting = registry.get(eventName);
                if (waiting) {
                    waiting.delete(waker);
                    if (!waiting.size) registry.delete(eventName);
                }
            }
            resolve(
                payload === undefined
                    ? { wake_reason: wakeReason }
                    : { wake_reason: wakeReason, event_payload: payload },
            );
        };
        if (!eventName) {
            timer = setTimeout(
                () => finish("timer"),
                Math.max(0, seconds ?? 0) * 1000,
            );
            return;
        }
        const deadlineMs = Math.max(
            0,
            (max_wait_sec ?? seconds ?? DEFAULT_MAX_WAIT_SEC) * 1000,
        );
        waker = (payload) => finish("event", payload);
        if (registry) {
            if (!registry.has(eventName)) registry.set(eventName, new Set());
            registry.get(eventName).add(waker);
        }
        if (emitter) emitter.once(eventName, waker);
        timer = setTimeout(() => finish("max_wait"), deadlineMs);
    });
}

/**
 * Wake every sleeper registered for an event name (e.g. "ground.artifact").
 *
 * @param {Map<string, Set<Function>>} registry from sleepVia wires
 * @param {string} eventName mapped event name
 * @param {object} payload delivered as `event_payload`
 * @returns {number} how many sleepers were woken
 */
export function wakeSleepers(registry, eventName, payload) {
    const waiting = registry?.get(eventName);
    if (!waiting?.size) return 0;
    const wakers = [...waiting];
    waiting.clear();
    registry.delete(eventName);
    for (const waker of wakers) waker(payload);
    return wakers.length;
}
