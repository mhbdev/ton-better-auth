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

type Awaitable<T> = T | Promise<T>;

/**
 * TON network id. Matches `@tonconnect/protocol`'s `CHAIN` enum values.
 * - `-239` = mainnet
 * - `-3`   = testnet
 */
export type TonChain = "-239" | "-3";

/**
 * Domain policy used during `ton_proof` verification.
 *
 * - `string[]` applies globally to all networks.
 * - Object form allows per-network allow-lists plus a shared default.
 */
export type TonDomainPolicy =
  | string[]
  | {
      /** Fallback patterns used when no network-specific list is present. */
      default?: string[];
      /** Alias for `-239`. */
      mainnet?: string[];
      /** Alias for `-3`. */
      testnet?: string[];
      /** Explicit mainnet policy (`-239`). */
      "-239"?: string[];
      /** Explicit testnet policy (`-3`). */
      "-3"?: string[];
    };

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
  /**
   * Optional captcha token (used when captcha is enabled in plugin options).
   * If omitted, the server may read from a request header instead.
   */
  captchaToken?: string;
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
    activeWalletAddress?: string | null;
    activeWalletNetwork?: TonChain | null;
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

export type TonAntiAbuseStorage = "memory" | "secondary-storage";

export interface TonAntiAbuseRateLimitOptions {
  /** Time window in seconds. */
  windowSec?: number;
  /** Maximum requests allowed per IP within the window. */
  maxPerIp?: number;
  /** Maximum requests allowed per wallet address within the window. */
  maxPerAddress?: number;
}

export interface TonFailedVerifyCooldownOptions {
  /** Toggle failed-verify cooldown logic. */
  enabled?: boolean;
  /**
   * Number of failed verify attempts before cooldown starts.
   * Counted inside `windowSec`.
   */
  threshold?: number;
  /** Sliding window for counting failures. */
  windowSec?: number;
  /** Lockout duration after threshold is reached. */
  cooldownSec?: number;
  /** Key strategy for failures. */
  keying?: "ip" | "address" | "ip+address";
}

export interface TonCaptchaHookContext {
  phase: "challenge" | "verify";
  ip: string | null;
  userAgent: string | null;
  address?: string;
  network?: TonChain;
  token: string | null;
  headers: Headers | null;
  requestBody?: unknown;
}

export interface TonCaptchaOptions {
  /** Toggle captcha checks. */
  enabled?: boolean;
  /** Header name containing captcha token. Defaults to `x-captcha-token`. */
  headerName?: string;
  /** Body field containing captcha token. Defaults to `captchaToken`. */
  bodyField?: string;
  /**
   * Optional dynamic gate for when captcha is required.
   * Defaults to `false`.
   */
  shouldRequire?: (ctx: TonCaptchaHookContext) => Awaitable<boolean>;
  /**
   * Captcha verifier callback.
   * Return `true` on success, `false` or `{ ok: false }` on failure.
   */
  verify: (
    ctx: TonCaptchaHookContext,
  ) => Awaitable<boolean | { ok: boolean; reason?: string }>;
}

export interface TonAntiAbuseOptions {
  /** Toggle all anti-abuse checks. Defaults to `true`. */
  enabled?: boolean;
  /**
   * Storage backend for anti-abuse counters.
   * Defaults to `secondary-storage` when available, otherwise `memory`.
   */
  storage?: TonAntiAbuseStorage;
  /** Challenge endpoint limits. */
  challenge?: TonAntiAbuseRateLimitOptions;
  /** Verify endpoint limits. */
  verify?: TonAntiAbuseRateLimitOptions;
  /** Failed verification cooldown settings. */
  failedVerifyCooldown?: TonFailedVerifyCooldownOptions;
  /** Optional captcha checks. */
  captcha?: TonCaptchaOptions;
}

export interface TonMultiWalletAuthRules {
  /**
   * If true, only the current primary linked wallet can sign in.
   * Defaults to `false`.
   */
  onlyPrimaryCanSignIn?: boolean;
  /**
   * If true, sign-in is restricted to already-linked wallets unless
   * `autoLinkOnVerify` succeeds with an authenticated session.
   * Defaults to `false`.
   */
  allowOnlyLinkedWallets?: boolean;
  /**
   * If true, `/verify` will auto-link a successfully verified wallet
   * to the current authenticated user when possible.
   * Defaults to `true`.
   */
  autoLinkOnVerify?: boolean;
}

export interface TonEventMeta {
  at: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface TonChallengeIssuedEvent extends TonEventMeta {
  payload: string;
  expiresAt: Date;
}

export interface TonVerifySuccessEvent extends TonEventMeta {
  userId: string;
  address: string;
  network: TonChain;
  autoLinked: boolean;
}

export interface TonVerifyFailEvent extends TonEventMeta {
  address?: string;
  network?: TonChain;
  reason: string;
}

export interface TonWalletLinkedEvent extends TonEventMeta {
  userId: string;
  address: string;
  network: TonChain;
  isPrimary: boolean;
  source: "initial-sign-in" | "verify-auto-link" | "link-endpoint";
}

export interface TonPluginEventHooks {
  onChallengeIssued?: (event: TonChallengeIssuedEvent) => Awaitable<void>;
  onVerifySuccess?: (event: TonVerifySuccessEvent) => Awaitable<void>;
  onVerifyFail?: (event: TonVerifyFailEvent) => Awaitable<void>;
  onWalletLinked?: (event: TonWalletLinkedEvent) => Awaitable<void>;
}
