/**
 * Extracts the domain from an email address.
 * Returns the domain part after the @ symbol (e.g., "user@example.com" → "example.com").
 */
export function extractDomain(email: string): string {
  return email.split('@')[1] || '';
}