import { describe, it, expect } from 'vitest';
import {
  parseEmailBody,
  createStructuredEmail,
  getOriginalSender,
  updateHeaders,
  extractDomain,
  EmailBody,
  StructuredEmail
} from './email-message';

// Mock Headers class for testing
class MockHeaders {
  private headers: Map<string, string>;

  constructor(init?: Record<string, string>) {
    this.headers = new Map();
    if (init) {
      Object.entries(init).forEach(([key, value]) => {
        this.headers.set(key.toLowerCase(), value);
      });
    }
  }

  get(name: string): string | null {
    return this.headers.get(name.toLowerCase()) || null;
  }

  entries(): IterableIterator<[string, string]> {
    return this.headers.entries();
  }
}

describe('getOriginalSender', () => {
  it('should return message.from for non-forwarded emails', () => {
    const message = {
      from: 'user@example.com',
      headers: new MockHeaders({
        'subject': 'Test Email'
      }) as unknown as Headers
    };

    expect(getOriginalSender(message)).toBe('user@example.com');
  });

  it('should return original sender for forwarded emails with return-path', () => {
    const message = {
      from: 'user+forwarded=staging@example.com',
      headers: new MockHeaders({
        'x-forwarded-to': 'staging@example.org',
        'return-path': '<original@gmail.com>'
      }) as unknown as Headers
    };

    expect(getOriginalSender(message)).toBe('original@gmail.com');
  });

  it('should remove angle brackets from return-path', () => {
    const message = {
      from: 'forwarded@example.com',
      headers: new MockHeaders({
        'x-forwarded-for': 'user@example.com staging@example.com',
        'return-path': '<original.sender@gmail.com>'
      }) as unknown as Headers
    };

    expect(getOriginalSender(message)).toBe('original.sender@gmail.com');
  });

  it('should fallback to message.from if forwarded but no return-path', () => {
    const message = {
      from: 'forwarded@example.com',
      headers: new MockHeaders({
        'x-forwarded-to': 'staging@example.com'
      }) as unknown as Headers
    };

    expect(getOriginalSender(message)).toBe('forwarded@example.com');
  });
});

describe('parseEmailBody', () => {
  it('should parse multipart email with text and HTML', () => {
    const rawContent = `Content-Type: multipart/alternative; boundary="boundary123"

--boundary123
Content-Type: text/plain; charset="UTF-8"

Hello World
This is plain text.

--boundary123
Content-Type: text/html; charset="UTF-8"

<html><body>Hello <b>World</b></body></html>

--boundary123--`;

    const result = parseEmailBody(rawContent);

    expect(result.text).toBe('Hello World\nThis is plain text.');
    expect(result.html).toBe('<html><body>Hello <b>World</b></body></html>');
  });

  it('should handle text only email', () => {
    const rawContent = `Content-Type: multipart/alternative; boundary="simple"

--simple
Content-Type: text/plain; charset="UTF-8"

Just plain text here.

--simple--`;

    const result = parseEmailBody(rawContent);

    expect(result.text).toBe('Just plain text here.');
    expect(result.html).toBeUndefined();
  });

  it('should handle HTML only email', () => {
    const rawContent = `Content-Type: multipart/alternative; boundary="simple"

--simple
Content-Type: text/html; charset="UTF-8"

<p>HTML only content</p>

--simple--`;

    const result = parseEmailBody(rawContent);

    expect(result.html).toBe('<p>HTML only content</p>');
    expect(result.text).toBeUndefined();
  });

  it('should handle empty content', () => {
    const rawContent = '';
    const result = parseEmailBody(rawContent);

    expect(result.text).toBeUndefined();
    expect(result.html).toBeUndefined();
  });

  it('should handle content with Windows line endings', () => {
    const rawContent = "Content-Type: multipart/alternative; boundary=\"windows\"\r\n\r\n--windows\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\nWindows text\r\nwith CRLF\r\n\r\n--windows--";

    const result = parseEmailBody(rawContent);

    expect(result.text).toBe('Windows text\r\nwith CRLF');
  });
});

