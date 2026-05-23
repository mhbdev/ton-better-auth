import { useCallback, useEffect, useRef, useState } from "react";

import type { TonChain, TonProofRequest } from "./types.js";

type Awaitable<T> = T | Promise<T>;

export type TonConnectAuthErrorCode =
  | "CAPTCHA_TOKEN_FAILED"
  | "CHALLENGE_REQUEST_FAILED"
  | "CHALLENGE_RESPONSE_INVALID"
  | "WALLET_PROOF_MISSING"
  | "WALLET_PUBLIC_KEY_MISSING"
  | "WALLET_STATE_INIT_MISSING"
  | "WALLET_NETWORK_UNSUPPORTED"
  | "VERIFY_REQUEST_FAILED";

export interface TonConnectAuthError {
  code: TonConnectAuthErrorCode;
  message: string;
  cause?: unknown;
}

export interface TonConnectWalletProof {
  timestamp: number;
  domain: {
    lengthBytes: number;
    value: string;
  };
  payload: string;
  signature: string;
}

export interface TonConnectWalletAccountLike {
  address: string;
  chain: string;
  publicKey?: string | null;
  walletStateInit?: string;
}

export interface TonConnectWalletLike {
  account: TonConnectWalletAccountLike;
  connectItems?: {
    tonProof?:
      | {
          proof: TonConnectWalletProof;
        }
      | Record<string, unknown>;
  };
}

export interface TonConnectUILike {
  setConnectRequestParameters: (
    params:
      | { state: "loading" }
      | { state: "ready"; value: { tonProof: string } }
      | null,
  ) => void;
  onStatusChange: (
    callback: (wallet: TonConnectWalletLike | null) => void | Promise<void>,
  ) => () => void;
  disconnect?: () => void | Promise<void>;
}

export interface TonConnectClientLike {
  tonConnect: {
    challenge: (...args: unknown[]) => Promise<{
      data?: { payload?: string; expiresAt?: number };
      error?: unknown;
    }>;
    verify: (...args: unknown[]) => Promise<{
      data?: unknown;
      error?: unknown;
    }>;
  };
}

export interface UseTonConnectAuthOptions {
  tonConnectUI: TonConnectUILike;
  authClient: TonConnectClientLike;
  enabled?: boolean;
  refreshIntervalMs?: number;
  autoDisconnectOnError?: boolean;
  getCaptchaToken?: (args: {
    phase: "challenge" | "verify";
    wallet: TonConnectWalletLike | null;
  }) => Awaitable<string | null | undefined>;
  onVerified?: (payload: TonProofRequest) => void | Promise<void>;
  onError?: (error: TonConnectAuthError) => void;
}

export interface UseTonConnectAuthResult {
  authenticated: boolean;
  status:
    | "idle"
    | "loading-challenge"
    | "ready"
    | "verifying"
    | "authenticated"
    | "error";
  error: TonConnectAuthError | null;
  challengePayload: string | null;
  challengeExpiresAt: number | null;
  refreshChallenge: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  clearError: () => void;
}

const DEFAULT_REFRESH_INTERVAL_MS = 9 * 60 * 1000;

function makeError(
  code: TonConnectAuthErrorCode,
  message: string,
  cause?: unknown,
): TonConnectAuthError {
  return { code, message, cause };
}

function toSupportedChain(chain: string): TonChain | null {
  return chain === "-239" || chain === "-3" ? chain : null;
}

function getWalletProof(wallet: TonConnectWalletLike): TonConnectWalletProof | null {
  const item = wallet.connectItems?.tonProof;
  if (!item || typeof item !== "object") return null;
  if (!("proof" in item)) return null;
  const proof = (item as { proof?: TonConnectWalletProof }).proof;
  return proof ?? null;
}

function buildVerifyPayload(wallet: TonConnectWalletLike):
  | { ok: true; payload: TonProofRequest }
  | { ok: false; error: TonConnectAuthError } {
  const proof = getWalletProof(wallet);
  if (!proof) {
    return {
      ok: false,
      error: makeError(
        "WALLET_PROOF_MISSING",
        "TON proof item was not returned by wallet.",
      ),
    };
  }

  const network = toSupportedChain(wallet.account.chain);
  if (!network) {
    return {
      ok: false,
      error: makeError(
        "WALLET_NETWORK_UNSUPPORTED",
        `Unsupported wallet network: ${wallet.account.chain}`,
      ),
    };
  }

  if (!wallet.account.publicKey) {
    return {
      ok: false,
      error: makeError(
        "WALLET_PUBLIC_KEY_MISSING",
        "Wallet account public key is missing.",
      ),
    };
  }

  if (!wallet.account.walletStateInit) {
    return {
      ok: false,
      error: makeError(
        "WALLET_STATE_INIT_MISSING",
        "Wallet account state init is missing.",
      ),
    };
  }

  return {
    ok: true,
    payload: {
      address: wallet.account.address,
      network,
      public_key: wallet.account.publicKey,
      proof: {
        timestamp: proof.timestamp,
        domain: {
          lengthBytes: proof.domain.lengthBytes,
          value: proof.domain.value,
        },
        payload: proof.payload,
        signature: proof.signature,
        state_init: wallet.account.walletStateInit,
      },
    },
  };
}

/**
 * React helper that handles TON challenge refresh and verification lifecycle.
 */
