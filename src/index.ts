import { createStructuredEmail, parseEmailBody, ForwardableEmailMessage, getOriginalSender, extractDomain, decodeRawEmail } from "./email-message";
import { saveFailedRequest, getRetryableRequests, retryFailedRequest, updateFailedRequest } from "./retry";

/**
 * Environment variables configuration for the email worker.
 * Static configuration for single-client deployment with domain filtering.
 */
interface Env {
  HTTP_WEBHOOK_URL: string;
  HTTP_WEBHOOK_API_TOKEN: string;
  DOMAIN_FILTER?: KVNamespace;
  RETRY_QUEUE?: KVNamespace;
}



export default {
  /**
   * Handles incoming email messages by parsing content and forwarding to a webhook.
   * Extracts email headers, body content, and sends structured data via HTTP POST with basic authentication.
   */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // Validate required environment variables.
    if (!env.HTTP_WEBHOOK_URL) {
      console.error('Missing required environment variable: HTTP_WEBHOOK_URL');
      throw new Error('Missing required environment variable: HTTP_WEBHOOK_URL');
    }

    if (!env.HTTP_WEBHOOK_API_TOKEN) {
      console.error('Missing required environment variable: HTTP_WEBHOOK_API_TOKEN');
      throw new Error('Missing required environment variable: HTTP_WEBHOOK_API_TOKEN');
    }

    // Extract domains for filtering.
    const fromDomain = extractDomain(getOriginalSender(message));
    const toDomain = extractDomain(message.headers.get('to') || message.to);

    // Check if domains should be filtered out (only if DOMAIN_FILTER is configured).
    if (env.DOMAIN_FILTER) {
      const fromBlocked = fromDomain ? await env.DOMAIN_FILTER.get(`blocked:${fromDomain}`) : null;
      const toBlocked = toDomain ? await env.DOMAIN_FILTER.get(`blocked:${toDomain}`) : null;

      if (fromBlocked || toBlocked) {
        console.log(`Email addres blocked: from=${fromDomain}, to=${toDomain}`);
        return;
      }

      // Check for internal emails (both domains are configured as internal).
      const fromInternal = fromDomain ? await env.DOMAIN_FILTER.get(`internal:${fromDomain}`) : null;
      const toInternal = toDomain ? await env.DOMAIN_FILTER.get(`internal:${toDomain}`) : null;

      if (fromInternal && toInternal) {
        console.log(`Internal email dropped: from=${fromDomain}, to=${toDomain}`);
        return;
      }
    }

    // Read raw bytes and decode with proper charset detection
    const rawBytes = await new Response(message.raw).arrayBuffer();
    const rawContent = decodeRawEmail(rawBytes);
    const body = parseEmailBody(rawContent);

    const email = createStructuredEmail(message, body, rawContent);


    // Send to configured webhook.
    try {
      const response = await fetch(env.HTTP_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.HTTP_WEBHOOK_API_TOKEN}`
        },
        body: JSON.stringify(email)
      });

      if (response.ok) {
        console.log(`Email forwarded: from=${fromDomain}, to=${toDomain}`);
      } else {
        // Webhook failed - save for retry if RETRY_QUEUE is configured
        const errorMsg = `Webhook failed with status ${response.status}`;
        console.error(`${errorMsg}: from=${fromDomain}, to=${toDomain}`);

        if (env.RETRY_QUEUE) {
          await saveFailedRequest(env.RETRY_QUEUE, email, errorMsg);
        } else {
          console.error('RETRY_QUEUE not configured, email will not be retried:', JSON.stringify(email));
        }
      }
    } catch (error) {
      // Network or other error - save for retry if RETRY_QUEUE is configured
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('Error sending HTTP request:', errorMsg);

      if (env.RETRY_QUEUE) {
        await saveFailedRequest(env.RETRY_QUEUE, email, errorMsg);
      } else {
        console.error('RETRY_QUEUE not configured, email will not be retried:', JSON.stringify(email));
      }
    }
  },

  /**
   * Scheduled handler that processes failed requests and retries them with exponential backoff.
   * This should be configured as a Cron Trigger in wrangler.toml to run every minute.
   * Example: crons = ["* * * * *"]
   *
   * Note: This handler is only needed if RETRY_QUEUE is configured.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Skip retry processing if RETRY_QUEUE is not configured
    if (!env.RETRY_QUEUE) {
      console.log('RETRY_QUEUE not configured - skipping retry processor');
      return;
    }

    console.log('Running retry processor...');

    // Validate required environment variables
    if (!env.HTTP_WEBHOOK_URL || !env.HTTP_WEBHOOK_API_TOKEN) {
      console.error('Missing required environment variables for retry processor');
      return;
    }

    try {
      // Fetch all requests ready for retry
      const retryableRequests = await getRetryableRequests(env.RETRY_QUEUE);

      if (retryableRequests.length === 0) {
        console.log('No requests ready for retry');
        return;
      }

      console.log(`Processing ${retryableRequests.length} retry requests`);

      // Process each request
      for (const { key, request } of retryableRequests) {
        const result = await retryFailedRequest(
          request,
          env.HTTP_WEBHOOK_URL,
          env.HTTP_WEBHOOK_API_TOKEN
        );

        // Update the request based on result
        await updateFailedRequest(
          env.RETRY_QUEUE,
          key,
          request,
          result.success,
          result.error
        );
      }

      console.log('Retry processor completed');
    } catch (error) {
      console.error('Error in retry processor:', error);
    }
  },
};