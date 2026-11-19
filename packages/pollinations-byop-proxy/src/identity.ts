import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PollinationsIdentity } from "./types";

const execFileAsync = promisify(execFile);

export const DEFAULT_POLLINATIONS_BASE_URL = "https://gen.pollinations.ai";
export const POLLINATIONS_OAUTH_DISCOVERY =
  "https://enter.pollinations.ai/.well-known/oauth-authorization-server";

interface RawProfileResponse {
  id?: string;
  githubUsername?: string;
  username?: string;
  name?: string;
  email?: string;
  image?: string;
}

interface RawBalanceResponse {
  balance?: number;
}

/**
 * Resolves the canonical Pollinations identity from a scoped BYOP key (`sk_...`).
 * Propagates Pollinations profile/GitHub handle into a canonical Git-safe email.
 */
export async function resolvePollinationsIdentity(
  apiKey: string,
  options?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<PollinationsIdentity> {
  if (!apiKey || !apiKey.trim()) {
    throw new Error("A Pollinations BYOP API key is required to resolve identity.");
  }

  const baseUrl = (options?.baseUrl ?? DEFAULT_POLLINATIONS_BASE_URL).replace(/\/+$/, "");
  const fetchFn = options?.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${apiKey.trim()}` };

  const [profileRes, balanceRes] = await Promise.all([
    fetchFn(`${baseUrl}/account/profile`, { headers }),
    fetchFn(`${baseUrl}/account/balance`, { headers }),
  ]);

  if (!profileRes.ok) {
    throw new Error(
      `Pollinations profile lookup failed (HTTP ${profileRes.status}): verify your BYOP token.`,
    );
  }

  const profile = (await profileRes.json()) as RawProfileResponse;
  const balanceData = balanceRes.ok
    ? ((await balanceRes.json()) as RawBalanceResponse)
    : { balance: 0 };

  const githubUsername =
    profile.githubUsername ?? profile.username ?? profile.name ?? "pollinations-user";
  const canonicalEmail =
    profile.email ?? `${githubUsername}@users.noreply.pollinations.ai`;

  return {
    userId: profile.id ?? `polli:${githubUsername}`,
    githubUsername,
    displayName: profile.name ?? githubUsername,
    email: canonicalEmail,
    avatarUrl: profile.image,
    balancePollen: Number(balanceData.balance ?? 0),
    authenticatedAt: new Date().toISOString(),
    authMode: "pollinations_byop",
  };
}

/**
 * Configures local VM Git identity (`user.name` and `user.email`) from the
 * authenticated Pollinations profile so every autonomous commit carries real provenance.
 */
export async function applyIdentityToGitRepo(
  repoPath: string,
  identity: PollinationsIdentity,
): Promise<{ userName: string; userEmail: string }> {
  const userName = identity.displayName || identity.githubUsername;
  const userEmail = identity.email;

  await execFileAsync("git", ["config", "user.name", userName], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", userEmail], { cwd: repoPath });

  return { userName, userEmail };
}

/**
 * Builds PKCE OAuth authorization URL parameters for "Continue with Pollinations" web flow.
 */
export function buildPollinationsConnectUrl(params: {
  redirectUri: string;
  appKey?: string;
  budget?: number;
  expiryDays?: number;
  permissions?: string[];
  state: string;
  codeChallenge?: string;
}): string {
  const url = new URL("https://enter.pollinations.ai/authorize");
  url.searchParams.set("redirect_uri", params.redirectUri);
  if (params.appKey) url.searchParams.set("client_id", params.appKey);
  if (params.budget !== undefined) url.searchParams.set("budget", String(params.budget));
  if (params.expiryDays !== undefined) url.searchParams.set("expiry", String(params.expiryDays));
  if (params.permissions?.length) {
    url.searchParams.set("permissions", params.permissions.join(","));
  }
  url.searchParams.set("state", params.state);
  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}
