# Email Forwarder

Simple Cloudflare Workers email forwarder that parses incoming emails and sends them to a webhook endpoint. Designed to be copied for each client deployment.

## Repository Structure

```
├── src/
│   ├── index.ts              # Main email worker
│   ├── email-message.ts      # Email parsing and types
│   └── utils.ts              # Utility functions
├── package.json
├── package-lock.json
├── tsconfig.json             # TypeScript configuration
├── worker-configuration.d.ts # Worker types
├── wrangler.toml             # Wrangler configuration
├── .gitignore
└── README.md
```

## Features

- Parses email content (text, HTML, headers)
- Forwards to webhook with Bearer token auth
- Domain filtering (block domains, filter internal emails)
- JSON output with snake_case fields

## Configuration

### Environment Variables
Set via `wrangler secret put` or Cloudflare Dashboard:

- `HTTP_WEBHOOK_URL` - Webhook endpoint
- `HTTP_WEBHOOK_API_TOKEN` - Bearer token

### Domain Filtering (Optional)
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
# Block domains
wrangler kv:key put --binding=DOMAIN_FILTER "blocked:spam.com" "true"

# Internal domains (both from/to = dropped)
wrangler kv:key put --binding=DOMAIN_FILTER "internal:company.com" "true"
```

## Deployment

### Per-Client (Recommended)
1. Copy repository for each client
2. Update `wrangler.toml`:
   - Set unique worker `name`
   - Add `workers_dev = false` to disable workers.dev subdomain
   - Configure KV namespace ID if using domain filtering
3. Configure environment variables (`HTTP_WEBHOOK_URL`, `HTTP_WEBHOOK_API_TOKEN`)
4. Optionally set up `DOMAIN_FILTER` KV namespace
5. Deploy: `wrangler deploy`
6. In Cloudflare Dashboard → Email Routing → Routing Rules, add rule to forward emails to this worker

### Manual Deployment
```bash
wrangler deploy
```

## Email Output

JSON format:
```json
{
  "subject": "Email Subject",
  "from": "sender@example.com",
  "to": "recipient@example.com",
  "date": "Mon, 1 Jan 2024 12:00:00 +0000",
  "message_id": "<message-id>",
  "headers": { "content_type": "...", ... },
  "body": {
    "text": "Plain text version",
    "html": "<html>HTML version</html>"
  },
  "raw_content": "Complete raw email..."
}
```

## Development

```bash
npm install
npx wrangler dev
```

Set environment variables via `.env` file for local development.