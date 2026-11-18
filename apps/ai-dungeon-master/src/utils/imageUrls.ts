/**
 * Image URL helpers that keep the API key out of image URLs.
 *
 * The key goes in the Authorization header, never the URL, so it stays out of
 * the page, saved games and access logs — the same fix the platform applied
 * to catgpt (#18754). Display uses short-lived blob: object URLs; only an
 * uploaded media.pollinations.ai URL is a lasting reference worth saving.
 */

export type ImageUrlOptions = {
    width: number;
    height: number;
    seed?: string | number;
};

/** Build a generation image URL that carries no credential. */
export function buildImageUrl(
    prompt: string,
    { width, height, seed }: ImageUrlOptions,
): string {
    const url = new URL("https://gen.pollinations.ai/image/");
    url.pathname += encodeURIComponent(prompt);
    url.searchParams.set("width", String(width));
    url.searchParams.set("height", String(height));
    url.searchParams.set("model", "flux");
    if (seed !== undefined) url.searchParams.set("seed", String(seed));
    return url.toString();
}

/** True when a URL embeds an API key in its query string. */
export function hasEmbeddedKey(url: string): boolean {
    return /[?&]key=/.test(url);
}

/** Fetch a generation image with the key in the Authorization header and
 * return a blob: object URL for display. Never persists, never leaks. */
export async function fetchAuthorizedImage(
    url: string,
    apiKey: string,
): Promise<string> {
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
        throw new Error(`Image request failed: ${response.status}`);
    }
    return URL.createObjectURL(await response.blob());
}

/**
 * The image value a save may keep. Blob: URLs die with the page session and
 * keyed URLs are a credential leak, so only an already-uploaded media URL
 * (or an empty value) is persistable — catgpt's "only a published image has
 * a lasting URL worth saving" rule.
 */
export function persistableImage(url: string | undefined | null): string {
    if (!url) return "";
    if (hasEmbeddedKey(url) || url.startsWith("blob:")) return "";
    return url;
}
