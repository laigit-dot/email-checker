import { z } from "zod";

import { readJsonFile, writeJsonAtomic } from "./atomicJson.js";

export interface EncryptionAdapter {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const secretNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i);
const ciphertextStoreSchema = z.record(z.string(), z.string());

export class EncryptedSecretStore {
  public constructor(
    private readonly path: string,
    private readonly encryption: EncryptionAdapter,
  ) {}

  public async get(name: string): Promise<string | undefined> {
    const safeName = secretNameSchema.parse(name);
    const ciphertext = (await this.loadCiphertexts())[safeName];

    if (ciphertext === undefined) {
      return undefined;
    }

    return this.encryption.decryptString(Buffer.from(ciphertext, "base64"));
  }

  public async set(name: string, value: string): Promise<void> {
    const safeName = secretNameSchema.parse(name);
    const ciphertexts = await this.loadCiphertexts();
    ciphertexts[safeName] = this.encryption
      .encryptString(value)
      .toString("base64");
    await writeJsonAtomic(this.path, ciphertexts);
  }

  public async delete(name: string): Promise<void> {
    const safeName = secretNameSchema.parse(name);
    const ciphertexts = await this.loadCiphertexts();

    if (!(safeName in ciphertexts)) {
      return;
    }

    delete ciphertexts[safeName];
    await writeJsonAtomic(this.path, ciphertexts);
  }

  private async loadCiphertexts(): Promise<Record<string, string>> {
    try {
      return ciphertextStoreSchema.parse(await readJsonFile(this.path));
    } catch {
      return {};
    }
  }
}
