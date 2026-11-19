/**
 * Out-of-Band Credential Vault for Publish MCP (Issue #20357 §5).
 * Holds Cloudflare & EdgeOne deployment secrets strictly outside LLM prompts,
 * tool outputs, error messages, and Git working trees.
 */
export interface PublishCredentials {
  cloudflareApiToken?: string;
  cloudflareAccountId?: string;
  edgeoneApiToken?: string;
  edgeoneZoneId?: string;
}

export class OutOfBandSecretVault {
  private readonly secrets: PublishCredentials;

  constructor(creds?: PublishCredentials) {
    this.secrets = {
      cloudflareApiToken: creds?.cloudflareApiToken ?? process.env.CLOUDFLARE_API_TOKEN,
      cloudflareAccountId: creds?.cloudflareAccountId ?? process.env.CLOUDFLARE_ACCOUNT_ID,
      edgeoneApiToken: creds?.edgeoneApiToken ?? process.env.EDGEONE_API_TOKEN,
      edgeoneZoneId: creds?.edgeoneZoneId ?? process.env.EDGEONE_ZONE_ID,
    };
  }

  getCloudflareAuth(): { apiToken?: string; accountId?: string; configured: boolean } {
    return {
      apiToken: this.secrets.cloudflareApiToken,
      accountId: this.secrets.cloudflareAccountId,
      configured: Boolean(this.secrets.cloudflareApiToken && this.secrets.cloudflareAccountId),
    };
  }

  getEdgeOneAuth(): { apiToken?: string; zoneId?: string; configured: boolean } {
    return {
      apiToken: this.secrets.edgeoneApiToken,
      zoneId: this.secrets.edgeoneZoneId,
      configured: Boolean(this.secrets.edgeoneApiToken),
    };
  }

  /**
   * Public status safe for UI and LLM telemetry (never reveals token material).
   */
  getSafeStatus(): {
    cloudflare_configured: boolean;
    edgeone_configured: boolean;
    credential_mode: "out_of_band_env";
  } {
    return {
      cloudflare_configured: Boolean(
        this.secrets.cloudflareApiToken && this.secrets.cloudflareAccountId,
      ),
      edgeone_configured: Boolean(this.secrets.edgeoneApiToken),
      credential_mode: "out_of_band_env",
    };
  }

  /**
   * Redacts any accidental occurrence of known secrets from logs or error messages.
   */
  redact(text: string): string {
    let safe = text;
    for (const val of Object.values(this.secrets)) {
      if (val && val.length >= 6) {
        safe = safe.split(val).join("[REDACTED_OOB_SECRET]");
      }
    }
    return safe;
  }
}
