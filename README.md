# Cloudflare Resources

This repository contains all Cloudflare infrastructure resources and configurations for our organization. It serves as a centralized hub for managing Cloudflare Workers, KV stores, and other Cloudflare services.

## 🏗️ Repository Structure

```
cloudflare/
├── workers/                    # Cloudflare Workers
│   └── email-forwarder/       # Email forwarding worker with multi-client support
└── .github/                   # CI/CD workflows
    └── workflows/
        └── deploy.yaml        # Automated deployment pipeline
```

## 🚀 Workers

### Email Forwarder
A sophisticated email forwarding worker that supports multiple clients through domain-based routing.

**Features:**
- 📧 Multi-client email forwarding based on domain matching
- 🔐 Secure authentication using Cloudflare Workers Secrets
- 📊 Structured email parsing (text, HTML, headers)
- ⚡ Dynamic configuration via KV store
- 🔄 Automatic webhook forwarding

**Location:** `workers/email-forwarder/`

## 🔧 Configuration

### KV Stores
- **EMAIL_ROUTING**: Domain-based routing configuration

### Secrets
- Domain-specific authentication tokens (e.g., `ORTOFAN_API_TOKEN`)

## 🚀 Deployment

Deployments are automated through GitHub Actions when changes are pushed to the `main` branch.

### Required Secrets
Configure these secrets in your GitHub repository:
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID
- `CLOUDFLARE_ACCOUNT_TOKEN`: API token with Workers deployment permissions

## 📚 Documentation

The email-forwarder worker contains detailed documentation in its directory.

## 🔒 Security

- All authentication tokens are stored securely in Cloudflare Workers Secrets
- API communications use Bearer token authentication
- Email content is parsed and structured before forwarding
- Domain-based routing ensures proper client isolation

## 🛠️ Development

### Prerequisites
- Node.js 18+
- Wrangler CLI
- Access to Cloudflare account

### Local Development
```bash
# Navigate to worker directory
cd workers/email-forwarder

# Install dependencies
npm install

# Start local development server
npx wrangler dev
```