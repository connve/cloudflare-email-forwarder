import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateRetryDelay,
  generateRequestId,
  saveFailedRequest,
  updateFailedRequest,
  getRetryableRequests,
  retryFailedRequest,
  MAX_RETRY_ATTEMPTS,
  type FailedRequest
} from './retry';
import type { StructuredEmail } from './email-message';

// Mock KV namespace for testing
class MockKVNamespace {
  private store = new Map<string, string>();

  async get(key: string, type?: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }>, list_complete: boolean, cacheStatus: null }> {
    const keys = Array.from(this.store.keys())
      .filter(key => !options?.prefix || key.startsWith(options.prefix))
      .slice(0, options?.limit || 1000)
      .map(name => ({ name }));
    return { keys, list_complete: true, cacheStatus: null };
  }

  async getWithMetadata(): Promise<any> {
    throw new Error('Not implemented');
  }
}

describe('calculateRetryDelay', () => {
  it('should start with 1 minute (60 seconds) for first retry', () => {
    expect(calculateRetryDelay(0)).toBe(60);
  });

  it('should double the delay exponentially', () => {
    expect(calculateRetryDelay(1)).toBe(120);   // 2 minutes
    expect(calculateRetryDelay(2)).toBe(240);   // 4 minutes
    expect(calculateRetryDelay(3)).toBe(480);   // 8 minutes
    expect(calculateRetryDelay(4)).toBe(960);   // 16 minutes
    expect(calculateRetryDelay(5)).toBe(1920);  // 32 minutes
    expect(calculateRetryDelay(6)).toBe(3840);  // 64 minutes / ~1 hour
    expect(calculateRetryDelay(7)).toBe(7680);  // ~2 hours
    expect(calculateRetryDelay(8)).toBe(15360); // ~4 hours
    expect(calculateRetryDelay(9)).toBe(30720); // ~8 hours
  });

  it('should continue exponentially without cap', () => {
    expect(calculateRetryDelay(10)).toBe(61440); // ~16 hours
    expect(calculateRetryDelay(15)).toBe(1966080); // ~22 days
  });
});

