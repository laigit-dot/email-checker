import { z } from "zod";

import type { FolderRule, OrganizerSettings } from "../../shared/contracts.js";
import { readJsonFile, writeJsonAtomic } from "./atomicJson.js";

export const DEFAULT_FOLDER_RULES: FolderRule[] = [
  {
    name: "Security Code",
    prompt:
      'One-time passwords, verification or security codes, "confirm your identity", "verify your email", 2FA/MFA, or a code needed to open an application or interview portal. Always urgent. Never copy the code into the summary.',
  },
  {
    name: "Availability",
    prompt:
      'The sender asks the candidate to propose times, pick a booking slot, or reschedule, and a reply or action is expected from the candidate. Includes requests for interview availability, "book a time", "are you available", and calendar-booking links with no confirmed time yet. Do not use this folder if scheduling is already underway, an invite will follow, or no action is needed from the candidate yet \u2014 use Recruiter or Confirmation instead. Always urgent.',
  },
  {
    name: "Screening Question",
    prompt:
      "The candidate must complete questions, a form, an assessment, a coding or take-home exercise, HireVue/Hireflix/HackerRank, or finish an incomplete application. Always urgent.",
  },
  {
    name: "Interview",
    prompt:
      'A meeting time is already set. Includes interview confirmations, calendar invites, join/video links, reminders, and "starting in 10 mins" notices. If the email both confirms a time and asks to reschedule, use Availability instead. Always urgent.',
  },
  {
    name: "Background Check",
    prompt:
      "Checkr, drug screen, I-9, employment verification, or similar vetting checks that happen before a hiring decision is final. If the same kind of paperwork shows up after an offer has been extended or accepted, use Offer instead, even if the vendor or wording looks similar. Always urgent.",
  },
  {
    name: "Offer",
    prompt:
      "Offer letter, compensation or start-date confirmation, a DocuSign/signature request, or any onboarding step (welcome emails, benefits enrollment, new-hire paperwork, first-day instructions) after an offer was made or accepted. Always urgent.",
  },
  {
    name: "Confirmation",
    prompt:
      'The application was received or is under review, with no rejection and no action requested from any folder above. Typical phrasing: "we received your application", "thank you for applying" with no negative decision. Not urgent.',
  },
  {
    name: "Rejection",
    prompt:
      'The company is not moving forward. Look for phrases like "unfortunately", "not moving forward", "other candidates", "position filled", "not selected", "after careful consideration", or "pursued other applicants". "Thank you for applying" plus any of these phrases belongs here, not Confirmation, even if softly worded. Not urgent.',
  },
  {
    name: "Job Alert",
    prompt:
      'Automated job-board or ATS match emails (new jobs, recommended jobs, "you\'re a match"), not from a human recruiter and not about one application already submitted. Not urgent.',
  },
  {
    name: "Recruiter",
    prompt:
      "A person or agency reaching out about a role, asking if the candidate is interested, following up on a profile, or giving a status update that doesn't require the candidate's input right now. Not a job-board alert, not a scheduled interview, and not an active availability request. Not urgent unless they ask for a reply the same day.",
  },
  {
    name: "News",
    prompt:
      "Newsletters, webinars, product/HR marketing, community digests, or other bulk content not tied to one live application. Not urgent.",
  },
  {
    name: "Failed Email",
    prompt:
      "Bounce, undeliverable, mailer-daemon, delivery failure, or invalid-address notices. Always urgent.",
  },
  {
    name: "Everything Else",
    prompt:
      "Clearly none of the folders above (terms of use, out-of-office, privacy notices, unrelated personal or financial mail). Use only when confident. Not urgent.",
  },
  {
    name: "Review",
    prompt:
      "Use when the folder is uncertain, two folders fit equally, or Confirmation vs Rejection cannot be decided from the preview.",
  },
];

export const DEFAULT_ORGANIZER_SETTINGS: OrganizerSettings = Object.freeze({
  aiProvider: "ollama",
  ollamaUrl: "http://127.0.0.1:11434",
  model: "qwen3:8b",
  selectedAccountIds: [],
  folders: DEFAULT_FOLDER_RULES,
  rootFolder: "AI Organized",
  confidenceThreshold: 0.65,
  scanLimit: 25,
  dryRun: true,
  markAsRead: false,
  unreadOnly: true,
  activeHours: { start: "07:30", end: "23:30" },
  backupPollMinutes: 30,
  relayBaseUrl: "",
  azureClientId: "",
  azureTenantId: "organizations",
  googleClientId: "",
  googlePubSubTopic: "",
});

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour HH:MM time.");

const endpointSchema = z.string().refine((value) => {
  if (value === "") {
    return true;
  }

  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    return url.protocol === "https:" || (loopback && url.protocol === "http:");
  } catch {
    return false;
  }
}, "Endpoint must use HTTPS unless it is loopback.");

const folderRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const organizerSettingsSchema = z
  .object({
    aiProvider: z.enum(["ollama", "openrouter"]),
    ollamaUrl: endpointSchema,
    model: z.string().trim().min(1),
    selectedAccountIds: z.array(z.string().trim().min(1)),
    folders: z
      .array(folderRuleSchema)
      .min(1)
      .refine(
        (folders) =>
          new Set(folders.map((folder) => folder.name.toLowerCase())).size ===
          folders.length,
        { message: "Folder names must be unique." },
      )
      .refine(
        (folders) =>
          folders.some((folder) => folder.name.toLowerCase() === "review"),
        { message: "Organizer folders must include a Review folder." },
      ),
    rootFolder: z.string().trim().min(1).max(100),
    confidenceThreshold: z.number().finite().min(0).max(1),
    scanLimit: z.number().int().min(1).max(500),
    dryRun: z.boolean(),
    markAsRead: z.boolean(),
    unreadOnly: z.boolean(),
    activeHours: z
      .object({ start: timeSchema, end: timeSchema })
      .strict(),
    backupPollMinutes: z.number().int().min(5).max(1_440),
    relayBaseUrl: endpointSchema,
    azureClientId: z.string().trim().max(200),
    azureTenantId: z.string().trim().min(1).max(200),
    googleClientId: z.string().trim().max(300),
    googlePubSubTopic: z.string().trim().max(500),
  })
  .strict();

function copyDefaults(): OrganizerSettings {
  return {
    ...DEFAULT_ORGANIZER_SETTINGS,
    selectedAccountIds: [...DEFAULT_ORGANIZER_SETTINGS.selectedAccountIds],
    folders: DEFAULT_ORGANIZER_SETTINGS.folders.map((folder) => ({ ...folder })),
    activeHours: { ...DEFAULT_ORGANIZER_SETTINGS.activeHours },
  };
}

function migrateSettings(value: unknown): OrganizerSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return copyDefaults();
  }

  const source = value as Record<string, unknown>;
  const migrated = copyDefaults();
  const shape = organizerSettingsSchema.shape;

  for (const key of Object.keys(shape) as Array<keyof OrganizerSettings>) {
    if (!(key in source)) {
      continue;
    }

    const parsed = shape[key].safeParse(source[key]);
    if (parsed.success) {
      Object.assign(migrated, { [key]: parsed.data });
    }
  }

  return organizerSettingsSchema.parse(migrated);
}

export class JsonSettingsStore {
  public constructor(private readonly path: string) {}

  public async load(): Promise<OrganizerSettings> {
    try {
      return migrateSettings(await readJsonFile(this.path));
    } catch {
      return copyDefaults();
    }
  }

  public async save(settings: OrganizerSettings): Promise<void> {
    await writeJsonAtomic(this.path, organizerSettingsSchema.parse(settings));
  }
}
