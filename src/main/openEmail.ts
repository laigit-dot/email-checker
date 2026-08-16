const ALLOWED_EMAIL_HOSTS = new Set([
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
]);

export function parseAllowedEmailUrl(value: string): URL | null {
  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      !ALLOWED_EMAIL_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}
