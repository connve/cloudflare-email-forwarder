import { StructuredEmail } from "./email-message";

/**
 * Maximum number of retry attempts before giving up.
 * Based on best practices for transient failures:
 * - Attempts: 10 retries
 * - Timeline: ~15 hours total (1min, 2min, 4min, 8min, 16min, 32min, 1hr, 2hr, 4hr, 8hr)
 * - After this, requests are permanently failed and logged for manual review
 */
export const MAX_RETRY_ATTEMPTS = 10;

/**
 * Represents a failed email request that needs to be retried.
 * Only stores the email data and metadata - URLs and tokens are read from env at retry time.
 */
export interface FailedRequest {
  id: string;
  email: StructuredEmail;
  attemptCount: number;
  firstAttemptTimestamp: number;
  lastAttemptTimestamp: number;
  nextRetryTimestamp: number;
  lastError?: string;
}

/**
 * Calculates the next retry delay using exponential backoff.
 * Starts at 1 minute and doubles each time without cap.
 * Designed to work with Cloudflare Workers cron minimum interval of 1 minute.
 *
 * @param attemptCount - The number of previous attempts (0 for first retry)
 * @returns Delay in seconds until next retry
 */
export function calculateRetryDelay(attemptCount: number): number {
  const BASE_DELAY = 60; // 1 minute in seconds

  // Calculate exponential backoff: 60s (1m), 120s (2m), 240s (4m), 480s (8m), 960s (16m), 1920s (32m), 3840s (64m/1h), 7680s (2h), 15360s (4h), 30720s (8h)...
  return BASE_DELAY * Math.pow(2, attemptCount);
}

/**
 * Generates a unique ID for a failed request based on timestamp and random value.
 */
export function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Stores a failed request in KV storage for later retry.
 *
 * @param kv - Cloudflare KV namespace for retry queue
 * @param email - The structured email that failed to send
 * @param error - Optional error message
 * @returns The generated request ID
 */
export async function saveFailedRequest(
  kv: KVNamespace,
  email: StructuredEmail,
  error?: string
): Promise<string> {
  const now = Date.now();
  const requestId = generateRequestId();
  const nextRetryDelay = calculateRetryDelay(0);

  const failedRequest: FailedRequest = {
    id: requestId,
    email,
    attemptCount: 0,
    firstAttemptTimestamp: now,
    lastAttemptTimestamp: now,
    nextRetryTimestamp: now + (nextRetryDelay * 1000),
    lastError: error
  };

  // Store with key pattern: retry:{timestamp}:{id}
  // This allows efficient listing by timestamp
  const key = `retry:${failedRequest.nextRetryTimestamp}:${requestId}`;
  await kv.put(key, JSON.stringify(failedRequest));

  const delayMinutes = Math.floor(nextRetryDelay / 60);
  console.log(`Saved failed request ${requestId} for retry in ${delayMinutes}m`);
  return requestId;
}

/**
 * Updates a failed request after a retry attempt.
 * Implements circuit breaker pattern - stops retrying after MAX_RETRY_ATTEMPTS.
 *
 * @param kv - Cloudflare KV namespace for retry queue
 * @param oldKey - The current KV key to delete
 * @param failedRequest - The failed request to update
 * @param success - Whether the retry was successful
 * @param error - Optional error message if retry failed
 */
export async function updateFailedRequest(
  kv: KVNamespace,
  oldKey: string,
  failedRequest: FailedRequest,
  success: boolean,
  error?: string
): Promise<void> {
  // Delete the old key
  await kv.delete(oldKey);

  if (success) {
    console.log(`Request ${failedRequest.id} succeeded after ${failedRequest.attemptCount + 1} attempts`);
    return;
  }

  // Circuit breaker: Check if max attempts reached
  const newAttemptCount = failedRequest.attemptCount + 1;
  if (newAttemptCount >= MAX_RETRY_ATTEMPTS) {
    // Permanently failed - store in dead letter queue for manual review
    const deadLetterKey = `failed:${Date.now()}:${failedRequest.id}`;
    const deadLetterData = {
      ...failedRequest,
      attemptCount: newAttemptCount,
      lastAttemptTimestamp: Date.now(),
      lastError: error,
      permanentlyFailed: true
    };
    await kv.put(deadLetterKey, JSON.stringify(deadLetterData));
    console.error(`Request ${failedRequest.id} permanently failed after ${MAX_RETRY_ATTEMPTS} attempts. Moved to dead letter queue.`);
    return;
  }

  // Update for next retry
  const now = Date.now();
  const nextRetryDelay = calculateRetryDelay(newAttemptCount);

  const updatedRequest: FailedRequest = {
    ...failedRequest,
    attemptCount: newAttemptCount,
    lastAttemptTimestamp: now,
    nextRetryTimestamp: now + (nextRetryDelay * 1000),
    lastError: error
  };

  // Store with new timestamp-based key
  const newKey = `retry:${updatedRequest.nextRetryTimestamp}:${failedRequest.id}`;
  await kv.put(newKey, JSON.stringify(updatedRequest));

  const delayMinutes = Math.floor(nextRetryDelay / 60);
  console.log(`Updated request ${failedRequest.id} for retry in ${delayMinutes}m (attempt ${updatedRequest.attemptCount + 1}/${MAX_RETRY_ATTEMPTS})`);
}

/**
 * Fetches failed requests that are ready to be retried.
 * Returns requests whose nextRetryTimestamp is in the past.
 *
 * @param kv - Cloudflare KV namespace for retry queue
 * @param limit - Maximum number of requests to fetch (default 100)
 * @returns Array of failed requests with their KV keys
 */
export async function getRetryableRequests(
  kv: KVNamespace,
  limit: number = 100
): Promise<Array<{ key: string; request: FailedRequest }>> {
  const now = Date.now();
  const results: Array<{ key: string; request: FailedRequest }> = [];

  // List all keys with retry: prefix
  const list = await kv.list({ prefix: 'retry:', limit });

  for (const item of list.keys) {
    // Parse timestamp from key: retry:{timestamp}:{id}
    const parts = item.name.split(':');
    if (parts.length < 3) continue;

    const retryTimestamp = parseInt(parts[1], 10);

    // Only fetch if ready to retry
    if (retryTimestamp <= now) {
      const value = await kv.get(item.name, 'text');
      if (value) {
        try {
          const request = JSON.parse(value) as FailedRequest;
          results.push({ key: item.name, request });
        } catch (e) {
          console.error(`Failed to parse retry request ${item.name}:`, e);
        }
      }
    }
  }

  return results;
}

/**
 * Attempts to send a failed request to the webhook using current env variables.
 *
 * @param failedRequest - The failed request to retry
 * @param webhookUrl - The webhook URL from env
 * @param apiToken - The API token from env
 * @returns Result object with success status and optional error
 */
export async function retryFailedRequest(
  failedRequest: FailedRequest,
  webhookUrl: string,
  apiToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify(failedRequest.email)
    });

    if (response.ok) {
      console.log(`Retry successful for request ${failedRequest.id}`);
      return { success: true };
    } else {
      const errorMsg = `Webhook failed with status ${response.status}`;
      console.error(`Retry failed for request ${failedRequest.id}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`Retry error for request ${failedRequest.id}:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}