describe('createStructuredEmail', () => {
  it('should create structured email with all fields', () => {
    const mockHeaders = new MockHeaders({
      'subject': 'Test Subject',
      'to': 'recipient@example.com',
      'cc': 'cc@example.com',
      'bcc': 'bcc@example.com',
      'date': 'Mon, 1 Jan 2024 12:00:00 +0000',
      'message-id': '<test@example.com>',
      'content-type': 'multipart/alternative',
      'received': 'by mail.example.com'
    }) as unknown as Headers;

    const message = {
      from: 'sender@example.com',
      to: 'envelope@example.com',
      headers: mockHeaders
    };

    const body: EmailBody = {
      text: 'Plain text content',
      html: '<p>HTML content</p>'
    };

    const rawContent = 'Raw email content...';

    const result = createStructuredEmail(message, body, rawContent);

    expect(result).toEqual({
      subject: 'Test Subject',
      from: 'sender@example.com',
      to: 'recipient@example.com', // Should use header, not envelope
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      date: 'Mon, 1 Jan 2024 12:00:00 +0000',
      message_id: '<test@example.com>',
      headers: {
        content_type: 'multipart/alternative',
        received: 'by mail.example.com'
      },
      body,
      raw_content: rawContent
    });
  });

  it('should fallback to envelope recipient when To header is missing', () => {
    const mockHeaders = new MockHeaders({
      'subject': 'Test Subject',
      'date': 'Mon, 1 Jan 2024 12:00:00 +0000'
    }) as unknown as Headers;

    const message = {
      from: 'sender@example.com',
      to: 'envelope@example.com',
      headers: mockHeaders
    };

    const body: EmailBody = {
      text: 'Plain text content'
    };

    const result = createStructuredEmail(message, body, 'raw');

    expect(result.to).toBe('envelope@example.com');
  });

  it('should handle missing optional fields', () => {
    const mockHeaders = new MockHeaders() as unknown as Headers;

    const message = {
      from: 'sender@example.com',
      to: 'recipient@example.com',
      headers: mockHeaders
    };

    const body: EmailBody = {};

    const result = createStructuredEmail(message, body, '');

    expect(result.subject).toBe('');
    expect(result.cc).toBe('');
    expect(result.bcc).toBe('');
    expect(result.date).toBe('');
    expect(result.message_id).toBe('');
    expect(result.headers).toEqual({});
  });

  it('should convert hyphenated headers to snake_case', () => {
    const mockHeaders = new MockHeaders({
      'content-type': 'text/plain',
      'x-custom-header': 'custom-value',
      'message-id': '<test@example.com>'
    }) as unknown as Headers;

    const message = {
      from: 'sender@example.com',
      to: 'recipient@example.com',
      headers: mockHeaders
    };

    const result = createStructuredEmail(message, {}, '');

    expect(result.headers).toEqual({
      content_type: 'text/plain',
      x_custom_header: 'custom-value'
      // message-id should be removed as it's in the top-level field
    });
  });

  it('should handle forwarded email scenario correctly', () => {
    const mockHeaders = new MockHeaders({
      'subject': 'Forwarded Test',
      'to': 'original@example.com',
      'x-forwarded-to': 'staging@example.com',
      'return-path': '<original.sender@gmail.com>'
    }) as unknown as Headers;

    const message = {
      from: 'forwarded@example.com',
      to: 'staging@example.com', // envelope recipient
      headers: mockHeaders
    };

    const result = createStructuredEmail(message, {}, '');

    expect(result.from).toBe('original.sender@gmail.com'); // From return-path
    expect(result.to).toBe('original@example.com'); // From To header
  });
});

describe('updateHeaders', () => {
  it('should convert hyphenated keys to snake_case', () => {
    const headers = {
      'content-type': 'application/json',
      'x-custom-header': 'custom-value',
      'message-id': '<test@example.com>',
      'user-agent': 'Test/1.0'
    };

    const result = updateHeaders(headers, []);

    expect(result).toEqual({
      content_type: 'application/json',
      x_custom_header: 'custom-value',
      message_id: '<test@example.com>',
      user_agent: 'Test/1.0'
    });
  });

  it('should remove specified keys', () => {
    const headers = {
      'subject': 'Test Subject',
      'from': 'sender@example.com',
      'to': 'recipient@example.com',
      'content-type': 'text/plain',
      'date': '2024-01-01'
    };

    const result = updateHeaders(headers, ['subject', 'from', 'to']);

    expect(result).toEqual({
      content_type: 'text/plain',
      date: '2024-01-01'
    });

    expect(result.subject).toBeUndefined();
    expect(result.from).toBeUndefined();
    expect(result.to).toBeUndefined();
  });

  it('should remove keys in both hyphenated and snake_case format', () => {
    const headers = {
      'message-id': '<test@example.com>',
      'content_type': 'text/plain',
      'x-forwarded-to': 'staging@example.com'
    };

    const result = updateHeaders(headers, ['message-id', 'content-type']);

    expect(result).toEqual({
      x_forwarded_to: 'staging@example.com'
    });

    expect(result.message_id).toBeUndefined();
    expect(result.content_type).toBeUndefined();
  });

  it('should handle empty headers object', () => {
    const result = updateHeaders({}, ['any', 'keys']);
    expect(result).toEqual({});
  });

  it('should handle keys that do not exist', () => {
    const headers = {
      'existing-header': 'value'
    };

    const result = updateHeaders(headers, ['non-existent', 'also-missing']);

    expect(result).toEqual({
      existing_header: 'value'
    });
  });

  it('should preserve original headers object (immutability)', () => {
    const headers = {
      'content-type': 'application/json',
      'authorization': 'Bearer token'
    };

    const original = { ...headers };
    const result = updateHeaders(headers, ['authorization']);

    // Original should be unchanged
    expect(headers).toEqual(original);

    // Result should be modified
    expect(result).toEqual({
      content_type: 'application/json'
    });
  });
});

describe('extractDomain', () => {
  it('should extract domain from simple email address', () => {
    expect(extractDomain('user@example.com')).toBe('example.com');
    expect(extractDomain('test@gmail.com')).toBe('gmail.com');
    expect(extractDomain('admin@example.org')).toBe('example.org');
  });

  it('should extract domain from formatted email with angle brackets', () => {
    expect(extractDomain('"John Doe" <john@example.com>')).toBe('example.com');
    expect(extractDomain('Jane Smith <jane@example.com>')).toBe('example.com');
    expect(extractDomain('"Test User" <test.user@gmail.com>')).toBe('gmail.com');
  });

  it('should handle email with just angle brackets', () => {
    expect(extractDomain('<user@example.com>')).toBe('example.com');
    expect(extractDomain('<admin@test.org>')).toBe('test.org');
  });

  it('should return empty string for invalid email formats', () => {
    expect(extractDomain('')).toBe('');
    expect(extractDomain('invalid')).toBe('');
    expect(extractDomain('no-at-sign.com')).toBe('');
    expect(extractDomain('@domain.com')).toBe('domain.com');
  });

  it('should handle complex email formats', () => {
    expect(extractDomain('user+tag@example.com')).toBe('example.com');
    expect(extractDomain('user+tag=filter@example.com')).toBe('example.com');
  });
});