export function useTonConnectAuth(
  options: UseTonConnectAuthOptions,
): UseTonConnectAuthResult {
  const {
    tonConnectUI,
    authClient,
    enabled = true,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    autoDisconnectOnError = true,
    getCaptchaToken,
    onVerified,
    onError,
  } = options;

  const [authenticated, setAuthenticated] = useState(false);
  const [status, setStatus] = useState<UseTonConnectAuthResult["status"]>("idle");
  const [error, setError] = useState<TonConnectAuthError | null>(null);
  const [challengePayload, setChallengePayload] = useState<string | null>(null);
  const [challengeExpiresAt, setChallengeExpiresAt] = useState<number | null>(null);

  const firstChallengeLoadRef = useRef(true);
  const lastVerifiedProofRef = useRef<string | null>(null);

  const reportError = useCallback(
    (nextError: TonConnectAuthError) => {
      setError(nextError);
      setStatus("error");
      onError?.(nextError);
    },
    [onError],
  );

  const refreshChallenge = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;

    if (firstChallengeLoadRef.current) {
      tonConnectUI.setConnectRequestParameters({ state: "loading" });
      firstChallengeLoadRef.current = false;
    }
    setStatus("loading-challenge");

    let challengeToken: string | null | undefined;
    if (getCaptchaToken) {
      try {
        challengeToken = await getCaptchaToken({
          phase: "challenge",
          wallet: null,
        });
      } catch (captchaTokenError) {
        tonConnectUI.setConnectRequestParameters(null);
        reportError(
          makeError(
            "CAPTCHA_TOKEN_FAILED",
            "Failed to obtain captcha token for challenge.",
            captchaTokenError,
          ),
        );
        return false;
      }
    }

    const { data, error: challengeError } = await authClient.tonConnect.challenge(
      challengeToken ? { captchaToken: challengeToken } : undefined,
    );
    if (challengeError) {
      tonConnectUI.setConnectRequestParameters(null);
      reportError(
        makeError(
          "CHALLENGE_REQUEST_FAILED",
          "Failed to request TON challenge payload.",
          challengeError,
        ),
      );
      return false;
    }

    if (!data?.payload) {
      tonConnectUI.setConnectRequestParameters(null);
      reportError(
        makeError(
          "CHALLENGE_RESPONSE_INVALID",
          "Challenge response does not include a payload.",
        ),
      );
      return false;
    }

    setChallengePayload(data.payload);
    setChallengeExpiresAt(data.expiresAt ?? null);
    setError(null);
    setStatus("ready");

    tonConnectUI.setConnectRequestParameters({
      state: "ready",
      value: { tonProof: data.payload },
    });
    return true;
  }, [authClient, enabled, getCaptchaToken, reportError, tonConnectUI]);

  const disconnect = useCallback(async () => {
    await tonConnectUI.disconnect?.();
    setAuthenticated(false);
  }, [tonConnectUI]);

  const clearError = useCallback(() => {
    setError(null);
    if (!authenticated) setStatus("idle");
  }, [authenticated]);

  useEffect(() => {
    if (!enabled) return;
    void refreshChallenge();
    const id = setInterval(() => {
      void refreshChallenge();
    }, refreshIntervalMs);
    return () => clearInterval(id);
  }, [enabled, refreshChallenge, refreshIntervalMs]);

  useEffect(() => {
    if (!enabled) return;

    return tonConnectUI.onStatusChange(async (wallet) => {
      if (!wallet) {
        setAuthenticated(false);
        lastVerifiedProofRef.current = null;
        return;
      }

      const proof = getWalletProof(wallet);
      if (!proof) return;

      const requestKey = `${wallet.account.address}:${proof.payload}:${proof.timestamp}:${proof.signature}`;
      if (lastVerifiedProofRef.current === requestKey) return;
      lastVerifiedProofRef.current = requestKey;

      const payloadResult = buildVerifyPayload(wallet);
      if (!payloadResult.ok) {
        reportError(payloadResult.error);
        if (autoDisconnectOnError) await disconnect();
        return;
      }
      const payload = payloadResult.payload;

      setStatus("verifying");
      let verifyPayload = payload;
      if (getCaptchaToken) {
        try {
          const token = await getCaptchaToken({
            phase: "verify",
            wallet,
          });
          if (token) {
            verifyPayload = {
              ...payload,
              captchaToken: token,
            };
          }
        } catch (captchaTokenError) {
          reportError(
            makeError(
              "CAPTCHA_TOKEN_FAILED",
              "Failed to obtain captcha token for verify.",
              captchaTokenError,
            ),
          );
          if (autoDisconnectOnError) await disconnect();
          return;
        }
      }

      const { error: verifyError } = await authClient.tonConnect.verify(verifyPayload);
      if (verifyError) {
        reportError(
          makeError(
            "VERIFY_REQUEST_FAILED",
            "TON proof verification failed.",
            verifyError,
          ),
        );
        if (autoDisconnectOnError) await disconnect();
        return;
      }

      setAuthenticated(true);
      setError(null);
      setStatus("authenticated");
      await onVerified?.(payload);
    });
  }, [
    authClient,
    autoDisconnectOnError,
    disconnect,
    enabled,
    getCaptchaToken,
    onVerified,
    reportError,
    tonConnectUI,
  ]);

  return {
    authenticated,
    status,
    error,
    challengePayload,
    challengeExpiresAt,
    refreshChallenge,
    disconnect,
    clearError,
  };
}
