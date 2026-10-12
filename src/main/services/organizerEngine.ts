import type {
  Classification,
  EmailRecord,
  OrganizerSettings,
  Provider,
  ProviderAccountSummary,
  RunCheckpoint,
  RunState,
  RunSummary,
} from "../../shared/contracts.js";
import {
  applyMarkReadFailure,
  combineUrgency,
  computeStatusCounts,
  pruneEmailRecords,
} from "../../domain/emailStatus.js";
import { errorFields, logOrganizer } from "./debugLog.js";

export interface ProviderMessage {
  id: string;
  sender: string;
  subject: string;
  receivedAt: string;
  bodyPreview: string;
  webUrl: string;
  unread: boolean;
  highImportance: boolean;
}

export interface OrganizerProviderAdapter {
  fetchMessages(
    accountId: string,
    options: { unreadOnly: boolean; limit: number },
  ): Promise<ProviderMessage[]>;
  moveMessage(
    accountId: string,
    messageId: string,
    rootFolder: string,
    folder: string,
  ): Promise<void>;
  markRead(accountId: string, messageId: string): Promise<void>;
}

export interface OrganizerClassifier {
  classify(
    email: {
      sender: string;
      subject: string;
      receivedAt: string;
      bodyPreview: string;
    },
    settings: OrganizerSettings,
    signal?: AbortSignal,
  ): Promise<Classification>;
}

export interface OrganizerEngineDependencies {
  classifier: OrganizerClassifier;
  adapters: Partial<Record<Provider, OrganizerProviderAdapter>>;
  loadHistory: () => Promise<EmailRecord[]>;
  publish: (
    records: readonly EmailRecord[],
    run: RunState,
    persistRecords?: boolean,
  ) => Promise<void>;
  now?: () => Date;
}

export interface OrganizerEngineResult {
  records: EmailRecord[];
  summary: RunSummary;
}

function errorDetail(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : "Provider operation failed.";
}

function key(record: Pick<EmailRecord, "provider" | "accountId" | "id">): string {
  return `${record.provider}\u0000${record.accountId}\u0000${record.id}`;
}

