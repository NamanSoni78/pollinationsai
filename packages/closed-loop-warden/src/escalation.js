// Double-reject escalation: when the same requirement FAILED twice
// consecutively, an expert consult packet is injected at the top of the
// work queue (the auto consult_expert step of the spec).

/**
 * Decide whether `reqId` must be escalated to an expert consult, and build
 * the packet that gets injected at the queue top.
 *
 * @param {Record<string, number>} rejectedCount consecutive FAIL counts per req_id
 * @param {string} reqId
 * @param {{summary?: string, results?: Array<{req_id: string, defect?: string}>, required_actions?: Array<{req_id: string, action: string}>}=} verdict
 * @returns {{escalate: boolean, packet: null | {req_id: string, defect: string | null, required_actions: string[], critique: string}}}
 */
export function escalateOnDoubleReject(rejectedCount, reqId, verdict) {
    const count = rejectedCount?.[reqId] ?? 0;
    if (count < 2) {
        return { escalate: false, packet: null };
    }
    const results = Array.isArray(verdict?.results) ? verdict.results : [];
    const actions = Array.isArray(verdict?.required_actions)
        ? verdict.required_actions
        : [];
    const result = results.find((r) => r?.req_id === reqId);
    return {
        escalate: true,
        packet: {
            req_id: reqId,
            defect: result?.defect ?? null,
            required_actions: actions
                .filter((a) => a?.req_id === reqId)
                .map((a) => a.action),
            critique: verdict?.summary ?? "",
        },
    };
}
