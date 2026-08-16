import { safeStorage } from "electron";

import type { EncryptionAdapter } from "./secretStore.js";

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Operating-system secret encryption is unavailable.");
  }
}

export const electronSafeStorageAdapter: EncryptionAdapter = {
  encryptString(value) {
    assertEncryptionAvailable();
    return safeStorage.encryptString(value);
  },
  decryptString(value) {
    assertEncryptionAvailable();
    return safeStorage.decryptString(value);
  },
};
