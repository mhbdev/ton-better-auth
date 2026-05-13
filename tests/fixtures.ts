/**
 * Test fixtures — build valid `ton_proof` payloads from a freshly
 * generated wallet keypair so we can exercise verification end-to-end
 * without needing a real TON Connect wallet.
 */
import { sha256 } from "@ton/crypto";
import {
  beginCell,
  contractAddress,
  storeStateInit,
  WalletContractV4,
} from "@ton/ton";
import nacl, { sign } from "tweetnacl";

import type {
  TonChain,
  TonProofPayload,
  TonProofRequest,
} from "../src/types.js";

export interface SignedProof {
  keyPair: nacl.SignKeyPair;
  request: TonProofRequest;
}

export interface BuildProofOptions {
  domain: string;
  payload: string;
  timestamp?: number;
  network?: TonChain;
  /** Workchain for the wallet (defaults to 0, basechain). */
  workchain?: number;
}

/**
 * Create a valid v4 wallet + matching signed ton_proof for tests.
 */
export async function buildSignedProof(
  options: BuildProofOptions,
): Promise<SignedProof> {
  const keyPair = nacl.sign.keyPair();
  const publicKey = Buffer.from(keyPair.publicKey);
  const workchain = options.workchain ?? 0;
  const network: TonChain = options.network ?? "-239";

  const wallet = WalletContractV4.create({ workchain, publicKey });
  const address = contractAddress(workchain, wallet.init);

  // Encode the state init as a base64 BoC cell.
  const stateInitCell = beginCell()
    .store(storeStateInit(wallet.init))
    .endCell();
  const stateInitBase64 = stateInitCell.toBoc().toString("base64");

  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const domainBytes = Buffer.from(options.domain);

  const wc = Buffer.alloc(4);
  wc.writeUInt32BE(workchain, 0);

  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(timestamp), 0);

  const dl = Buffer.alloc(4);
  dl.writeUInt32LE(domainBytes.length, 0);

  const msg = Buffer.concat([
    Buffer.from("ton-proof-item-v2/"),
    wc,
    address.hash,
    dl,
    domainBytes,
    ts,
    Buffer.from(options.payload),
  ]);

  const msgHash = Buffer.from(await sha256(msg));
  const fullMsg = Buffer.concat([
    Buffer.from([0xff, 0xff]),
    Buffer.from("ton-connect"),
    msgHash,
  ]);
  const digest = Buffer.from(await sha256(fullMsg));
  const signatureBytes = sign.detached(digest, keyPair.secretKey);

  const proof: TonProofPayload = {
    timestamp,
    domain: {
      lengthBytes: domainBytes.length,
      value: options.domain,
    },
    payload: options.payload,
    signature: Buffer.from(signatureBytes).toString("base64"),
    state_init: stateInitBase64,
  };

  const request: TonProofRequest = {
    address: address.toRawString(),
    network,
    public_key: publicKey.toString("hex"),
    proof,
  };

  return { keyPair, request };
}

export function corruptSignature(request: TonProofRequest): TonProofRequest {
  // Flip one bit of the signature to force verification failure.
  const sig = Buffer.from(request.proof.signature, "base64");
  sig[0] = sig[0]! ^ 0x01;
  return {
    ...request,
    proof: {
      ...request.proof,
      signature: sig.toString("base64"),
    },
  };
}
