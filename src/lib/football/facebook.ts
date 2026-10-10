import {
  FacebookAuthError,
  FacebookConfigError,
  FacebookPermanentError,
  FacebookPostError,
  FacebookUncertainError,
} from "./errors";
import { validateMessage } from "./validate";

/**
 * Real Meta Graph API posting to the DynaSport Page feed.
 * Uses the existing Page Access Token as configured. No token is ever logged,
 * and Graph error payloads are sanitized before being surfaced.
 */

const GRAPH_VERSION = "v21.0";

export function isFacebookConfigured(): boolean {
  return Boolean(process.env.FACEBOOK_PAGE_ID && process.env.FACEBOOK_PAGE_ACCESS_TOKEN);
}

export interface FacebookPostResult {
  id: string;
}

interface GraphErrorShape {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
  id?: string;
}

export async function postToFacebookPage(message: string): Promise<FacebookPostResult> {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  if (!pageId || !pageAccessToken) {
    throw new FacebookConfigError(
      "FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN must both be configured",
    );
  }

  // Last line of defence: never publish malformed content to the Page.
  const validation = validateMessage(message);
  if (!validation.ok) {
    throw new FacebookPermanentError(`Refused to publish invalid message: ${validation.reason}`);
  }

  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        message,
        access_token: pageAccessToken,
      }).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    // The POST may have reached Facebook before the transport failed. Retrying
    // blindly can create a duplicate, so mark the outcome uncertain and
    // reconcile against the Page feed first.
    throw new FacebookUncertainError(
      `Facebook Graph publish outcome unknown: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let data: GraphErrorShape | null = null;
  try {
    data = (await res.json()) as GraphErrorShape;
  } catch {
    data = null;
  }

  if (!res.ok || data?.error) {
    const err = data?.error;
    const parts = [
      err?.type ? `type=${err.type}` : null,
      typeof err?.code === "number" ? `code=${err.code}` : null,
      typeof err?.error_subcode === "number" ? `subcode=${err.error_subcode}` : null,
      err?.message ? err.message.slice(0, 240) : null,
      err?.fbtrace_id ? `trace=${err.fbtrace_id}` : null,
    ].filter(Boolean);
    const detail = `Facebook Graph error (${res.status}): ${parts.length > 0 ? parts.join(" ") : "unknown"}`;

    /**
     * Credential / permission failures (verified against current Meta docs):
     *   190 OAuthException - invalid or expired token
     *        subcode 458 app removed · 459 checkpointed · 460 password changed
     *        463 session expired · 464 unconfirmed · 467 invalid · 492 no Page role
     *   102 session · 10 + 200-299 permission · 100 invalid parameter (bad Page ID)
     * These cannot be fixed by retrying, but they ARE fixed by configuring a
     * valid Page access token - so the event must stay queued, not be retired.
     */
    const code = typeof err?.code === "number" ? err.code : null;
    // Meta code 506 means duplicate content. A matching post likely exists;
    // reconcile the Page feed instead of retrying or marking this delivered
    // without a post ID.
    if (code === 506) {
      throw new FacebookUncertainError(detail);
    }
    const authCode =
      code === 190 ||
      code === 102 ||
      code === 100 ||
      code === 10 ||
      (code !== null && code >= 200 && code <= 299);
    if (authCode || res.status === 403) {
      throw new FacebookAuthError(detail);
    }

    // Rate limited by Graph API (4/17/32/613): transient, back off and retry.
    if (res.status === 429 || code === 4 || code === 17 || code === 32 || code === 613) {
      throw new FacebookPostError(`${detail} (rate limited)`);
    }

    throw new FacebookPostError(detail);
  }

  const id = data?.id;
  if (!id) {
    throw new FacebookPostError("Facebook Graph response did not include a post id");
  }

  return { id };
}

export interface FacebookFeedPost {
  id: string;
  message: string;
  createdTime: string | null;
}

/**
 * Read recent posts from the configured Page for uncertain-outcome
 * reconciliation. This is called only when a publish transport failed.
 */
export async function getRecentFacebookPagePosts(limit = 50): Promise<FacebookFeedPost[]> {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!pageId || !pageAccessToken) {
    throw new FacebookConfigError(
      "FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN must both be configured",
    );
  }

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`);
  url.searchParams.set("fields", "id,message,created_time");
  url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 100))));
  url.searchParams.set("access_token", pageAccessToken);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new FacebookPostError(
      `Facebook reconciliation request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: Array<{ id?: unknown; message?: unknown; created_time?: unknown }>;
    error?: GraphErrorShape["error"];
  } | null;

  if (!response.ok || payload?.error) {
    const code = payload?.error?.code;
    const detail = `Facebook feed reconciliation error (${response.status})${
      typeof code === "number" ? ` code=${code}` : ""
    }: ${(payload?.error?.message ?? "unknown").slice(0, 240)}`;
    if (code === 190 || code === 102 || code === 10 || response.status === 403) {
      throw new FacebookAuthError(detail);
    }
    throw new FacebookPostError(detail);
  }

  if (!Array.isArray(payload?.data)) return [];
  return payload.data.flatMap((post) => {
    if (typeof post.id !== "string" || typeof post.message !== "string") return [];
    return [{
      id: post.id,
      message: post.message,
      createdTime: typeof post.created_time === "string" ? post.created_time : null,
    }];
  });
}
