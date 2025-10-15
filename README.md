# 📧 Email Forwarder

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Test Suite](https://github.com/connve-dev/email-forwarder/actions/workflows/test.yml/badge.svg)](https://github.com/connve-dev/email-forwarder/actions/workflows/test.yml)
[![Security Audit](https://github.com/connve-dev/email-forwarder/actions/workflows/security.yml/badge.svg)](https://github.com/connve-dev/email-forwarder/actions/workflows/security.yml)
[![Release](https://img.shields.io/github/v/release/connve-dev/email-forwarder)](https://github.com/connve-dev/email-forwarder/releases)

Simple Cloudflare Workers email forwarder that parses incoming emails and sends them to a webhook endpoint. Designed to be copied for each client deployment with advanced forwarding detection and domain filtering.

## 🏗️ Repository Structure

```
├── src/
│   ├── index.ts              # Main email worker + scheduled retry processor
│   ├── email-message.ts      # Email parsing, types & utilities
│   ├── email-message.test.ts # Email parsing tests
│   ├── retry.ts              # Retry logic with exponential backoff
│   └── retry.test.ts         # Retry mechanism tests
├── package.json
├── package-lock.json
├── tsconfig.json             # TypeScript configuration
├── vitest.config.ts          # Test configuration
├── worker-configuration.d.ts # Worker types
├── wrangler.toml             # Wrangler configuration
├── .gitignore
└── README.md
```

## ✨ Features

- 📨 Parses multipart email content (text, HTML, headers)
- 🔗 Forwards to webhook with Bearer token authentication
- 🔁 **Automatic retry with exponential backoff** for failed webhook requests
- ⚡ Circuit breaker pattern (max 10 attempts over ~15 hours)
- 🚫 Domain filtering (block spam domains, filter internal emails)
- 📧 Auto-forwarded email detection with original sender extraction
- 🔄 Handles BCC, CC, and complex email routing scenarios
- 🐍 JSON output with consistent snake_case fields
- 🧪 Comprehensive test coverage (40+ tests)

## ⚙️ Configuration

### 🔐 Environment Variables
Set via `wrangler secret put` or Cloudflare Dashboard:

- `HTTP_WEBHOOK_URL` - Webhook endpoint for email forwarding
- `HTTP_WEBHOOK_API_TOKEN` - Bearer token for webhook authentication

### 🔁 Retry Queue (Required)
Create KV namespace for failed request retries:
```bash
wrangler kv:namespace create "RETRY_QUEUE"
```

Add to `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "RETRY_QUEUE"
id = "your-retry-queue-namespace-id"

# Cron trigger runs every minute to process retry queue
[triggers]
crons = ["* * * * *"]
```

**How Cron Works**: Cloudflare automatically invokes the `scheduled()` handler in your worker at the specified interval. The same worker handles both incoming emails (via the `email()` handler) and retry processing (via the `scheduled()` handler). No separate deployment needed - it's all one worker with multiple entry points.

### 🛡️ Domain Filtering (Optional)
Create KV namespace:
```bash
wrangler kv:namespace create "DOMAIN_FILTER"
```

Add to `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "DOMAIN_FILTER"
id = "your-domain-filter-namespace-id"
```

Set filter rules:
```bash
# Block spam domains
wrangler kv:key put --binding=DOMAIN_FILTER "blocked:spam.com" "true"

# Internal domains (both from/to = dropped to prevent loops)
wrangler kv:key put --binding=DOMAIN_FILTER "internal:yourcompany.com" "true"
```

## 🚀 Deployment

### 👥 Per-Client (Recommended)
1. Fork/copy repository for each client
2. Update `wrangler.toml`:
   - Set unique worker `name`
   - Add `workers_dev = false` to disable workers.dev subdomain
   - Configure KV namespace ID if using domain filtering
3. Configure environment variables (`HTTP_WEBHOOK_URL`, `HTTP_WEBHOOK_API_TOKEN`)
4. Optionally set up `DOMAIN_FILTER` KV namespace for spam/internal filtering
5. Deploy: `wrangler deploy`
6. In Cloudflare Dashboard → Email Routing → Routing Rules, add rule to forward emails to this worker

### 🔨 Manual Deployment
```bash
wrangler deploy
```

## 📋 Email Output Format

The worker outputs structured JSON with snake_case field names:

```json
{
  "subject": "Email Subject",
  "from": "sender@example.com",
  "to": "recipient@example.com",
  "cc": "cc@example.com",
  "bcc": "bcc@example.com",
  "date": "Mon, 1 Jan 2024 12:00:00 +0000",
  "message_id": "<message-id>",
  "headers": {
    "content_type": "multipart/alternative",
    "x_custom_header": "value"
  },
  "body": {
    "text": "Plain text version",
    "html": "<html>HTML version</html>"
  },
  "raw_content": "Complete raw email content..."
}
```

### 🔍 Special Handling
- **Auto-forwarded emails**: Extracts original sender from `Return-Path` header
- **BCC scenarios**: Correctly separates original recipient from BCC recipient
- **Headers**: Converts hyphenated headers to snake_case, removes duplicates
- **Internal filtering**: Prevents email loops by dropping internal-to-internal emails

## 🧪 Development & Testing

### Install & Run
```bash
npm install
npx wrangler dev
```

### Testing
```bash
# Run all tests
npm test

# Run tests with UI
npm run test:ui
```

### Environment
Set environment variables via `.env` file for local development:
```env
HTTP_WEBHOOK_URL=https://your-webhook-endpoint.com/api/emails
HTTP_WEBHOOK_API_TOKEN=your-bearer-token
```

## 🎯 Use Cases

Perfect for:
- 📬 Customer support email routing
- 🤖 Email-to-webhook integrations
- 📊 Email analytics and processing
- 🔄 Multi-tenant email forwarding
- 🛡️ Spam filtering and email security

## 📄 License

This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

## 🔁 Retry Mechanism

### How It Works

When a webhook request fails (network error, timeout, non-2xx status):
1. Email is automatically saved to `RETRY_QUEUE` KV namespace
2. Retry scheduled with exponential backoff starting at 1 minute
3. Cron trigger (`scheduled()` handler) runs every minute to process pending retries
4. Uses current `HTTP_WEBHOOK_URL` and `HTTP_WEBHOOK_API_TOKEN` from environment

### Retry Schedule

**Exponential Backoff**: 1min → 2min → 4min → 8min → 16min → 32min → 1hr → 2hr → 4hr → 8hr

**Circuit Breaker**: After 10 failed attempts (~15 hours total), requests are permanently failed and moved to dead letter queue (`failed:*` prefix)

**Why 1-minute minimum?** Cloudflare Workers cron triggers have a minimum interval of 1 minute, so the retry schedule is designed to match this limitation.

### Security & Credentials

- ✅ **No credentials stored in KV** - only email data
- ✅ All retries use current environment variables
- ✅ Rotating credentials automatically applies to pending retries

### Monitoring

View retry queue:
```bash
# List pending retries
wrangler kv:key list --binding RETRY_QUEUE --prefix "retry:"

# List permanently failed requests (dead letter queue)
wrangler kv:key list --binding RETRY_QUEUE --prefix "failed:"

# View specific retry
wrangler kv:key get --binding RETRY_QUEUE "retry:{timestamp}:{id}"

# Watch logs
wrangler tail
```

Key log messages:
- `Saved failed request {id} for retry in {delay}m` - Initial failure saved
- `Processing {count} retry requests` - Cron processing batch
- `Request {id} succeeded after {attempts} attempts` - Successful retry
- `Request {id} permanently failed after 10 attempts` - Moved to dead letter queue

### Manual Recovery

To manually retry a permanently failed request:
```bash
# Get the failed request data
wrangler kv:key get --binding RETRY_QUEUE "failed:{timestamp}:{id}" > failed-email.json

# Delete from dead letter queue
wrangler kv:key delete --binding RETRY_QUEUE "failed:{timestamp}:{id}"

# POST manually to your webhook or fix issue and recreate as retry entry
```

