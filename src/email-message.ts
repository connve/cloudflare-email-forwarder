/**
 * Extended EmailMessage interface that includes access to raw email content and headers.
 * Provides the complete email data needed for processing and forwarding.
 */
export interface ForwardableEmailMessage extends EmailMessage {
  raw: ReadableStream;
  headers: Headers;
}

/**
 * Represents the parsed body content of an email message.
 * Contains optional text and HTML versions extracted from multipart messages.
 */
export interface EmailBody {
  text?: string;
  html?: string;
}

/**
 * Represents a structured email ready for webhook forwarding.
 * Uses snake_case for JSON field names.
 */
export interface StructuredEmail {
  subject: string;
  from: string;
  to: string;
  date: string;
  message_id: string;
  headers: Record<string, string>;
  body: EmailBody;
  raw_content: string;
}

/**
 * Removes specified keys from a headers object to avoid duplication.
 * Creates a copy of the original headers, converts hyphenated keys to snake_case, and deletes specified keys.
 */
function updateHeaders(headers: Record<string, string>, keysToRemove: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  // Convert all header keys from hyphenated to snake_case and copy values
  Object.entries(headers).forEach(([key, value]) => {
    const snakeKey = key.replace(/-/g, '_');
    result[snakeKey] = value;
  });

  // Remove specified keys (check both original and snake_case versions)
  keysToRemove.forEach(key => {
    delete result[key];
    delete result[key.replace(/-/g, '_')];
  });

  return result;
}

/**
 * Parses the raw email content to extract text and HTML body parts from multipart messages.
 * Uses regex to match Content-Type headers and extract the corresponding content sections.
 */
export function parseEmailBody(rawContent: string): EmailBody {
  const textMatch = rawContent.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n$)/);
  const htmlMatch = rawContent.match(/Content-Type: text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n$)/);

  return {
    text: textMatch?.[1]?.trim(),
    html: htmlMatch?.[1]?.trim()
  };
}

/**
 * Creates a structured email object from an email message.
 * Handles header cleaning and body parsing internally.
 */
export function createStructuredEmail(
  message: { from: string; to: string; headers: Headers },
  body: EmailBody,
  rawContent: string
): StructuredEmail {
  // Convert headers to object and clean duplicated fields
  const headerEntries = Object.fromEntries(message.headers.entries());
  const cleanHeaders = updateHeaders(headerEntries, ['subject', 'from', 'to', 'date', 'message-id']);

  return {
    subject: message.headers.get('subject') || '',
    from: message.from,
    to: message.to,
    date: message.headers.get('date') || '',
    message_id: message.headers.get('message-id') || '',
    headers: cleanHeaders,
    body,
    raw_content: rawContent
  };
}