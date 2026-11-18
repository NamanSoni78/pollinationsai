export const MAX_EMBEDDING_BATCH_SIZE = 32;

/**
 * Multimodal (parts) input: every image/video part triggers a remote fetch or
 * carries an inline payload that stays resident until the provider call, so
 * the parts array needs the same kind of count cap as the string batch.
 */
export const MAX_EMBEDDING_PARTS = 8;
