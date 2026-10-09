/**
 * Final gate before anything reaches the DynaSport Facebook Page.
 * A post is only published when it matches the DynaSport templates.
 * Hashtags are BANNED from every post.
 */

/** Facebook's documented post limit is 63,206 characters; stay well under it. */
export const MAX_MESSAGE_LENGTH = 60000;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const BAD_TOKEN = /(^|[\s:([])(undefined|null|NaN|\[object Object\])([\s.,)\]']|$)/;

/** No hashtags at all. */
const HASHTAG = /#[A-Za-z0-9_]+/;

/** Content that must never be published. */
const BANNED_CONTENT = /\bcorner(s|\skick)?\b|GOAL ALERT|MATCH REPORT/i;

export function validateMessage(message: unknown): ValidationResult {
  if (typeof message !== "string") return { ok: false, reason: "message is not a string" };

  const trimmed = message.trim();
  if (trimmed.length === 0) return { ok: false, reason: "message is empty" };
  if (message.length > MAX_MESSAGE_LENGTH) return { ok: false, reason: "message exceeds length limit" };

  // No hashtags of any kind.
  if (HASHTAG.test(message)) return { ok: false, reason: "message contains a hashtag" };

  // Never publish placeholder values produced by a missing API field.
  if (BAD_TOKEN.test(message)) return { ok: false, reason: "message contains undefined/null placeholder" };

  // Never publish raw API payloads, diagnostics or secrets.
  if (/^[[{]/.test(trimmed)) return { ok: false, reason: "message looks like raw JSON" };
  if (/"(errors|response|fixture|results|paging)"\s*:/.test(message)) {
    return { ok: false, reason: "message contains raw API JSON" };
  }
  if (/API-Football|Graph error|access_token|Bearer\s/i.test(message)) {
    return { ok: false, reason: "message contains diagnostic/secret text" };
  }

  // Corners, statistics headings and generated commentary are banned.
  if (BANNED_CONTENT.test(message)) {
    return { ok: false, reason: "message contains banned content (corners/headings)" };
  }

  // Spacing integrity: no trailing newlines/spaces, no collapsed blank lines.
  if (message !== message.trimEnd()) return { ok: false, reason: "message ends with whitespace/newlines" };
  if (/[ \t]+\n/.test(message)) return { ok: false, reason: "message has trailing whitespace" };
  if (/\n{3,}/.test(message)) return { ok: false, reason: "message has extra blank lines" };

  const lines = message.split("\n");
  const first = lines[0];

  // First line must be a status (🚩) or a lineup team line ("Flag Team XI:" / "Team XI:").
  const isStatus = first.startsWith("🚩");
  const isLineup = / XI: /.test(first);
  if (!isStatus && !isLineup) {
    return { ok: false, reason: "message does not start with a status or lineup line" };
  }

  // If there is a second line, the line after the first must be blank (the
  // single separator). Everything else is event groups joined by exactly one
  // blank line, guaranteed by construction but asserted here.
  if (lines.length > 1 && lines[1].trim().length !== 0) {
    return { ok: false, reason: "missing blank line after the first line" };
  }

  return { ok: true };
}
