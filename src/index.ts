import { createStructuredEmail, parseEmailBody, ForwardableEmailMessage } from "./email-message";
import { extractDomain } from "./utils";

/**
 * Environment variables configuration for the email worker.
 * Static configuration for single-client deployment with domain filtering.
 */
interface Env {
  HTTP_WEBHOOK_URL: string;
  HTTP_WEBHOOK_API_TOKEN: string;
  DOMAIN_FILTER: KVNamespace;
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
    const fromDomain = extractDomain(message.from);
    const toDomain = extractDomain(message.to);

    console.log(`Processing email: from=${message.from} (${fromDomain}), to=${message.to} (${toDomain})`);

    // Check if domains should be filtered out.
    const fromBlocked = fromDomain ? await env.DOMAIN_FILTER.get(`blocked:${fromDomain}`) : null;
    const toBlocked = toDomain ? await env.DOMAIN_FILTER.get(`blocked:${toDomain}`) : null;

    if (fromBlocked || toBlocked) {
      console.log(`Email blocked - domain filter matched: from=${fromBlocked ? fromDomain : 'allowed'}, to=${toBlocked ? toDomain : 'allowed'}`);
      return;
    }

    // Check for internal emails (both domains are configured as internal).
    const fromInternal = fromDomain ? await env.DOMAIN_FILTER.get(`internal:${fromDomain}`) : null;
    const toInternal = toDomain ? await env.DOMAIN_FILTER.get(`internal:${toDomain}`) : null;

    if (fromInternal && toInternal) {
      console.log(`Internal email detected - dropping: from=${fromDomain}, to=${toDomain}`);
      return;
    }

    const rawContent = await new Response(message.raw).text();
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
        console.log('Successfully sent HTTP request to webhook.');
      } else {
        console.error('Webhook request failed:', response.status, response.statusText);
      }
    } catch (error) {
      console.error('Error sending HTTP request:', error);
    }
  },
};