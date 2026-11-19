export interface LiveSmokeTestResult {
  url: string;
  http_status: number;
  passed: boolean;
  latency_ms: number;
  content_type: string;
  title?: string;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  verified_at: string;
}

/**
 * Live URL Smoke Test Verifier (Issue #20357 §5).
 * Runs after Cloudflare or EdgeOne deployment to verify HTTP 200, valid rendered HTML/JSON,
 * and zero runtime error markers prior to Warden sign-off.
 */
export async function verifyLiveDeployment(
  url: string,
  options?: { fetchImpl?: typeof fetch; expectedSubstring?: string },
): Promise<LiveSmokeTestResult> {
  const fetchFn = options?.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

  try {
    const res = await fetchFn(url, { redirect: "follow" });
    const latency_ms = Date.now() - startedAt;
    const contentType = res.headers.get("content-type") ?? "unknown";
    const body = await res.text();

    const httpOk = res.status === 200;
    checks.push({
      name: "http_200",
      passed: httpOk,
      detail: `Returned HTTP ${res.status} in ${latency_ms}ms`,
    });

    const nonEmpty = body.trim().length > 0;
    checks.push({
      name: "non_empty_body",
      passed: nonEmpty,
      detail: `Payload length ${body.length} bytes (${contentType})`,
    });

    const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim();

    const noCrashBanner = !/Internal Server Error|Application error: a client-side exception|Error 1101/i.test(
      body,
    );
    checks.push({
      name: "no_error_page",
      passed: noCrashBanner,
      detail: noCrashBanner
        ? "No Cloudflare/EdgeOne runtime crash markers detected"
        : "Detected server/runtime error marker in rendered response",
    });

    if (options?.expectedSubstring) {
      const hasExpected = body.includes(options.expectedSubstring);
      checks.push({
        name: "expected_content",
        passed: hasExpected,
        detail: hasExpected
          ? `Matched expected content "${options.expectedSubstring}"`
          : `Missing expected content "${options.expectedSubstring}"`,
      });
    }

    return {
      url,
      http_status: res.status,
      passed: checks.every((c) => c.passed),
      latency_ms,
      content_type: contentType,
      title,
      checks,
      verified_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      url,
      http_status: 0,
      passed: false,
      latency_ms: Date.now() - startedAt,
      content_type: "unreachable",
      checks: [
        {
          name: "http_200",
          passed: false,
          detail: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      verified_at: new Date().toISOString(),
    };
  }
}
