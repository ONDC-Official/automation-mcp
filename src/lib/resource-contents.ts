import type { ReadResourceResult } from "@modelcontextprotocol/server";

/** MIME type every resource in this server serves. */
export const MIME_JSON = "application/json";

/**
 * Wrap a payload as the single JSON content block of a resource read.
 *
 * Resources have no `isError` channel, so a handler that fails must throw an
 * `AppError` (see `toAppError`) rather than returning a failure shape here.
 */
export function jsonContents(uri: URL, payload: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: MIME_JSON,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
