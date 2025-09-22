/**
 * Environment variables configuration for the email worker.
 * Static configuration for single-client deployment with domain filtering.
 */
interface Env {
  HTTP_WEBHOOK_URL: string;
  HTTP_WEBHOOK_API_TOKEN: string;
  DOMAIN_FILTER: KVNamespace;
}

/**
 * Extended EmailMessage interface that includes access to raw email content and headers.
 * Provides the complete email data needed for processing and forwarding.
 */
interface ForwardableEmailMessage extends EmailMessage {
  raw: ReadableStream;
  headers: Headers;
}

/**
 * Represents the parsed body content of an email message.
 * Contains optional text and HTML versions extracted from multipart messages.
 */
interface EmailBody {
  text?: string;
  html?: string;
}


/**
 * Parses the raw email content to extract text and HTML body parts from multipart messages.
 * Uses regex to match Content-Type headers and extract the corresponding content sections.
 */
function parseEmailBody(rawContent: string): EmailBody {
  const textMatch = rawContent.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n$)/);
  const htmlMatch = rawContent.match(/Content-Type: text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n$)/);

  return {
    text: textMatch?.[1]?.trim(),
    html: htmlMatch?.[1]?.trim()
  };
}

/**
 * Removes specified keys from a headers object to avoid duplication.
 * Creates a copy of the original headers and deletes the specified keys.
 */
function updateHeaders(headers: Record<string, string>, keysToRemove: string[]): Record<string, string> {
  const result = { ...headers };
  keysToRemove.forEach(key => delete result[key]);
  return result;
}

/**
 * Extracts the domain from an email address.
 * Returns the domain part after the @ symbol (e.g., "user@example.com" → "example.com").
 */
function extractDomain(email: string): string {
  return email.split('@')[1] || '';
}


export default {
  /**
   * Handles incoming email messages by parsing content and forwarding to a webhook.
   * Extracts email headers, body content, and sends structured data via HTTP POST with basic authentication.
   */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // Validate required environment variables
    if (!env.HTTP_WEBHOOK_URL) {
      console.error('Missing required environment variable: HTTP_WEBHOOK_URL');
      throw new Error('Missing required environment variable: HTTP_WEBHOOK_URL');
    }

    if (!env.HTTP_WEBHOOK_API_TOKEN) {
      console.error('Missing required environment variable: HTTP_WEBHOOK_API_TOKEN');
      throw new Error('Missing required environment variable: HTTP_WEBHOOK_API_TOKEN');
    }

    // Extract domains for filtering
    const fromDomain = extractDomain(message.from);
    const toDomain = extractDomain(message.to);

    console.log(`Processing email: from=${message.from} (${fromDomain}), to=${message.to} (${toDomain})`);

    // Check if domains should be filtered out
    const fromBlocked = fromDomain ? await env.DOMAIN_FILTER.get(`blocked:${fromDomain}`) : null;
    const toBlocked = toDomain ? await env.DOMAIN_FILTER.get(`blocked:${toDomain}`) : null;

    if (fromBlocked || toBlocked) {
      console.log(`Email blocked - domain filter matched: from=${fromBlocked ? fromDomain : 'allowed'}, to=${toBlocked ? toDomain : 'allowed'}`);
      return;
    }

    // Check for internal emails (both domains are configured as internal)
    const fromInternal = fromDomain ? await env.DOMAIN_FILTER.get(`internal:${fromDomain}`) : null;
    const toInternal = toDomain ? await env.DOMAIN_FILTER.get(`internal:${toDomain}`) : null;

    if (fromInternal && toInternal) {
      console.log(`Internal email detected - dropping: from=${fromDomain}, to=${toDomain}`);
      return;
    }

    const headerEntries = Object.fromEntries(message.headers.entries());

    const rawContent = await new Response(message.raw).text();
    const body = parseEmailBody(rawContent);

    const headers = updateHeaders(headerEntries, ['subject', 'from', 'to', 'date', 'message-id']);

    const email = {
      subject: headerEntries.subject || message.headers.get('subject') || '',
      from: message.from,
      to: message.to,
      date: headerEntries.date || '',
      "message-id": headerEntries['message-id'] || '',
      headers,
      body,
      "raw-content": rawContent
    };


    // Send to configured webhook
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