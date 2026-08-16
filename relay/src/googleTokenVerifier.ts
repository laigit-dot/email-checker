import { OAuth2Client } from "google-auth-library";

import type { GoogleTokenVerifier } from "./contracts.js";
import { constantTimeEqual } from "./security.js";

export class GoogleOidcTokenVerifier implements GoogleTokenVerifier {
  private readonly client: OAuth2Client;

  public constructor(
    private readonly audience: string,
    private readonly serviceAccount: string,
    client?: OAuth2Client,
  ) {
    this.client = client ?? new OAuth2Client();
  }

  public async verify(token: string): Promise<void> {
    const ticket = await this.client.verifyIdToken({
      idToken: token,
      audience: this.audience,
    });
    const payload = ticket.getPayload();
    if (
      !payload?.email ||
      payload.email_verified !== true ||
      !constantTimeEqual(
        payload.email.toLowerCase(),
        this.serviceAccount.toLowerCase(),
      )
    ) {
      throw new Error("OIDC identity is not authorized.");
    }
  }
}
