import type { EmailRecord } from "../shared/contracts.js";

export interface EmailNotificationContent {
  title: string;
  body: string;
}

export function emailIdentity(email: EmailRecord): string {
  return `${email.provider}\u0000${email.accountId}\u0000${email.id}`;
}

export function findNewEmails(
  emails: readonly EmailRecord[],
  knownIds: Set<string>,
): EmailRecord[] {
  const newEmails = emails.filter(
    (email) => !knownIds.has(emailIdentity(email)),
  );
  for (const email of emails) {
    knownIds.add(emailIdentity(email));
  }
  return newEmails;
}

export function createEmailNotification(
  emails: readonly EmailRecord[],
): EmailNotificationContent {
  if (emails.length === 1) {
    const email = emails[0]!;
    return {
      title: "New email processed",
      body: `${email.sender} · ${email.subject}`,
    };
  }

  const details: string[] = [];
  const urgent = emails.filter((email) => email.status.urgent).length;
  const failed = emails.filter((email) => email.status.failed).length;
  if (urgent > 0) {
    details.push(`${urgent} urgent`);
  }
  if (failed > 0) {
    details.push(`${failed} needs attention`);
  }

  return {
    title: `${emails.length} new emails processed`,
    body:
      details.length > 0
        ? details.join(" · ")
        : "Your inbox activity has been updated.",
  };
}