function truncateSubject(subject: string, max = 72): string {
  const trimmed = subject.trim() || "(no subject)";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function messageOutcome(
  record: EmailRecord,
  settings: OrganizerSettings,
  processedCount: number,
  queuedCount: number,
): Pick<RunCheckpoint, "label" | "step"> {
  const progress = `${processedCount} of ${queuedCount} · ${truncateSubject(record.subject)}`;
  if (record.status.failed) {
    return { label: `Failed ${progress}`, step: "classifying" };
  }
  if (settings.dryRun) {
    return { label: `Recorded ${progress}`, step: "classifying" };
  }
  if (record.status.organized) {
    return { label: `Filed ${progress}`, step: "filing" };
  }
  return { label: `Processed ${progress}`, step: "filing" };
}

export class OrganizerEngine {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: OrganizerEngineDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async run(
    accounts: readonly ProviderAccountSummary[],
    settings: OrganizerSettings,
    signal?: AbortSignal,
  ): Promise<OrganizerEngineResult> {
    signal?.throwIfAborted();
    const startedAt = this.now().toISOString();
    const history = await this.dependencies.loadHistory();
    signal?.throwIfAborted();
    const records = new Map(
      history.map((record) => [key(record), record]),
    );
    let processedCount = 0;
    let queuedCount = 0;
    const accountErrors: string[] = [];
    const adapterProviders = Object.entries(this.dependencies.adapters)
      .filter(([, adapter]) => adapter)
      .map(([provider]) => provider);
    const accountCount = accounts.length;

    const publish = async (
      phase: RunState["phase"],
      checkpoint: Omit<RunCheckpoint, "at" | "processedCount" | "queuedCount" | "accountCount"> &
        Partial<Pick<RunCheckpoint, "processedCount" | "queuedCount" | "accountCount">>,
      summaryExtra: Partial<RunSummary> = {},
      persistRecords = false,
    ): Promise<void> => {
      const values = [...records.values()];
      await this.dependencies.publish(values, {
        phase,
        summary: {
          startedAt,
          accountCount,
          processedCount,
          counts: computeStatusCounts(values),
          ...summaryExtra,
        },
        checkpoint: {
          at: this.now().toISOString(),
          processedCount,
          queuedCount,
          accountCount,
          ...checkpoint,
        },
      }, persistRecords);
    };

    logOrganizer("info", "engine.run.start", {
      startedAt,
      accountCount: accounts.length,
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
        provider: account.provider,
        health: account.health.status,
      })),
      adapterProviders,
      historyCount: history.length,
      dryRun: settings.dryRun,
      unreadOnly: settings.unreadOnly,
      markAsRead: settings.markAsRead,
      scanLimit: settings.scanLimit,
      rootFolder: settings.rootFolder,
      folders: settings.folders.map((folder) => folder.name),
      confidenceThreshold: settings.confidenceThreshold,
      aiProvider: settings.aiProvider,
      model: settings.model,
    });
    if (settings.dryRun) {
      logOrganizer("warn", "engine.dry-run.enabled", {
        hint: "Messages will be classified but not moved. organized stays false until Dry run is turned off.",
      });
    }
    if (accounts.length === 0) {
      logOrganizer("warn", "engine.no-accounts", {
        hint: "Nothing to organize. Check connected accounts and the selected-account list.",
      });
    }

    await publish("running", {
      step: "starting",
      label:
        accountCount === 0
          ? "No connected accounts selected for this run."
          : `Starting organizer for ${accountCount} account${accountCount === 1 ? "" : "s"}.`,
    });

    for (const [accountIndex, account] of accounts.entries()) {
      signal?.throwIfAborted();
      const adapter = this.dependencies.adapters[account.provider];
      if (!adapter) {
        const detail = `${account.email}: connector unavailable`;
        accountErrors.push(detail);
        logOrganizer("error", "engine.adapter.missing", {
          accountId: account.id,
          email: account.email,
          provider: account.provider,
          adapterProviders,
          hint: "The provider connector was not created. Check client ID / secret configuration.",
        });
        continue;
      }

      logOrganizer("info", "engine.account.start", {
        accountId: account.id,
        email: account.email,
        provider: account.provider,
        unreadOnly: settings.unreadOnly,
        limit: settings.scanLimit,
      });
      await publish("running", {
        step: "fetching",
        label: `Fetching inbox · ${account.email} (${accountIndex + 1} of ${accountCount})`,
        accountEmail: account.email,
        accountIndex: accountIndex + 1,
      });

      let messages: ProviderMessage[];
      try {
        messages = await adapter.fetchMessages(account.id, {
          unreadOnly: settings.unreadOnly,
          limit: settings.scanLimit,
        });
        signal?.throwIfAborted();
      } catch (reason) {
        signal?.throwIfAborted();
        accountErrors.push(`${account.email}: ${errorDetail(reason)}`);
        logOrganizer("error", "engine.fetch.failed", {
          accountId: account.id,
          email: account.email,
          provider: account.provider,
          unreadOnly: settings.unreadOnly,
          limit: settings.scanLimit,
          ...errorFields(reason),
        });
        continue;
      }

      queuedCount += messages.length;
      logOrganizer("info", "engine.fetch.ok", {
        accountId: account.id,
        email: account.email,
        provider: account.provider,
        messageCount: messages.length,
        unreadCount: messages.filter((message) => message.unread).length,
        subjects: messages.map((message) => message.subject),
      });
      if (messages.length === 0) {
        logOrganizer("warn", "engine.fetch.empty", {
          accountId: account.id,
          email: account.email,
          unreadOnly: settings.unreadOnly,
          hint: settings.unreadOnly
            ? "Inbox query returned no messages. If mail is already read, turn off Unread only."
            : "Inbox query returned no messages.",
        });
        await publish("running", {
          step: "fetching",
          label: `No messages in ${account.email}.`,
          accountEmail: account.email,
          accountIndex: accountIndex + 1,
        });
      } else {
        await publish("running", {
          step: "fetching",
          label: `${messages.length} message${messages.length === 1 ? "" : "s"} in ${account.email}.`,
          accountEmail: account.email,
          accountIndex: accountIndex + 1,
          messageCount: messages.length,
        });
      }

      for (const [index, message] of messages.entries()) {
        signal?.throwIfAborted();
        const processedAt = this.now().toISOString();
        let record: EmailRecord;
        logOrganizer("info", "engine.message.start", {
          index: index + 1,
          of: messages.length,
          accountId: account.id,
          provider: account.provider,
          messageId: message.id,
          sender: message.sender,
          subject: message.subject,
          receivedAt: message.receivedAt,
          unread: message.unread,
          highImportance: message.highImportance,
          previewChars: message.bodyPreview.length,
        });
        await publish("running", {
          step: "classifying",
          label: `Classifying ${index + 1} of ${messages.length} · ${truncateSubject(message.subject)}`,
          accountEmail: account.email,
          accountIndex: accountIndex + 1,
          messageIndex: index + 1,
          messageCount: messages.length,
          subject: message.subject,
        });

        try {
          const classifyStarted = this.now().getTime();
          const classification = await this.dependencies.classifier.classify(
            {
              sender: message.sender,
              subject: message.subject,
              receivedAt: message.receivedAt,
              bodyPreview: message.bodyPreview,
            },
            settings,
            signal,
          );
          signal?.throwIfAborted();
          logOrganizer("info", "engine.classify.ok", {
            messageId: message.id,
            subject: message.subject,
            folder: classification.folder,
            confidence: classification.confidence,
            urgent: classification.urgent,
            reason: classification.reason,
            summary: classification.summary,
            elapsedMs: this.now().getTime() - classifyStarted,
            belowThreshold: classification.confidence < settings.confidenceThreshold,
          });
          record = {
            id: message.id,
            provider: account.provider,
            accountId: account.id,
            sender: message.sender,
            subject: message.subject,
            receivedAt: message.receivedAt,
            processedAt,
            webUrl: message.webUrl,
            destinationFolder: classification.folder,
            summary: classification.summary,
            reason: classification.reason,
            confidence: classification.confidence,
            status: {
              unread: message.unread,
              organized: false,
              failed: false,
              urgent: combineUrgency(
                message.highImportance,
                classification.urgent,
              ),
            },
          };

          if (!settings.dryRun) {
            try {
              signal?.throwIfAborted();
              const moveStarted = this.now().getTime();
              await adapter.moveMessage(
                account.id,
                message.id,
                settings.rootFolder,
                classification.folder,
              );
              record.status.organized = true;
              logOrganizer("info", "engine.move.ok", {
                messageId: message.id,
                subject: message.subject,
                rootFolder: settings.rootFolder,
                folder: classification.folder,
                elapsedMs: this.now().getTime() - moveStarted,
              });
            } catch (reason) {
              signal?.throwIfAborted();
              record.status.failed = true;
              record.failure = {
                operation: "organize",
                detail: errorDetail(reason),
                occurredAt: this.now().toISOString(),
              };
              logOrganizer("error", "engine.move.failed", {
                messageId: message.id,
                subject: message.subject,
                rootFolder: settings.rootFolder,
                folder: classification.folder,
                ...errorFields(reason),
              });
            }

            if (
              record.status.organized &&
              settings.markAsRead &&
              record.status.unread
            ) {
              try {
                signal?.throwIfAborted();
                await adapter.markRead(account.id, message.id);
                record.status.unread = false;
                logOrganizer("info", "engine.mark-read.ok", {
                  messageId: message.id,
                });
              } catch (reason) {
                signal?.throwIfAborted();
                record = applyMarkReadFailure(
                  record,
                  errorDetail(reason),
                  this.now().toISOString(),
                );
                logOrganizer("error", "engine.mark-read.failed", {
                  messageId: message.id,
                  hint: "Move succeeded; only the mark-as-read update failed.",
                  ...errorFields(reason),
                });
              }
            }
          } else {
            logOrganizer("info", "engine.move.skipped-dry-run", {
              messageId: message.id,
              subject: message.subject,
              folder: classification.folder,
              hint: "Classification recorded only. Turn off Dry run to move mail.",
            });
          }
        } catch (reason) {
          signal?.throwIfAborted();
          record = {
            id: message.id,
            provider: account.provider,
            accountId: account.id,
            sender: message.sender,
            subject: message.subject,
            receivedAt: message.receivedAt,
            processedAt,
            webUrl: message.webUrl,
            status: {
              unread: message.unread,
              organized: false,
              failed: true,
              urgent: message.highImportance,
            },
            failure: {
              operation: "classify",
              detail: errorDetail(reason),
              occurredAt: this.now().toISOString(),
            },
          };
          logOrganizer("error", "engine.classify.failed", {
            messageId: message.id,
            subject: message.subject,
            aiProvider: settings.aiProvider,
            model: settings.model,
            ollamaUrl: settings.ollamaUrl,
            ...errorFields(reason),
          });
        }

        records.set(key(record), record);
        processedCount += 1;
        const outcome = messageOutcome(
          record,
          settings,
          processedCount,
          queuedCount,
        );
        await publish("running", {
          ...outcome,
          accountEmail: account.email,
          accountIndex: accountIndex + 1,
          messageIndex: index + 1,
          messageCount: messages.length,
          subject: message.subject,
        }, {}, true);
      }
    }

    signal?.throwIfAborted();
    const retained = pruneEmailRecords([...records.values()], this.now());
    const summary: RunSummary = {
      startedAt,
      finishedAt: this.now().toISOString(),
      accountCount,
      processedCount,
      counts: computeStatusCounts(retained),
      error: accountErrors.length > 0 ? accountErrors.join("; ") : undefined,
    };
    logOrganizer(
      summary.error || (processedCount === 0 && !settings.dryRun)
        ? "warn"
        : "info",
      "engine.run.complete",
      {
        ...summary,
        accountErrors,
        organizedThisRun: retained.filter((record) => record.status.organized)
          .length,
        failedThisRun: retained.filter((record) => record.status.failed).length,
        hint:
          processedCount === 0
            ? "No messages were processed. See engine.fetch.empty / engine.no-accounts above."
            : settings.dryRun
              ? "Dry run completed; mail was not moved."
              : undefined,
      },
    );
    await this.dependencies.publish(
      retained,
      {
        phase: "completed",
        summary,
        checkpoint: {
          at: this.now().toISOString(),
          step: "completing",
          label: summary.error
            ? `Run finished with account errors · ${processedCount} processed.`
            : processedCount === 0
              ? "Run finished · no messages processed."
              : `Run finished · ${processedCount} message${processedCount === 1 ? "" : "s"} processed.`,
          processedCount,
          queuedCount,
          accountCount,
        },
      },
      retained.length !== records.size,
    );
    return { records: retained, summary };
  }
}
