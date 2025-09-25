# 📧 Email Forwarder

Simple Cloudflare Workers email forwarder that parses incoming emails and sends them to a webhook endpoint. Designed to be copied for each client deployment with advanced forwarding detection and domain filtering.

## 🏗️ Repository Structure

```
├── src/
│   ├── index.ts              # Main email worker
│   ├── email-message.ts      # Email parsing, types & utilities
│   └── email-message.test.ts # Comprehensive test suite
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
- 🚫 Domain filtering (block spam domains, filter internal emails)
- 📧 Auto-forwarded email detection with original sender extraction
- 🔄 Handles BCC, CC, and complex email routing scenarios
- 🐍 JSON output with consistent snake_case fields
- 🧪 Comprehensive test coverage (25+ tests)

## ⚙️ Configuration

### 🔐 Environment Variables
Set via `wrangler secret put` or Cloudflare Dashboard:

- `HTTP_WEBHOOK_URL` - Webhook endpoint for email forwarding
- `HTTP_WEBHOOK_API_TOKEN` - Bearer token for webhook authentication

### 🛡️ Domain Filtering (Optional)
Create KV namespace:
```bash
wrangler kv:namespace create "DOMAIN_FILTER"
```

Add to `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "DOMAIN_FILTER"
id = "your-namespace-id"
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