describe('generateRequestId', () => {
  it('should generate unique IDs', () => {
    const id1 = generateRequestId();
    const id2 = generateRequestId();
    expect(id1).not.toBe(id2);
  });

  it('should include timestamp', () => {
    const id = generateRequestId();
    const timestamp = id.split('-')[0];
    expect(Number(timestamp)).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('saveFailedRequest', () => {
  let kv: MockKVNamespace;
  let mockEmail: StructuredEmail;

  beforeEach(() => {
    kv = new MockKVNamespace();
    mockEmail = {
      subject: 'Test Subject',
      from: { name: 'Sender Name', email: 'sender@example.com' },
      to: [{ name: 'Recipient Name', email: 'recipient@example.com' }],
      date: '2024-01-01',
      message_id: '<test@example.com>',
      headers: {},
      body: { text: 'Test body' },
      raw_content: 'Raw email content'
    };
  });

  it('should save a failed request to KV', async () => {
    const requestId = await saveFailedRequest(kv as any, mockEmail, 'Test error');

    expect(requestId).toBeDefined();

    const keys = await kv.list({ prefix: 'retry:' });
    expect(keys.keys.length).toBe(1);
  });

  it('should set initial attempt count to 0', async () => {
    await saveFailedRequest(kv as any, mockEmail);
    const keys = await kv.list({ prefix: 'retry:' });
    const value = await kv.get(keys.keys[0].name);
    const request = JSON.parse(value!) as FailedRequest;

    expect(request.attemptCount).toBe(0);
  });

  it('should calculate next retry timestamp with 1 minute delay', async () => {
    const now = Date.now();
    await saveFailedRequest(kv as any, mockEmail);

    const keys = await kv.list({ prefix: 'retry:' });
    const value = await kv.get(keys.keys[0].name);
    const request = JSON.parse(value!) as FailedRequest;

    // Should be approximately 60 seconds (1 minute) in the future
    expect(request.nextRetryTimestamp).toBeGreaterThan(now + 59000);
    expect(request.nextRetryTimestamp).toBeLessThan(now + 61000);
  });
});

describe('updateFailedRequest', () => {
  let kv: MockKVNamespace;
  let mockRequest: FailedRequest;

  beforeEach(() => {
    kv = new MockKVNamespace();
    mockRequest = {
      id: 'test-123',
      email: {
        subject: 'Test',
        from: { name: 'Sender', email: 'sender@example.com' },
        to: [{ name: 'Recipient', email: 'recipient@example.com' }],
        date: '2024-01-01',
        message_id: '<test@example.com>',
        headers: {},
        body: { text: 'Test' },
        raw_content: 'Raw'
      },
      attemptCount: 0,
      firstAttemptTimestamp: Date.now(),
      lastAttemptTimestamp: Date.now(),
      nextRetryTimestamp: Date.now() + 5000
    };
  });

  it('should delete request on success', async () => {
    const key = 'retry:123456:test-123';
    await kv.put(key, JSON.stringify(mockRequest));

    await updateFailedRequest(kv as any, key, mockRequest, true);

    const value = await kv.get(key);
    expect(value).toBeNull();

    // Should not create a new retry entry
    const keys = await kv.list({ prefix: 'retry:' });
    expect(keys.keys.length).toBe(0);
  });

  it('should increment attempt count on failure', async () => {
    const key = 'retry:123456:test-123';
    await kv.put(key, JSON.stringify(mockRequest));

    await updateFailedRequest(kv as any, key, mockRequest, false, 'New error');

    const keys = await kv.list({ prefix: 'retry:' });
    expect(keys.keys.length).toBe(1);

    const value = await kv.get(keys.keys[0].name);
    const updated = JSON.parse(value!) as FailedRequest;

    expect(updated.attemptCount).toBe(1);
    expect(updated.lastError).toBe('New error');
  });

  it('should move to dead letter queue after max attempts (10)', async () => {
    const key = 'retry:123456:test-123';
    mockRequest.attemptCount = MAX_RETRY_ATTEMPTS - 1; // 9
    await kv.put(key, JSON.stringify(mockRequest));

    await updateFailedRequest(kv as any, key, mockRequest, false, 'Final error');

    // Should not have retry: key anymore
    const retryKeys = await kv.list({ prefix: 'retry:' });
    expect(retryKeys.keys.length).toBe(0);

    // Should have failed: key
    const failedKeys = await kv.list({ prefix: 'failed:' });
    expect(failedKeys.keys.length).toBe(1);

    const value = await kv.get(failedKeys.keys[0].name);
    const failed = JSON.parse(value!);
    expect(failed.permanentlyFailed).toBe(true);
  });

  it('should calculate exponential backoff delay', async () => {
    const key = 'retry:123456:test-123';
    await kv.put(key, JSON.stringify(mockRequest));

    await updateFailedRequest(kv as any, key, mockRequest, false);

    const keys = await kv.list({ prefix: 'retry:' });
    const value = await kv.get(keys.keys[0].name);
    const updated = JSON.parse(value!) as FailedRequest;

    const expectedDelay = calculateRetryDelay(1) * 1000;
    const actualDelay = updated.nextRetryTimestamp - updated.lastAttemptTimestamp;

    // Allow 100ms tolerance
    expect(actualDelay).toBeGreaterThanOrEqual(expectedDelay - 100);
    expect(actualDelay).toBeLessThanOrEqual(expectedDelay + 100);
  });
});

describe('getRetryableRequests', () => {
  let kv: MockKVNamespace;

  beforeEach(() => {
    kv = new MockKVNamespace();
  });

  it('should return requests ready for retry', async () => {
    const pastTimestamp = Date.now() - 10000;
    const futureTimestamp = Date.now() + 10000;

    const pastRequest: FailedRequest = {
      id: 'past',
      email: {} as StructuredEmail,
      attemptCount: 0,
      firstAttemptTimestamp: Date.now(),
      lastAttemptTimestamp: Date.now(),
      nextRetryTimestamp: pastTimestamp
    };

    const futureRequest: FailedRequest = {
      id: 'future',
      email: {} as StructuredEmail,
      attemptCount: 0,
      firstAttemptTimestamp: Date.now(),
      lastAttemptTimestamp: Date.now(),
      nextRetryTimestamp: futureTimestamp
    };

    await kv.put(`retry:${pastTimestamp}:past`, JSON.stringify(pastRequest));
    await kv.put(`retry:${futureTimestamp}:future`, JSON.stringify(futureRequest));

    const results = await getRetryableRequests(kv as any);

    expect(results.length).toBe(1);
    expect(results[0].request.id).toBe('past');
  });

  it('should respect limit parameter', async () => {
    const now = Date.now() - 1000;

    for (let i = 0; i < 5; i++) {
      const request: FailedRequest = {
        id: `request-${i}`,
        email: {} as StructuredEmail,
        attemptCount: 0,
        firstAttemptTimestamp: now,
        lastAttemptTimestamp: now,
        nextRetryTimestamp: now
      };
      await kv.put(`retry:${now}:request-${i}`, JSON.stringify(request));
    }

    const results = await getRetryableRequests(kv as any, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

describe('retryFailedRequest', () => {
  let mockRequest: FailedRequest;

  beforeEach(() => {
    mockRequest = {
      id: 'test-123',
      email: {
        subject: 'Test',
        from: { name: 'Sender', email: 'sender@example.com' },
        to: [{ name: 'Recipient', email: 'recipient@example.com' }],
        date: '2024-01-01',
        message_id: '<test@example.com>',
        headers: {},
        body: { text: 'Test' },
        raw_content: 'Raw'
      },
      attemptCount: 0,
      firstAttemptTimestamp: Date.now(),
      lastAttemptTimestamp: Date.now(),
      nextRetryTimestamp: Date.now()
    };
  });

  it('should return success for successful retry', async () => {
    // Mock successful fetch
    globalThis.fetch = async () => ({
      ok: true,
      status: 200
    }) as Response;

    const result = await retryFailedRequest(mockRequest, 'https://webhook.example.com', 'token123');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return failure for non-200 status', async () => {
    // Mock failed fetch
    globalThis.fetch = async () => ({
      ok: false,
      status: 500
    }) as Response;

    const result = await retryFailedRequest(mockRequest, 'https://webhook.example.com', 'token123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });

  it('should return failure for network error', async () => {
    // Mock network error
    globalThis.fetch = async () => {
      throw new Error('Network error');
    };

    const result = await retryFailedRequest(mockRequest, 'https://webhook.example.com', 'token123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });
});
