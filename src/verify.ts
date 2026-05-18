/**
 * Verify a TON Connect `ton_proof` payload.
 *
 * Follows the reference implementation from the TON Connect docs:
 *   https://docs.ton.org/v3/guidelines/ton-connect/verifying-signed-in-users
 *
 * Message layout signed by the wallet:
 *   message = utf8("ton-proof-item-v2/")
 *           ++ Address (4-byte BE workchain ++ 32-byte hash)
 *           ++ AppDomain (4-byte LE length ++ utf8 value)
 *           ++ Timestamp (8-byte LE u64)
 *           ++ Payload (utf8)
 *
 *   signature = Ed25519Sign(
 *     privkey,
 *     sha256(0xffff ++ utf8("ton-connect") ++ sha256(message))
 *   )
 */
import { sha256 } from "@ton/crypto";
import { Address, Cell, contractAddress, loadStateInit } from "@ton/ton";
import { sign } from "tweetnacl";

import type { GetWalletPublicKey, TonProofRequest } from "./types.js";
import { type TonWalletVersion, tryParsePublicKey } from "./wallets.js";

const TON_PROOF_PREFIX = "ton-proof-item-v2/";
const TON_CONNECT_PREFIX = "ton-connect";

export interface VerifyTonProofOptions {
  /** List of domains the app will accept a signature for. */
  allowedDomains: string[];
  /** Max age of the signature in seconds. Defaults to 15 minutes. */
  validAuthTimeSec?: number;
  /** Optional on-chain public key fetcher used when state-init parsing fails. */
  getWalletPublicKey?: GetWalletPublicKey;
  /** Only let allowed wallet versions to be verified */
  allowedWalletVersions?: TonWalletVersion[];
}

export interface VerifyTonProofResult {
  ok: boolean;
  /** Human-readable reason when `ok === false`. */
  reason?: string;
}

/**
 * Verify a `ton_proof` payload end-to-end.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` otherwise.
 * Throws are never surfaced — all unexpected errors are translated into
 * `{ ok: false }` so callers can return a uniform 401.
 */
export async function verifyTonProof(
  request: TonProofRequest,
  options: VerifyTonProofOptions,
): Promise<VerifyTonProofResult> {
  const validAuthTime = options.validAuthTimeSec ?? 15 * 60;

  try {
    // Parse the state init and derive / look up the public key.
    const stateInit = loadStateInit(
      Cell.fromBase64(request.proof.state_init).beginParse(),
    );

    let publicKey = tryParsePublicKey(stateInit, options.allowedWalletVersions);
    if (!publicKey && options.getWalletPublicKey) {
      publicKey = await options.getWalletPublicKey(
        request.address,
        request.network,
      );
    }
    if (!publicKey) {
      return { ok: false, reason: "public_key_unavailable" };
    }

    // The client-provided public key must match what we derived.
    const wantedPublicKey = Buffer.from(request.public_key, "hex");
    if (!publicKey.equals(wantedPublicKey)) {
      return { ok: false, reason: "public_key_mismatch" };
    }

    // The address must equal contractAddress(workchain, walletStateInit).
    const wantedAddress = Address.parse(request.address);
    const derivedAddress = contractAddress(
      wantedAddress.workChain,
      stateInit,
    );
    if (!derivedAddress.equals(wantedAddress)) {
      return { ok: false, reason: "address_mismatch" };
    }

    // Domain must be on the allow-list (exact match, case-sensitive).
    if (!options.allowedDomains.includes(request.proof.domain.value)) {
      return { ok: false, reason: "domain_not_allowed" };
    }

    // Signature must be recent.
    const now = Math.floor(Date.now() / 1000);
    if (now - validAuthTime > request.proof.timestamp) {
      return { ok: false, reason: "signature_expired" };
    }

    // Reconstruct the signed message.
    const wc = Buffer.alloc(4);
    wc.writeUInt32BE(derivedAddress.workChain, 0);

    const ts = Buffer.alloc(8);
    ts.writeBigUInt64LE(BigInt(request.proof.timestamp), 0);

    const dl = Buffer.alloc(4);
    dl.writeUInt32LE(request.proof.domain.lengthBytes, 0);

    const msg = Buffer.concat([
      Buffer.from(TON_PROOF_PREFIX),
      wc,
      derivedAddress.hash,
      dl,
      Buffer.from(request.proof.domain.value),
      ts,
      Buffer.from(request.proof.payload),
    ]);

    const msgHash = Buffer.from(await sha256(msg));

    const fullMsg = Buffer.concat([
      Buffer.from([0xff, 0xff]),
      Buffer.from(TON_CONNECT_PREFIX),
      msgHash,
    ]);

    const digest = Buffer.from(await sha256(fullMsg));
    const signature = Buffer.from(request.proof.signature, "base64");

    const valid = sign.detached.verify(digest, signature, publicKey);
    return valid ? { ok: true } : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "verification_failed" };
  }
}
