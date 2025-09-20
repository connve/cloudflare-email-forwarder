/**
 * Environment variables configuration for the email worker.
 * Contains KV store binding for domain-based email routing configuration.
 */
interface Env {
  EMAIL_ROUTING: KVNamespace;
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
 * Configuration for routing emails for a specific domain.
 * Contains webhook URL and reference to the environment variable containing the auth token.
 */
interface RoutingConfig {
  webhook_url: string;
  secret_name: string;
  enabled?: boolean;
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


    // Check domains for routing configuration.
    const fromDomain = extractDomain(message.from);
    const toDomain = extractDomain(message.to);

    // Try to find routing configuration for either domain.
    let routingConfig: RoutingConfig | null = null;
    if (fromDomain) {
      routingConfig = await env.EMAIL_ROUTING.get(fromDomain, 'json');
    }
    if (!routingConfig && toDomain) {
      routingConfig = await env.EMAIL_ROUTING.get(toDomain, 'json');
    }

    if (routingConfig && routingConfig.enabled !== false) {
      console.log(`Found routing config for domain: ${JSON.stringify(routingConfig)}`);

      try {
        // Get auth token from Secrets store using secret name
        const authToken = await (env as any)[routingConfig.secret_name].get();
        if (!authToken) {
          console.error(`Auth token not found for secret: ${routingConfig.secret_name}`);
          return;
        }

        const response = await fetch(routingConfig.webhook_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
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
    } else {
      console.log(`No routing configuration found for domains: ${fromDomain}, ${toDomain}`);
    }
  },
};