/**
 * ton-better-auth
 *
 * A Better Auth plugin that adds "Sign in with TON Connect" using the
 * official `ton_proof` protocol. Point your TON Connect UI at the
 * challenge endpoint, forward the reply to `/ton-connect/verify`, and
 * this plugin takes care of verifying the signature, linking the
 * wallet, and starting a Better Auth session.
 */
export { tonConnect, type TonConnectPlugin, type TonConnectPluginOptions } from "./plugin.js";
export { verifyTonProof } from "./verify.js";
export { tryParsePublicKey } from "./wallets.js";
export type {
  GetWalletPublicKey,
  TonAntiAbuseOptions,
  TonAddressLookup,
  TonCaptchaHookContext,
  TonCaptchaOptions,
  TonChain,
  TonDomainPolicy,
  TonMultiWalletAuthRules,
  TonPluginEventHooks,
  TonProofPayload,
  TonProofRequest,
  TonSignInResult,
} from "./types.js";
