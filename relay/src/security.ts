import { createHash, timingSafeEqual } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function deriveInstallationId(relayApiKey: string): string {
  return sha256(relayApiKey);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function extractBearerToken(headers: Headers): string | undefined {
  const authorization = headers.get("authorization");
  if (!authorization) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1];
}

export function authenticateRelay(headers: Headers, relayApiKey: string): boolean {
  const token = extractBearerToken(headers);
  return token !== undefined && constantTimeEqual(token, relayApiKey);
}

export function verifySecretHash(
  candidate: string,
  expectedHash: string,
): boolean {
  const candidateHash = sha256(candidate);
  const left = Buffer.from(candidateHash, "hex");
  const right = Buffer.from(expectedHash, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
