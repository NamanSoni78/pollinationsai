/**
 * Per-sender spend gate and implicit-group policy for the Telegram channel.
 *
 * Every delivered message becomes a full Claude Code turn on the owner's box
 * key. Owners and allowlisted senders are trusted as before; other group
 * members (the "group member" role) are cooldown-limited per sender so a
 * mention storm cannot drain the box unattended.
 */

/** Default cooldown between delivered turns for a non-allowlisted member. */
export const GROUP_MEMBER_COOLDOWN_MS = 60_000;

export type SenderRole = "owner" | "allowed" | "group member";

/**
 * The fallback policy for a group the owner is in but that has no explicit
 * entry in access.json. Owner-only by default: any other member must be added
 * with `--allow` before their mentions reach the session.
 */
export function implicitGroupPolicy(
  ownerIds: Iterable<string>,
  groupRequireMention?: boolean,
): { requireMention: boolean; allowFrom: string[] } {
  return {
    requireMention: groupRequireMention ?? true,
    allowFrom: [...ownerIds],
  };
}

export type SpendGate = {
  /** Whether this sender's message may be delivered now. */
  allow(senderId: string, role: SenderRole, now?: number): boolean;
  /** Milliseconds until the sender's next message is deliverable (0 if now). */
  retryAfterMs(senderId: string, now?: number): number;
};

export function createSpendGate(
  cooldownMs = GROUP_MEMBER_COOLDOWN_MS,
): SpendGate {
  const lastDelivered = new Map<string, number>();
  const allow = (
    senderId: string,
    role: SenderRole,
    now?: number,
  ): boolean => {
    if (role !== "group member") return true;
    const at = now ?? Date.now();
    const last = lastDelivered.get(senderId);
    if (last !== undefined && at - last < cooldownMs) return false;
    lastDelivered.set(senderId, at);
    return true;
  };
  const retryAfterMs = (senderId: string, now?: number): number => {
    const at = now ?? Date.now();
    const last = lastDelivered.get(senderId);
    if (last === undefined) return 0;
    const remaining = cooldownMs - (at - last);
    return remaining > 0 ? remaining : 0;
  };
  return { allow, retryAfterMs };
}
