import { Keypair } from "@stellar/stellar-sdk";
import { env } from "../config/env";
import { verifyAndConsume } from "./authChallengeService";
import { upsertUserByStellarAddress } from "../db/userRepo";
import { Result, ok, err } from "../errors/RouteError";
import { signAccessToken } from "./jwtService";

export interface AuthVerifyResult {
  accessToken: string;
  expiresIn: number;
}

/**
 * @deprecated Use RouteError discriminated union instead.
 * Kept for backward compatibility during migration.
 */
export class AuthVerifyError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "AuthVerifyError";
  }
}

export async function verifyChallengeAndIssueJwt(
  stellarAddress: string,
  nonce: string,
  signature: string,
): Promise<Result<AuthVerifyResult>> {
  const challenge = await verifyAndConsume(nonce);
  if (!challenge) {
    return err({
      kind: "Unauthorized",
      message: "Challenge is invalid, expired, or already used",
    });
  }

  const keypair = Keypair.fromPublicKey(stellarAddress);
  const message = Buffer.from(challenge.nonce, "utf8");

  if (!keypair.verify(message, Buffer.from(signature, "base64"))) {
    return err({
      kind: "Unauthorized",
      message: "Signature did not match the provided Stellar address",
    });
  }

  const user = await upsertUserByStellarAddress(stellarAddress);

  const accessToken = signAccessToken({ sub: user.stellarAddress });

  return ok({
    accessToken,
    expiresIn: env.JWT_TTL_SECONDS,
  });
}
