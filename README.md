# Cloudflare Email Forwarder

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Test Suite](https://github.com/connve-dev/email-forwarder/actions/workflows/test.yml/badge.svg)](https://github.com/connve-dev/email-forwarder/actions/workflows/test.yml)
[![Security Audit](https://github.com/connve-dev/email-forwarder/actions/workflows/security.yml/badge.svg)](https://github.com/connve-dev/email-forwarder/actions/workflows/security.yml)
[![Release](https://img.shields.io/github/v/release/connve-dev/email-forwarder)](https://github.com/connve-dev/email-forwarder/releases)

Cloudflare Workers email forwarder that parses incoming emails and sends them to a webhook endpoint.

## Repository Structure

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
├── wrangler.toml .example    # Wrangler configuration example
├── .gitignore
└── README.md
```

## Features

- Parses multipart email content (text, HTML, headers)
- Forwards to webhook with Bearer token authentication
- Optional automatic retry with exponential backoff for failed requests
- Optional domain filtering (block spam domains, prevent internal email loops)
- Auto-forwarded email detection with original sender extraction
- Handles BCC, CC, and complex email routing

## Configuration

### Environment Variables

Required. Set via `wrangler secret put` or Cloudflare Dashboard:

- `HTTP_WEBHOOK_URL` - Webhook endpoint for email forwarding
- `HTTP_WEBHOOK_API_TOKEN` - Bearer token for webhook authentication

### Retry Queue (Optional)

Without retry queue, failed webhook requests are logged but not retried. Recommended for production.

To enable automatic retry with exponential backoff:
```bash
wrangler kv:namespace create "RETRY_QUEUE"
```

Add to `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "RETRY_QUEUE"
id = "your-namespace-id"

[triggers]
crons = ["* * * * *"]
```

### Domain Filtering (Optional)

Block spam domains or prevent internal email loops.
```bash
wrangler kv:namespace create "DOMAIN_FILTER"
```

Add to `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "DOMAIN_FILTER"
id = "your-namespace-id"
```

Configure rules:
```bash
# Block spam domains
wrangler kv:key put --binding=DOMAIN_FILTER "blocked:spam.com" "true"

# Internal domains (both from/to = dropped to prevent loops)
wrangler kv:key put --binding=DOMAIN_FILTER "internal:yourcompany.com" "true"
```

## Deployment

1. Add repository as github submodule
2. Configure `wrangler.toml`:
   - Set unique worker `name`
   - Add `workers_dev = false` to disable workers.dev subdomain
   - Add `RETRY_QUEUE` KV namespace (optional, recommended for production)
   - Add `DOMAIN_FILTER` KV namespace (optional)
3. Set environment variables: `HTTP_WEBHOOK_URL`, `HTTP_WEBHOOK_API_TOKEN`
4. Deploy: `wrangler deploy`
5. Configure Email Routing in Cloudflare Dashboard to forward to this worker

## Email Output Format

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

### Special Handling
- Auto-forwarded emails: Extracts original sender from `Return-Path` header
- BCC scenarios: Separates original recipient from BCC recipient
- Headers: Converts hyphenated headers to snake_case
- Internal filtering: Drops internal-to-internal emails when configured

## Retry Mechanism

When webhook delivery fails, the email is saved to `RETRY_QUEUE` and retried with exponential backoff:

**Schedule**: 1m → 2m → 4m → 8m → 16m → 32m → 1h → 2h → 4h → 8h

After 10 attempts (~15 hours), requests move to dead letter queue (`failed:*` prefix).

Retries use current environment variables, so credential rotation applies automatically.

### Monitoring

```bash
# List pending retries
wrangler kv:key list --binding RETRY_QUEUE --prefix "retry:"

# List failed requests (dead letter queue)
wrangler kv:key list --binding RETRY_QUEUE --prefix "failed:"

# View specific retry
wrangler kv:key get --binding RETRY_QUEUE "retry:{timestamp}:{id}"

# Watch logs
wrangler tail
```


## Development

```bash
npm install
npx wrangler dev
npm test
```

Local environment variables can be set via `.env` file.

## Contributing

Enable pre-commit hooks:
```bash
git config core.hooksPath .githooks
```

Hooks run tests, TypeScript checks, lint, and security audits before each commit.

## License

This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
