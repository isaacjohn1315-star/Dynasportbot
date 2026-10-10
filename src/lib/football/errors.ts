export class DynaSportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends DynaSportError {}
export class ApiBudgetExceededError extends DynaSportError {}
export class ApiFootballError extends DynaSportError {}
export class FacebookConfigError extends DynaSportError {}
export class FacebookPostError extends DynaSportError {}

/**
 * Account/plan/credential problems from a provider. These must never be
 * retried in a loop: retrying burns the 100/day API quota or re-hits a
 * permanently rejected Facebook call.
 */
export class ApiAccountError extends DynaSportError {}

/**
 * Facebook credential/permission failure (OAuth 190 and friends).
 * Not retryable while the credentials stay broken, but the event MUST stay
 * queued: once a valid Page token is configured the post is delivered.
 */
export class FacebookAuthError extends FacebookPostError {}

/**
 * Transport failure after a Graph POST was started. The outcome is unknown:
 * Facebook may have created the post even though no response reached us.
 * Never retry blindly; reconcile the Page feed first.
 */
export class FacebookUncertainError extends FacebookPostError {}

/**
 * Genuinely undeliverable: the content itself is invalid. Retrying can never
 * help, so these are retired permanently.
 */
export class FacebookPermanentError extends FacebookPostError {}

/** Human-readable error message, safe for logs/monitoring rows (never contains secrets). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message).slice(0, 500);
  return redactSecrets(String(error)).slice(0, 500);
}

/**
 * Defence in depth: even though no secret is ever interpolated into an error
 * message, scrub anything that looks like a configured secret before it can
 * reach the database, the dashboard or the logs.
 */
export function redactSecrets(input: string): string {
  let output = input;
  const secrets = [
    process.env.FOOTBALL_API_KEY,
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN,
    process.env.FACEBOOK_APP_SECRET,
    process.env.CRON_SECRET,
    process.env.DATABASE_URL,
  ];
  for (const secret of secrets) {
    if (secret && secret.length >= 8 && output.includes(secret)) {
      output = output.split(secret).join("[redacted]");
    }
  }
  // Generic access_token=... patterns (e.g. if a URL ever leaks into an error).
  return output.replace(/access_token=[^&\s"']+/gi, "access_token=[redacted]");
}

/**
 * True when retrying later could plausibly succeed *without* an operator
 * action. Auth failures are excluded here (they need a new token) but are
 * kept queued via `isAuthFailure`, not retired.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiAccountError) return false;
  if (error instanceof FacebookAuthError) return false;
  if (error instanceof FacebookUncertainError) return false;
  if (error instanceof FacebookPermanentError) return false;
  if (error instanceof ConfigError) return false;
  if (error instanceof FacebookConfigError) return false;
  if (error instanceof ApiBudgetExceededError) return false;
  return true;
}

/** Credential problem: pause delivery, keep the event queued for later. */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof FacebookAuthError || error instanceof FacebookConfigError;
}

/** POST result is unknown: reconcile before any retry. */
export function isUncertainFailure(error: unknown): boolean {
  return error instanceof FacebookUncertainError;
}

/** Content can never be delivered: retire it permanently. */
export function isUndeliverable(error: unknown): boolean {
  return error instanceof FacebookPermanentError && !(error instanceof FacebookAuthError);
}
