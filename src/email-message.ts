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
  cc?: string;
  bcc?: string;
  date: string;
  message_id: string;
  headers: Record<string, string>;
  body: EmailBody;
  raw_content: string;
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
 * Detects the charset from email headers in raw bytes.
 * Reads the first part of the email to find charset declarations.
 */
function detectCharsetFromBytes(bytes: Uint8Array): string {
  // Read first 2000 bytes as ASCII to find headers
  const headerPreview = new TextDecoder('ascii').decode(bytes.slice(0, 2000));

  // Look for charset in Content-Type headers
  const charsetMatch = headerPreview.match(/charset=["']?([a-zA-Z0-9\-]+)/i);

  if (charsetMatch) {
    const charset = charsetMatch[1].toLowerCase();

    // Normalize charset names
    if (charset === 'iso-8859-2' || charset === 'windows-1250' || charset === 'cp1250') {
      return 'windows-1250';
    }

    return charset;
  }

  // Default to UTF-8
  return 'utf-8';
}

/**
 * Decodes raw email bytes with proper charset detection.
 * First detects charset from headers, then decodes the entire content.
 * Also attempts Windows-1250 decoding as a fallback for corrupted forwarded emails.
 */
export function decodeRawEmail(rawBytes: ArrayBuffer): string {
  const bytes = new Uint8Array(rawBytes);
  const charset = detectCharsetFromBytes(bytes);

  let decoded: string;
  try {
    decoded = new TextDecoder(charset).decode(bytes);
  } catch {
    // Fallback to UTF-8 if charset not supported
    decoded = new TextDecoder('utf-8').decode(bytes);
  }

  // If charset claims UTF-8, also try Windows-1250 and compare special character count
  // This handles cases where Cloudflare Email Routing corrupts Windows-1250 emails
  if (charset === 'utf-8') {
    try {
      const win1250Decoded = new TextDecoder('windows-1250').decode(bytes);
      const utf8Count = (decoded.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length;
      const win1250Count = (win1250Decoded.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length;

      // Use Windows-1250 if it produces more special characters
      if (win1250Count > utf8Count) {
        return win1250Decoded;
      }
    } catch {
      // Windows-1250 decoding failed, continue with original
    }
  }

  return decoded;
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
 * Parses the raw email content to extract text and HTML body parts from multipart messages.
 * Uses regex to match Content-Type headers and extract the corresponding content sections.
 * Applies quoted-printable decoding for proper UTF-8 character support.
 */
export function parseEmailBody(rawContent: string): EmailBody {
  const textMatch = rawContent.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n$)/);
  const htmlMatch = rawContent.match(/Content-Type: text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n$)/);

  return {
    text: textMatch?.[1] ? decodeQuotedPrintable(textMatch[1].trim()) : undefined,
    html: htmlMatch?.[1] ? decodeQuotedPrintable(htmlMatch[1].trim()) : undefined
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

  return {
    subject: message.headers.get('subject') || '',
    from: getOriginalSender(message),
    to: message.headers.get('to') || message.to,
    cc: message.headers.get('cc') || '',
    bcc: message.headers.get('bcc') || '',
    date: message.headers.get('date') || '',
    message_id: message.headers.get('message-id') || '',
    headers: cleanHeaders,
    body,
    raw_content: rawContent
  };
}