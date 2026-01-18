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
 * Represents a parsed email address with name and email components.
 */
export interface EmailAddress {
  email: string;
  name: string;
}

/**
 * Represents a structured email ready for webhook forwarding.
 * Uses snake_case for JSON field names.
 */
export interface StructuredEmail {
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  date: string;
  message_id: string;
  headers: Record<string, string>;
  body: EmailBody;
  raw_content: string;
}

/**
 * Parses a single email address string into name and email components.
 * Handles formats like "Name <user@example.com>" or just "user@example.com".
 */
export function parseEmailAddress(address: string): EmailAddress {
  if (!address) {
    return { email: '', name: '' };
  }

  // Match format: "Name <user@example.com>"
  const match = address.trim().match(/^(.+?)\s*<(.+@.+)>$/);

  if (match) {
    return {
      name: match[1].trim().replace(/^["']|["']$/g, ''), // Remove surrounding quotes if present
      email: match[2].trim()
    };
  }

  // If no angle brackets, assume it's just an email address
  return {
    name: '',
    email: address.trim()
  };
}

/**
 * Parses a comma-separated list of email addresses into an array of EmailAddress objects.
 * Handles multiple recipients in formats like "Name1 <user1@example.com>, Name2 <user2@example.com>".
 */
export function parseEmailAddresses(addresses: string): EmailAddress[] {
  if (!addresses) {
    return [];
  }

  // Split by comma, but be careful not to split commas inside quoted names
  const parts = addresses.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);

  return parts
    .map(part => parseEmailAddress(part.trim()))
    .filter(addr => addr.email); // Filter out empty emails
}

/**
 * Extracts the domain from an email address.
 * Handles formatted addresses like "Name <user@example.com>" and returns the domain part.
 */
export function extractDomain(email: string): string {
  // Extract email from formats like "Name <user@example.com>" or just "user@example.com"
  const emailMatch = email.match(/<(.+@.+)>/) || [null, email];
  const cleanEmail = emailMatch[1];
  return cleanEmail.split('@')[1] || '';
}

/**
 * Removes specified keys from a headers object to avoid duplication.
 * Creates a copy of the original headers, converts hyphenated keys to snake_case, and deletes specified keys.
 */
export function updateHeaders(headers: Record<string, string>, keysToRemove: string[]): Record<string, string> {
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
 * Decodes raw email bytes as UTF-8.
 */
export function decodeRawEmail(rawBytes: ArrayBufferLike): string {
  const bytes = new Uint8Array(rawBytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Decodes quoted-printable encoded content for proper UTF-8 character support.
 * Converts sequences like =C5=9B=C4=87 back to proper Unicode characters like ść.
 */
function decodeQuotedPrintable(content: string): string {
  // First remove soft line breaks
  let decoded = content.replace(/=\r?\n/g, '');

  // Convert quoted-printable hex sequences to bytes, then decode as UTF-8
  const bytes: number[] = [];
  let i = 0;

  while (i < decoded.length) {
    if (decoded[i] === '=' && i + 2 < decoded.length) {
      const hex = decoded.substring(i + 1, i + 3);
      if (/^[0-9A-F]{2}$/i.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 3;
      } else {
        bytes.push(decoded.charCodeAt(i));
        i++;
      }
    } else {
      bytes.push(decoded.charCodeAt(i));
      i++;
    }
  }

  // Convert bytes to UTF-8 string
  const uint8Array = new Uint8Array(bytes);
  return new TextDecoder('utf-8').decode(uint8Array);
}

/**
 * Decodes Base64 encoded content for proper UTF-8 character support.
 * Handles both standard Base64 and removes line breaks before decoding.
 */
function decodeBase64(content: string): string {
  // Remove line breaks and whitespace from Base64 content
  const cleanedContent = content.replace(/[\r\n\s]/g, '');

  try {
    // Decode Base64 to binary string
    const binaryString = atob(cleanedContent);

    // Convert binary string to Uint8Array
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Decode as UTF-8
    return new TextDecoder('utf-8').decode(bytes);
  } catch (error) {
    console.error('Failed to decode Base64 content:', error);
    return content; // Return original content if decoding fails
  }
}

/**
 * Decodes content based on the specified encoding type.
 */
function decodeContent(content: string, encoding?: string): string {
  if (!encoding) {
    return content;
  }

  const normalizedEncoding = encoding.toLowerCase().trim();

  if (normalizedEncoding === 'base64') {
    return decodeBase64(content);
  } else if (normalizedEncoding === 'quoted-printable') {
    return decodeQuotedPrintable(content);
  }

  // For 7bit, 8bit, binary, or unknown encodings, return as-is
  return content;
}

/**
 * Parses the raw email content to extract text and HTML body parts from multipart messages.
 * Detects Content-Transfer-Encoding and applies appropriate decoding (base64, quoted-printable, etc.).
 */
export function parseEmailBody(rawContent: string): EmailBody {
  // Match text/plain section with optional Content-Transfer-Encoding header
  // Pattern: Content-Type: text/plain ... (optional headers) ... blank line ... content
  const textMatch = rawContent.match(/Content-Type: text\/plain[^\r\n]*(?:\r?\n(?![\r\n])[^\r\n]+)*\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n$)/);
  let textEncoding: string | undefined;
  let textContent: string | undefined;

  if (textMatch) {
    // Look for Content-Transfer-Encoding in the section before the blank line
    const sectionBeforeContent = rawContent.substring(
      rawContent.indexOf('Content-Type: text/plain'),
      rawContent.indexOf(textMatch[1])
    );
    const encodingMatch = sectionBeforeContent.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
    textEncoding = encodingMatch?.[1]?.trim();
    textContent = textMatch[1]?.trim();
  }

  // Match text/html section with optional Content-Transfer-Encoding header
  const htmlMatch = rawContent.match(/Content-Type: text\/html[^\r\n]*(?:\r?\n(?![\r\n])[^\r\n]+)*\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n$)/);
  let htmlEncoding: string | undefined;
  let htmlContent: string | undefined;

  if (htmlMatch) {
    // Look for Content-Transfer-Encoding in the section before the blank line
    const sectionBeforeContent = rawContent.substring(
      rawContent.indexOf('Content-Type: text/html'),
      rawContent.indexOf(htmlMatch[1])
    );
    const encodingMatch = sectionBeforeContent.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
    htmlEncoding = encodingMatch?.[1]?.trim();
    htmlContent = htmlMatch[1]?.trim();
  }

  return {
    text: textContent ? decodeContent(textContent, textEncoding) : undefined,
    html: htmlContent ? decodeContent(htmlContent, htmlEncoding) : undefined
  };
}

/**
 * Extracts the original sender from an email message, handling forwarded emails.
 * For forwarded emails, returns the original sender from Return-Path header.
 * For regular emails, returns the message.from value.
 */
export function getOriginalSender(message: { from: string; headers: Headers }): string {
  const returnPath = message.headers.get('return-path');
  const isForwarded = message.headers.get('x-forwarded-to') || message.headers.get('x-forwarded-for');
  return isForwarded && returnPath ? returnPath.replace(/[<>]/g, '') : message.from;
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

  const headerEntries = Object.fromEntries(message.headers.entries());
  const cleanHeaders = updateHeaders(headerEntries, ['subject', 'from', 'to', 'cc', 'bcc', 'date', 'message-id']);

  const fromString = getOriginalSender(message);
  const toString = message.headers.get('to') || message.to;
  const ccString = message.headers.get('cc') || '';
  const bccString = message.headers.get('bcc') || '';

  return {
    subject: message.headers.get('subject') || '',
    from: parseEmailAddress(fromString),
    to: parseEmailAddresses(toString),
    cc: ccString ? parseEmailAddresses(ccString) : undefined,
    bcc: bccString ? parseEmailAddresses(bccString) : undefined,
    date: message.headers.get('date') || '',
    message_id: message.headers.get('message-id') || '',
    headers: cleanHeaders,
    body,
    raw_content: rawContent
  };
}