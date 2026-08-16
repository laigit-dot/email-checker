import { describe, expect, it } from "vitest";

import { parseAllowedEmailUrl } from "./openEmail";

describe("parseAllowedEmailUrl", () => {
  it.each([
    "https://mail.google.com/mail/u/0/#inbox/message",
    "https://outlook.office.com/mail/inbox/id/example",
    "https://outlook.office365.com/mail/",
    "https://outlook.live.com/mail/0/inbox",
  ])("allows known HTTPS email hosts: %s", (url) => {
    expect(parseAllowedEmailUrl(url)?.toString()).toBe(url);
  });

  it.each([
    "http://mail.google.com/mail/",
    "https://mail.google.com.example.com/mail/",
    "https://evil.example/outlook.office.com",
    "https://gmail.com/mail/",
    "javascript:alert(1)",
    "not a url",
  ])("rejects non-HTTPS or non-allowlisted URLs: %s", (url) => {
    expect(parseAllowedEmailUrl(url)).toBeNull();
  });
});
