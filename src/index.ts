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
    let email: ReturnType<typeof createStructuredEmail> | null = null;
    let fromDomain = '';
    let toDomain = '';

    // Wrap everything in try-catch to ensure all errors route to retry_queue
    try {
      // Extract domains for filtering early (before validation).
      fromDomain = extractDomain(getOriginalSender(message));
      toDomain = extractDomain(message.headers.get('to') || message.to);

      // Parse email content early so we can save it to retry_queue if anything fails
      // IMPORTANT: message.raw is a ReadableStream that can only be consumed once
      const rawBytes = await new Response(message.raw).arrayBuffer();
      const rawContent = decodeRawEmail(rawBytes);
      const body = parseEmailBody(rawContent);
      email = createStructuredEmail(message, body, rawContent);

      // Check if domains should be filtered out (only if DOMAIN_FILTER is configured).
      if (env.DOMAIN_FILTER) {
        const fromBlocked = fromDomain ? await env.DOMAIN_FILTER.get(`blocked:${fromDomain}`) : null;
        const toBlocked = toDomain ? await env.DOMAIN_FILTER.get(`blocked:${toDomain}`) : null;

        if (fromBlocked || toBlocked) {
          console.log(`Email address blocked: from=${fromDomain}, to=${toDomain}`);
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

      // Validate required environment variables - but don't throw, save to retry_queue instead
      if (!env.HTTP_WEBHOOK_URL || !env.HTTP_WEBHOOK_API_TOKEN) {
        const missingVars = [];
        if (!env.HTTP_WEBHOOK_URL) missingVars.push('HTTP_WEBHOOK_URL');
        if (!env.HTTP_WEBHOOK_API_TOKEN) missingVars.push('HTTP_WEBHOOK_API_TOKEN');

        const errorMsg = `Missing required environment variables: ${missingVars.join(', ')}`;
        console.error(errorMsg);

        // Save to retry_queue if configured, otherwise just log
        if (env.RETRY_QUEUE) {
          await saveFailedRequest(env.RETRY_QUEUE, email, errorMsg);
          console.log('Email saved to retry_queue due to missing environment variables');
        } else {
          console.error('RETRY_QUEUE not configured, email will not be retried:', JSON.stringify(email));
        }
        return;
      }

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
    } catch (error) {
      // Catch-all for any unexpected errors during email processing
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('Critical error in email handler:', errorMsg);

      // If we successfully parsed the email before the error, try to save it to retry_queue
      if (email && env.RETRY_QUEUE) {
        try {
          await saveFailedRequest(env.RETRY_QUEUE, email, `Critical error: ${errorMsg}`);
          console.log('Email saved to retry_queue after critical error');
        } catch (saveError) {
          console.error('Failed to save email to retry_queue:', saveError);
          console.error('Original error:', errorMsg);
        }
      } else if (!email) {
        // Email parsing failed - we can't save it, but at least we won't crash
        console.error('Cannot save email to retry_queue: email parsing failed');
        console.error('Email metadata - From:', message.from || '(empty)', 'To:', message.to || '(empty)');
        console.error('Extracted domains - fromDomain:', fromDomain || '(empty)', 'toDomain:', toDomain || '(empty)');
      } else {
        console.error('RETRY_QUEUE not configured, cannot save failed email');
        console.error('Email metadata - From:', message.from || '(empty)', 'To:', message.to || '(empty)');
      }
    }
  },

  /**
   * Scheduled handler that processes failed requests and retries them with exponential backoff.
   * Configure the Cron Trigger interval in your Cloudflare dashboard or wrangler.toml based on your KV read limits.
   * Examples:
   *   - Every minute: "* * * * *" (60 KV reads/hour)
   *   - Every 10 minutes: "* /10 * * * *" (6 KV reads/hour, remove space after *)
   *   - Every hour: "0 * * * *" (1 KV read/hour)
   *
   * Note: Exponential backoff delays (1min, 2min, 4min, etc.) are minimum delays.
   * Actual retry happens at the next cron run after the delay expires.
   * This handler is only needed if RETRY_QUEUE is configured.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Skip retry processing if RETRY_QUEUE is not configured
    if (!env.RETRY_QUEUE) {
      console.log('RETRY_QUEUE not configured - skipping retry processor');
      return;
    }

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