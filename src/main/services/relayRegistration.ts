import type {
  ProviderAccountSummary,
  RelayRegisterRequest,
} from "../../shared/contracts.js";

export function createRelayRegistration(
  account: ProviderAccountSummary,
  resourceId: string,
  expiresAt: string,
  verificationSecret?: string,
): RelayRegisterRequest {
  return {
    version: 1,
    provider: account.provider,
    accountId: account.id,
    providerAddress: account.email,
    resourceId,
    expiresAt,
    ...(account.provider === "outlook" && verificationSecret
      ? { verificationSecret }
      : {}),
  };
}
