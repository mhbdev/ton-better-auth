/**
 * Shared types for the ton-better-auth plugin.
 *
 * These mirror the TON Connect `TonProofItemReplySuccess` shape and the
 * `TonAddressItemReply` data the dApp frontend forwards to the backend
 * for verification.
 *
 * Reference:
 *  - https://docs.ton.org/v3/guidelines/ton-connect/verifying-signed-in-users
 *  - https://github.com/ton-blockchain/ton-connect/blob/main/requests-responses.md
 */

/**
 * TON network id. Matches `@tonconnect/protocol`'s `CHAIN` enum values.
 * - `-239` = mainnet
 * - `-3`   = testnet
 */
export type TonChain = "-239" | "-3";

/**
 * Raw proof payload the TON Connect wallet returns after a successful
 * `ton_proof` request.
 */
export interface TonProofPayload {
  /** Unix epoch time (seconds) when the signature was produced. */
  timestamp: number;
  domain: {
    /** Number of UTF-8 bytes in `value`. */
    lengthBytes: number;
    /** App domain (URL part, without encoding). */
    value: string;
  };
  /** Base64-encoded Ed25519 signature. */
  signature: string;
  /** The exact payload string the backend asked the wallet to sign. */
  payload: string;
  /** Base64-encoded wallet `StateInit` cell (BoC). */
  state_init: string;
}

/**
 * Full verification request body — matches the `check-proof` demo DTO
 * from `ton-connect/demo-dapp-with-react-ui`.
 */
export interface TonProofRequest {
  /** Friendly or raw user wallet address. */
  address: string;
  /** TON chain id (`-239` mainnet, `-3` testnet). */
  network: TonChain;
  /** Hex-encoded wallet public key (from `TonAddressItemReply.publicKey`). */
  public_key: string;
  /** `ton_proof` payload returned by the wallet. */
  proof: TonProofPayload;
}

/**
 * Information returned to the client after a successful sign-in.
 * Deliberately minimal — anything beyond this lives on the user object.
 */
export interface TonSignInResult {
  success: true;
  token: string;
  user: {
    id: string;
    address: string;
    network: TonChain;
  };
}

/** Public-key fetcher used as a fallback when `walletStateInit` parsing fails. */
export type GetWalletPublicKey = (
  address: string,
  network: TonChain,
) => Promise<Buffer | null>;

/** Optional hook to resolve a user's display name / avatar from an address. */
export type TonAddressLookup = (args: {
  address: string;
  network: TonChain;
}) => Promise<{ name?: string; image?: string } | null | undefined>;
