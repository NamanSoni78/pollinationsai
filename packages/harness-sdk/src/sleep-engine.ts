import type { AgentGroundHub } from "../../agent-ground-mcp/src/index";

export interface SleepParams {
  seconds?: number;
  until_event?: "ground_artifact" | "ground_reply" | "process_exit";
  max_wait_sec: number;
  processPromise?: Promise<unknown>;
  signal?: AbortSignal;
}

export interface SleepResult {
  wake_reason: string;
  waited_ms: number;
  llm_tokens_burned: 0;
  event_payload?: unknown;
}

/**
 * Non-blocking Async Wait primitive (`sleep` — Issue #20357 §3.B.5).
 * Waits cleanly for timers, background process exits, or Agent Ground events
 * (`ground_artifact`, `ground_reply`) without burning any LLM tokens.
 */
export async function sleepUntil(
  params: SleepParams,
  context?: { hub?: AgentGroundHub; agentId?: string },
): Promise<SleepResult> {
  const startedAt = Date.now();
  const maxWaitMs = Math.max(10, Math.min(params.max_wait_sec * 1000, 86_400_000));

  if (params.until_event === "process_exit" && params.processPromise) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const winner = await Promise.race([
        params.processPromise.then((payload) => ({ wake_reason: "process_exit", event_payload: payload })),
        new Promise<{ wake_reason: string; event_payload?: unknown }>((resolve) => {
          timer = setTimeout(() => resolve({ wake_reason: "max_wait_timeout" }), maxWaitMs);
        }),
      ]);
      return {
        ...winner,
        waited_ms: Date.now() - startedAt,
        llm_tokens_burned: 0,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (
    (params.until_event === "ground_artifact" || params.until_event === "ground_reply") &&
    context?.hub &&
    context.agentId
  ) {
    const res = await context.hub.waitForEvent({
      agentId: context.agentId,
      eventType: params.until_event,
      maxWaitMs,
      signal: params.signal,
    });
    return {
      wake_reason: res.wake_reason,
      event_payload: res.event_payload,
      waited_ms: Date.now() - startedAt,
      llm_tokens_burned: 0,
    };
  }

  const waitMs = Math.min((params.seconds ?? params.max_wait_sec) * 1000, maxWaitMs);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    params.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

  return {
    wake_reason: params.signal?.aborted ? "aborted" : "timer_elapsed",
    waited_ms: Date.now() - startedAt,
    llm_tokens_burned: 0,
  };
}
