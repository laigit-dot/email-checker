import type { EmailRecord } from "../../shared/contracts.js";
import {
  EMAIL_HISTORY_RETENTION_DAYS,
  pruneEmailRecords,
} from "../../domain/emailStatus.js";
import { emailHistorySchema } from "../../domain/schemas.js";
import { readJsonFile, writeJsonAtomic } from "./atomicJson.js";

export class EmailHistoryStore {
  public constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async load(): Promise<EmailRecord[]> {
    try {
      const stored = emailHistorySchema.parse(await readJsonFile(this.path));
      const retained = pruneEmailRecords(
        stored,
        this.now(),
        EMAIL_HISTORY_RETENTION_DAYS,
      );

      if (retained.length !== stored.length) {
        await writeJsonAtomic(this.path, retained);
      }

      return retained;
    } catch {
      return [];
    }
  }

  public async save(records: readonly EmailRecord[]): Promise<void> {
    const validated = emailHistorySchema.parse(records);
    const retained = pruneEmailRecords(
      validated,
      this.now(),
      EMAIL_HISTORY_RETENTION_DAYS,
    );
    await writeJsonAtomic(this.path, retained);
  }
}
