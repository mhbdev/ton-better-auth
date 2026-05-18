/**
 * Better Auth plugin: Sign in with TON Connect (`ton_proof`).
 *
 * Endpoints:
 *   POST /ton-connect/challenge
 *   POST /ton-connect/verify
 *   POST /ton-connect/link        (authenticated)
 *   POST /ton-connect/unlink      (authenticated)
 *   GET  /ton-connect/wallets     (authenticated)
 *   POST /ton-connect/set-primary (authenticated)
 *   POST /ton-connect/switch-session-wallet (authenticated)
 */
import {
  APIError,
  createAuthEndpoint,
  getIp,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { mergeSchema } from "better-auth/db";
import type { Where } from "@better-auth/core/db/adapter";
import type { BetterAuthPlugin, User } from "better-auth";
import { getSecureRandomBytes } from "@ton/crypto";
import { Address } from "@ton/ton";
import * as z from "zod";

import { schema, type TonSchema } from "./schema.js";
import type {
  GetWalletPublicKey,
  TonAddressLookup,
  TonAntiAbuseOptions,
  TonCaptchaHookContext,
  TonCaptchaOptions,
  TonChain,
  TonDomainPolicy,
  TonMultiWalletAuthRules,
  TonPluginEventHooks,
} from "./types.js";
import { verifyTonProof } from "./verify.js";
import type { TonWalletVersion } from "./wallets.js";

const CHALLENGE_PREFIX = "ton-proof-challenge:";
const ABUSE_PREFIX = "ton-proof-abuse:";

const DEFAULT_VALID_AUTH_TIME_SEC = 15 * 60;
const DEFAULT_CHALLENGE_TTL_SEC = 10 * 60;
const DEFAULT_ANTI_ABUSE = {
  challenge: {
    windowSec: 60,
    maxPerIp: 20,
    maxPerAddress: 0,
  },
  verify: {
    windowSec: 60,
    maxPerIp: 20,
    maxPerAddress: 8,
  },
  failedVerifyCooldown: {
    enabled: true,
    threshold: 5,
    windowSec: 10 * 60,
    cooldownSec: 10 * 60,
    keying: "ip+address" as const,
  },
};

const DEFAULT_AUTH_RULES: Required<TonMultiWalletAuthRules> = {
  onlyPrimaryCanSignIn: false,
  allowOnlyLinkedWallets: false,
  autoLinkOnVerify: true,
};

const tonChain = z.enum(["-239", "-3"]);

const challengeBodySchema = z
  .object({
    captchaToken: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
  })
  .optional();

const verifyBodySchema = z.object({
  address: z.string().min(1),
  network: tonChain,
  public_key: z.string().regex(/^[0-9a-fA-F]{64}$/),
  proof: z.object({
    timestamp: z.number().int().positive(),
    domain: z.object({
      lengthBytes: z.number().int().positive(),
      value: z.string().min(1),
    }),
    payload: z.string().min(1),
    signature: z.string().min(1),
    state_init: z.string().min(1),
  }),
  captchaToken: z.string().min(1).optional(),
});

const linkBodySchema = verifyBodySchema;

const unlinkBodySchema = z.object({
  address: z.string().min(1),
});

const setPrimaryBodySchema = z.object({
  address: z.string().min(1),
});

const switchWalletSessionBodySchema = z.object({
  address: z.string().min(1),
});

export interface TonConnectPluginOptions {
  /**
   * Allowed app domains.
   *
   * Accepts:
   * - string[] (global policy)
   * - object policy (`default`, `mainnet`, `testnet`, `-239`, `-3`)
   */
  allowedDomains: TonDomainPolicy;
  /** Additional per-network domain policy (additive). */
  allowedDomainsByNetwork?: Partial<Record<TonChain, string[]>>;
  /** Allowed wallet versions. */
  allowedWalletVersions?: TonWalletVersion[];
  /**
   * Email domain used to synthesize placeholder emails for new users.
   * Defaults to `"ton.local"`.
   */
  emailDomain?: string;
  /**
   * How long (seconds) a `ton_proof` is considered valid.
   * Defaults to 15 minutes.
   */
  validAuthTimeSec?: number;
  /**
   * How long (seconds) a challenge remains valid.
   * Defaults to 10 minutes.
   */
  challengeTtlSec?: number;
  /**
   * Fallback used when wallet state-init parsing fails.
   */
  getWalletPublicKey?: GetWalletPublicKey;
  /**
   * Optional hook for resolving a display name / avatar for new users.
   */
  addressLookup?: TonAddressLookup;
  /**
   * Whether users created by TON Connect should receive a synthesized email.
   * Defaults to `true`.
   */
  createUserEmail?: boolean;
  /**
   * Abuse-protection settings (captcha, IP/address limits, cooldown).
   */
  antiAbuse?: TonAntiAbuseOptions;
  /**
   * Multi-wallet sign-in policies.
   */
  authRules?: TonMultiWalletAuthRules;
  /**
   * Lifecycle event hooks.
   */
  events?: TonPluginEventHooks;
  /**
   * Override the Better Auth plugin schema.
   */
  schema?: {
    [K in keyof TonSchema]?: {
      modelName?: string;
      fields?: { [P: string]: string };
    };
  };
}

interface TonWalletRow {
  id: string;
  userId: string;
  address: string;
  publicKey: string;
  network: TonChain;
  isPrimary: boolean;
  createdAt: Date;
}

interface TonWalletPrimaryAdapter {
  findMany: <T>(data: { model: string; where?: Where[] }) => Promise<T[]>;
  updateMany: (data: {
    model: string;
    where: Where[];
    update: Record<string, unknown>;
  }) => Promise<number>;
  update: <T>(data: {
    model: string;
    where: Where[];
    update: Record<string, unknown>;
  }) => Promise<T | null>;
}

interface TonAbuseRecord {
  count: number;
  lastRequest: number;
  blockedUntil?: number;
}

const memoryAbuseStore = new Map<
  string,
  { data: TonAbuseRecord; expiresAt: number }
>();

function compareWalletRows(a: TonWalletRow, b: TonWalletRow): number {
  const timeA = a.createdAt.getTime();
  const timeB = b.createdAt.getTime();
  if (timeA !== timeB) return timeA - timeB;
  return a.id.localeCompare(b.id);
}

async function normalizePrimaryWalletForUser(
  adapter: TonWalletPrimaryAdapter,
  userId: string,
): Promise<void> {
  const wallets = await adapter.findMany<TonWalletRow>({
    model: "tonWallet",
    where: [{ field: "userId", operator: "eq", value: userId }],
  });

  if (wallets.length === 0) return;

  const ordered = [...wallets].sort(compareWalletRows);
  const preferred = ordered.find((w) => w.isPrimary) ?? ordered[0];
  if (!preferred) return;
  const primaryCount = ordered.filter((w) => w.isPrimary).length;
  if (primaryCount === 1 && preferred.isPrimary) return;

  await adapter.updateMany({
    model: "tonWallet",
    where: [
      { field: "userId", operator: "eq", value: userId },
      { field: "id", operator: "ne", value: preferred.id },
    ],
    update: { isPrimary: false },
  });

  await adapter.update({
    model: "tonWallet",
    where: [{ field: "id", operator: "eq", value: preferred.id }],
    update: { isPrimary: true },
  });
}

/** Convert any TON address representation to canonical `wc:hex` raw form. */
function toRawAddress(address: string): string {
  return Address.parse(address).toRawString();
}

function getHeaders(ctx: {
  headers?: HeadersInit;
  request?: Request;
}): Headers | null {
  if (ctx.request?.headers) return ctx.request.headers;
  if (ctx.headers) return new Headers(ctx.headers);
  return null;
}

function getUserAgent(headers: Headers | null): string | null {
  return headers?.get("user-agent") ?? null;
}

function toRateLimitAddressKey(address: string): string {
  try {
    return toRawAddress(address);
  } catch {
    return address.trim().toLowerCase();
  }
}

function shouldUseSecondaryStorage(
  storage: TonAntiAbuseOptions["storage"] | undefined,
  secondaryStorage: unknown,
): boolean {
  if (storage === "memory") return false;
  if (storage === "secondary-storage") return !!secondaryStorage;
  return !!secondaryStorage;
}

function resolveAntiAbuse(options: TonConnectPluginOptions) {
  const antiAbuse = options.antiAbuse;
  return {
    enabled: antiAbuse?.enabled ?? true,
    storage: antiAbuse?.storage,
    challenge: {
      windowSec:
        antiAbuse?.challenge?.windowSec ?? DEFAULT_ANTI_ABUSE.challenge.windowSec,
      maxPerIp:
        antiAbuse?.challenge?.maxPerIp ?? DEFAULT_ANTI_ABUSE.challenge.maxPerIp,
      maxPerAddress:
        antiAbuse?.challenge?.maxPerAddress ??
        DEFAULT_ANTI_ABUSE.challenge.maxPerAddress,
    },
    verify: {
      windowSec:
        antiAbuse?.verify?.windowSec ?? DEFAULT_ANTI_ABUSE.verify.windowSec,
      maxPerIp: antiAbuse?.verify?.maxPerIp ?? DEFAULT_ANTI_ABUSE.verify.maxPerIp,
      maxPerAddress:
        antiAbuse?.verify?.maxPerAddress ?? DEFAULT_ANTI_ABUSE.verify.maxPerAddress,
    },
    failedVerifyCooldown: {
      enabled:
        antiAbuse?.failedVerifyCooldown?.enabled ??
        DEFAULT_ANTI_ABUSE.failedVerifyCooldown.enabled,
      threshold:
        antiAbuse?.failedVerifyCooldown?.threshold ??
        DEFAULT_ANTI_ABUSE.failedVerifyCooldown.threshold,
      windowSec:
        antiAbuse?.failedVerifyCooldown?.windowSec ??
        DEFAULT_ANTI_ABUSE.failedVerifyCooldown.windowSec,
      cooldownSec:
        antiAbuse?.failedVerifyCooldown?.cooldownSec ??
        DEFAULT_ANTI_ABUSE.failedVerifyCooldown.cooldownSec,
      keying:
        antiAbuse?.failedVerifyCooldown?.keying ??
        DEFAULT_ANTI_ABUSE.failedVerifyCooldown.keying,
    },
    captcha: antiAbuse?.captcha,
  };
}

function resolveAuthRules(options: TonConnectPluginOptions) {
  return {
    onlyPrimaryCanSignIn:
      options.authRules?.onlyPrimaryCanSignIn ??
      DEFAULT_AUTH_RULES.onlyPrimaryCanSignIn,
    allowOnlyLinkedWallets:
      options.authRules?.allowOnlyLinkedWallets ??
      DEFAULT_AUTH_RULES.allowOnlyLinkedWallets,
    autoLinkOnVerify:
      options.authRules?.autoLinkOnVerify ?? DEFAULT_AUTH_RULES.autoLinkOnVerify,
  };
}

function getCaptchaToken(
  body: unknown,
  headers: Headers | null,
  captcha: TonCaptchaOptions,
): string | null {
  const headerName = captcha.headerName ?? "x-captcha-token";
  const bodyField = captcha.bodyField ?? "captchaToken";

  const headerValue = headers?.get(headerName);
  if (headerValue) return headerValue;

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const value = (body as Record<string, unknown>)[bodyField];
    if (typeof value === "string" && value.length > 0) return value;
  }

  return null;
}

function make429(
  ctx: { responseHeaders?: Headers },
  retryAfterSec: number,
  message: string,
): never {
  ctx.responseHeaders?.set("X-Retry-After", String(Math.max(1, retryAfterSec)));
  throw new APIError(429, { message });
}

async function readAbuseRecord(
  key: string,
  _ttlSec: number,
  useSecondaryStorage: boolean,
  secondaryStorage:
    | {
        get: (key: string) => unknown;
      }
    | undefined,
): Promise<TonAbuseRecord | null> {
  if (useSecondaryStorage && secondaryStorage) {
    const raw = await secondaryStorage.get(key);
    if (!raw || typeof raw !== "string") return null;
    try {
      const parsed = JSON.parse(raw) as TonAbuseRecord;
      return parsed;
    } catch {
      return null;
    }
  }

  const entry = memoryAbuseStore.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    memoryAbuseStore.delete(key);
    return null;
  }
  return entry.data;
}

async function writeAbuseRecord(
  key: string,
  value: TonAbuseRecord,
  ttlSec: number,
  useSecondaryStorage: boolean,
  secondaryStorage:
    | {
        set: (key: string, value: string, ttl?: number) => unknown;
      }
    | undefined,
): Promise<void> {
  if (useSecondaryStorage && secondaryStorage) {
    await secondaryStorage.set(key, JSON.stringify(value), ttlSec);
    return;
  }
  memoryAbuseStore.set(key, {
    data: value,
    expiresAt: Date.now() + ttlSec * 1000,
  });
}

async function deleteAbuseRecord(
  key: string,
  useSecondaryStorage: boolean,
  secondaryStorage:
    | {
        delete: (key: string) => unknown;
      }
    | undefined,
): Promise<void> {
  if (useSecondaryStorage && secondaryStorage) {
    await secondaryStorage.delete(key);
    return;
  }
  memoryAbuseStore.delete(key);
}

function cooldownKey(
  keying: "ip" | "address" | "ip+address",
  ip: string | null,
  address?: string,
): string {
  if (keying === "ip") return `${ip ?? "unknown-ip"}`;
  if (keying === "address") return `${address ?? "unknown-address"}`;
  return `${ip ?? "unknown-ip"}:${address ?? "unknown-address"}`;
}

function retryAfterSeconds(lastRequestMs: number, windowSec: number): number {
  const now = Date.now();
  return Math.ceil((lastRequestMs + windowSec * 1000 - now) / 1000);
}

async function applyRateLimit(
  ctx: {
    responseHeaders?: Headers;
    context: {
      options: {
        secondaryStorage?: {
          get: (key: string) => unknown;
          set: (key: string, value: string, ttl?: number) => unknown;
        };
      };
    };
  },
  args: {
    key: string;
    windowSec: number;
    max: number;
    useSecondaryStorage: boolean;
    message: string;
  },
): Promise<void> {
  const { key, windowSec, max, useSecondaryStorage, message } = args;
  if (max <= 0) return;

  const storage = ctx.context.options.secondaryStorage;
  const now = Date.now();
  const current = await readAbuseRecord(key, windowSec, useSecondaryStorage, storage);

  if (!current) {
    await writeAbuseRecord(
      key,
      { count: 1, lastRequest: now },
      windowSec,
      useSecondaryStorage,
      storage,
    );
    return;
  }

  if (now - current.lastRequest >= windowSec * 1000) {
    await writeAbuseRecord(
      key,
      { count: 1, lastRequest: now },
      windowSec,
      useSecondaryStorage,
      storage,
    );
    return;
  }

  if (current.count >= max) {
    make429(ctx, retryAfterSeconds(current.lastRequest, windowSec), message);
  }

  await writeAbuseRecord(
    key,
    { ...current, count: current.count + 1, lastRequest: now },
    windowSec,
    useSecondaryStorage,
    storage,
  );
}

async function enforceCooldown(
  ctx: {
    responseHeaders?: Headers;
    context: {
      options: {
        secondaryStorage?: {
          get: (key: string) => unknown;
          set: (key: string, value: string, ttl?: number) => unknown;
        };
      };
    };
  },
  args: {
    key: string;
    useSecondaryStorage: boolean;
  },
): Promise<void> {
  const storage = ctx.context.options.secondaryStorage;
  const record = await readAbuseRecord(
    args.key,
    DEFAULT_ANTI_ABUSE.failedVerifyCooldown.cooldownSec,
    args.useSecondaryStorage,
    storage,
  );
  if (!record?.blockedUntil) return;
  if (record.blockedUntil <= Date.now()) return;

  const retryAfter = Math.ceil((record.blockedUntil - Date.now()) / 1000);
  make429(
    ctx,
    retryAfter,
    "Too many failed verification attempts. Please try again later.",
  );
}

async function registerVerifyFailure(
  ctx: {
    context: {
      options: {
        secondaryStorage?: {
          get: (key: string) => unknown;
          set: (key: string, value: string, ttl?: number) => unknown;
        };
      };
    };
  },
  args: {
    key: string;
    threshold: number;
    windowSec: number;
    cooldownSec: number;
    useSecondaryStorage: boolean;
  },
): Promise<void> {
  const storage = ctx.context.options.secondaryStorage;
  const now = Date.now();
  const record = await readAbuseRecord(
    args.key,
    Math.max(args.windowSec, args.cooldownSec),
    args.useSecondaryStorage,
    storage,
  );

  if (!record || now - record.lastRequest > args.windowSec * 1000) {
    const initialCount = 1;
    const blockedUntil =
      initialCount >= args.threshold ? now + args.cooldownSec * 1000 : undefined;
    await writeAbuseRecord(
      args.key,
      { count: initialCount, lastRequest: now, blockedUntil },
      Math.max(args.windowSec, args.cooldownSec),
      args.useSecondaryStorage,
      storage,
    );
    return;
  }

  const nextCount = record.count + 1;
  const blockedUntil =
    nextCount >= args.threshold ? now + args.cooldownSec * 1000 : undefined;

  await writeAbuseRecord(
    args.key,
    {
      count: nextCount,
      lastRequest: now,
      blockedUntil,
    },
    Math.max(args.windowSec, args.cooldownSec),
    args.useSecondaryStorage,
    storage,
  );
}

async function clearVerifyFailures(
  ctx: {
    context: {
      options: {
        secondaryStorage?: {
          delete: (key: string) => unknown;
        };
      };
    };
  },
  args: {
    key: string;
    useSecondaryStorage: boolean;
  },
): Promise<void> {
  await deleteAbuseRecord(
    args.key,
    args.useSecondaryStorage,
    ctx.context.options.secondaryStorage,
  );
}

async function maybeRunCaptcha(
  ctx: {
    headers?: HeadersInit;
    request?: Request;
    body?: unknown;
  },
  args: {
    captcha: TonCaptchaOptions | undefined;
    phase: "challenge" | "verify";
    ip: string | null;
    userAgent: string | null;
    address?: string;
    network?: TonChain;
  },
): Promise<void> {
  const captcha = args.captcha;
  if (!captcha?.enabled) return;

  const headers = getHeaders(ctx);
  const token = getCaptchaToken(ctx.body, headers, captcha);
  const captchaCtx: TonCaptchaHookContext = {
    phase: args.phase,
    ip: args.ip,
    userAgent: args.userAgent,
    address: args.address,
    network: args.network,
    token,
    headers,
    requestBody: ctx.body,
  };

  const required = captcha.shouldRequire
    ? await captcha.shouldRequire(captchaCtx)
    : false;
  if (!required) return;

  if (!token) {
    throw new APIError("BAD_REQUEST", {
      message: "Captcha token is required.",
    });
  }

  const result = await captcha.verify(captchaCtx);
  const ok = typeof result === "boolean" ? result : result.ok;
  if (!ok) {
    const reason =
      typeof result === "boolean" ? undefined : (result.reason ?? undefined);
    throw new APIError("UNAUTHORIZED", {
      message: reason
        ? `Captcha verification failed: ${reason}`
        : "Captcha verification failed.",
    });
  }
}

async function emitHook<T>(
  hook: ((payload: T) => Promise<void> | void) | undefined,
  payload: T,
  ctx: {
    context: {
      logger: {
        error: (message: string, ...args: unknown[]) => void;
      };
      runInBackgroundOrAwait: (promise: Promise<unknown>) => unknown;
    };
  },
): Promise<void> {
  if (!hook) return;

  await ctx.context.runInBackgroundOrAwait(
    Promise.resolve()
      .then(() => hook(payload))
      .catch((error) => {
        ctx.context.logger.error("[ton-better-auth] event hook failed", error);
      }),
  );
}

/**
 * TON Connect sign-in plugin for Better Auth.
 */
export const tonConnect = (options: TonConnectPluginOptions) => {
  const antiAbuse = resolveAntiAbuse(options);
  const authRules = resolveAuthRules(options);
  const challengeTtlSec = options.challengeTtlSec ?? DEFAULT_CHALLENGE_TTL_SEC;
  const challengeTtlMs = challengeTtlSec * 1000;
  const abuseNamespace = `${ABUSE_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}:`;
  const emailDomain = options.emailDomain ?? "ton.local";
  const createUserEmail = options.createUserEmail ?? true;
  const events = options.events;

  const allowedDomains = options.allowedDomains;
  const allowedDomainsByNetwork = options.allowedDomainsByNetwork;
  const hasAnyAllowedDomainConfig =
    (Array.isArray(allowedDomains) && allowedDomains.length > 0) ||
    (!Array.isArray(allowedDomains) &&
      (allowedDomains.default?.length ||
        allowedDomains.mainnet?.length ||
        allowedDomains.testnet?.length ||
        allowedDomains["-239"]?.length ||
        allowedDomains["-3"]?.length)) ||
    !!(allowedDomainsByNetwork?.["-239"]?.length || allowedDomainsByNetwork?.["-3"]?.length);

  if (!hasAnyAllowedDomainConfig) {
    throw new Error(
      "[ton-better-auth] `allowedDomains` (or network-specific domain policy) must include at least one entry.",
    );
  }

  return {
    id: "ton-connect",
    schema: mergeSchema(schema, options.schema),
    rateLimit: [
      {
        pathMatcher: (path) =>
          path === "/ton-connect/challenge" || path === "/ton-connect/verify",
        window: 60,
        max: 20,
      },
    ],
    endpoints: {
      /**
       * Issue a one-time challenge payload the wallet must sign.
       */
      getTonConnectChallenge: createAuthEndpoint(
        "/ton-connect/challenge",
        {
          method: "POST",
          body: challengeBodySchema,
          metadata: {
            openapi: {
              description: "Generate a single-use ton_proof challenge payload.",
            },
          },
        },
        async (ctx) => {
          const headers = getHeaders(ctx);
          const ip = getIp(headers ?? new Headers(), ctx.context.options);
          const userAgent = getUserAgent(headers);
          const useSecondaryStorage = shouldUseSecondaryStorage(
            antiAbuse.storage,
            ctx.context.options.secondaryStorage,
          );

          if (antiAbuse.enabled) {
            await applyRateLimit(ctx, {
              key: `${abuseNamespace}challenge:ip:${ip ?? "unknown"}`,
              windowSec: antiAbuse.challenge.windowSec,
              max: antiAbuse.challenge.maxPerIp,
              useSecondaryStorage,
              message: "Too many challenge requests. Please try again later.",
            });

            if (ctx.body?.address && antiAbuse.challenge.maxPerAddress > 0) {
              await applyRateLimit(ctx, {
                key: `${abuseNamespace}challenge:address:${toRateLimitAddressKey(ctx.body.address)}`,
                windowSec: antiAbuse.challenge.windowSec,
                max: antiAbuse.challenge.maxPerAddress,
                useSecondaryStorage,
                message:
                  "Too many challenge requests for this wallet. Please try again later.",
              });
            }

            await maybeRunCaptcha(ctx, {
              captcha: antiAbuse.captcha,
              phase: "challenge",
              ip,
              userAgent,
            });
          }

          if (!ctx.context.internalAdapter?.createVerificationValue) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message:
                "Internal adapter not initialized. Ensure database migrations have been run and the verification table exists. Run: npx @better-auth/cli@latest migrate",
            });
          }

          const raw = await getSecureRandomBytes(32);
          const payload = Buffer.from(raw).toString("hex");
          const expiresAt = new Date(Date.now() + challengeTtlMs);

          await ctx.context.internalAdapter.createVerificationValue({
            identifier: `${CHALLENGE_PREFIX}${payload}`,
            value: payload,
            expiresAt,
          });

          await emitHook(
            events?.onChallengeIssued,
            {
              at: new Date(),
              ip,
              userAgent,
              payload,
              expiresAt,
            },
            ctx,
          );

          return ctx.json({
            payload,
            expiresAt: expiresAt.getTime(),
          });
        },
      ),

      /**
       * Verify a `ton_proof` reply. On success, create/link user and start a session.
       */
      verifyTonConnect: createAuthEndpoint(
        "/ton-connect/verify",
        {
          method: "POST",
          body: verifyBodySchema,
          metadata: {
            openapi: {
              description: "Verify a ton_proof and issue a session.",
            },
          },
        },
        async (ctx) => {
          const body = ctx.body;
          const headers = getHeaders(ctx);
          const ip = getIp(headers ?? new Headers(), ctx.context.options);
          const userAgent = getUserAgent(headers);
          const useSecondaryStorage = shouldUseSecondaryStorage(
            antiAbuse.storage,
            ctx.context.options.secondaryStorage,
          );

          if (antiAbuse.enabled) {
            await applyRateLimit(ctx, {
              key: `${abuseNamespace}verify:ip:${ip ?? "unknown"}`,
              windowSec: antiAbuse.verify.windowSec,
              max: antiAbuse.verify.maxPerIp,
              useSecondaryStorage,
              message: "Too many verification attempts. Please try again later.",
            });

            await applyRateLimit(ctx, {
              key: `${abuseNamespace}verify:address:${toRawAddress(body.address)}`,
              windowSec: antiAbuse.verify.windowSec,
              max: antiAbuse.verify.maxPerAddress,
              useSecondaryStorage,
              message:
                "Too many verification attempts for this wallet. Please try again later.",
            });

            await maybeRunCaptcha(ctx, {
              captcha: antiAbuse.captcha,
              phase: "verify",
              ip,
              userAgent,
              address: body.address,
              network: body.network,
            });
          }

          const rawAddress = toRawAddress(body.address);
          const verifyCooldownKey = `${abuseNamespace}verify:cooldown:${cooldownKey(
            antiAbuse.failedVerifyCooldown.keying,
            ip,
            rawAddress,
          )}`;

          if (antiAbuse.enabled && antiAbuse.failedVerifyCooldown.enabled) {
            await enforceCooldown(ctx, {
              key: verifyCooldownKey,
              useSecondaryStorage,
            });
          }

          if (!ctx.context.internalAdapter?.consumeVerificationValue) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message:
                "Internal adapter not initialized. Ensure database migrations have been run and the verification table exists. Run: npx @better-auth/cli@latest migrate",
            });
          }

          const challengeIdentifier = `${CHALLENGE_PREFIX}${body.proof.payload}`;
          const challenge =
            await ctx.context.internalAdapter.consumeVerificationValue(
              challengeIdentifier,
            );
          if (!challenge || challenge.expiresAt < new Date()) {
            await emitHook(
              events?.onVerifyFail,
              {
                at: new Date(),
                ip,
                userAgent,
                address: rawAddress,
                network: body.network,
                reason: "challenge_invalid_or_expired",
              },
              ctx,
            );
            throw new APIError("UNAUTHORIZED", {
              message: "Invalid or expired ton_proof challenge.",
            });
          }

          const proofResult = await verifyTonProof(body, {
            allowedDomains: options.allowedDomains,
            allowedDomainsByNetwork: options.allowedDomainsByNetwork,
            validAuthTimeSec: options.validAuthTimeSec ?? DEFAULT_VALID_AUTH_TIME_SEC,
            getWalletPublicKey: options.getWalletPublicKey,
            allowedWalletVersions: options.allowedWalletVersions,
          });
          if (!proofResult.ok) {
            if (antiAbuse.enabled && antiAbuse.failedVerifyCooldown.enabled) {
              await registerVerifyFailure(ctx, {
                key: verifyCooldownKey,
                threshold: antiAbuse.failedVerifyCooldown.threshold,
                windowSec: antiAbuse.failedVerifyCooldown.windowSec,
                cooldownSec: antiAbuse.failedVerifyCooldown.cooldownSec,
                useSecondaryStorage,
              });
            }

            await emitHook(
              events?.onVerifyFail,
              {
                at: new Date(),
                ip,
                userAgent,
                address: rawAddress,
                network: body.network,
                reason: proofResult.reason ?? "verification_failed",
              },
              ctx,
            );

            throw new APIError("UNAUTHORIZED", {
              message: "ton_proof verification failed.",
            });
          }

          let existingWallet = await ctx.context.adapter.findOne<TonWalletRow>({
            model: "tonWallet",
            where: [{ field: "address", operator: "eq", value: rawAddress }],
          });

          if (authRules.onlyPrimaryCanSignIn && existingWallet && !existingWallet.isPrimary) {
            await emitHook(
              events?.onVerifyFail,
              {
                at: new Date(),
                ip,
                userAgent,
                address: rawAddress,
                network: body.network,
                reason: "non_primary_wallet_signin_blocked",
              },
              ctx,
            );
            throw new APIError("UNAUTHORIZED", {
              message:
                "Only the primary wallet can sign in for this account. Set this wallet as primary first.",
            });
          }

          let user: User | null = null;
          let autoLinked = false;

          if (existingWallet) {
            user = await ctx.context.adapter.findOne<User>({
              model: "user",
              where: [{ field: "id", operator: "eq", value: existingWallet.userId }],
            });
          }

          const optionalSession = authRules.autoLinkOnVerify
            ? await getSessionFromCtx(ctx).catch(() => null)
            : null;

          if (!user && optionalSession?.user?.id && authRules.autoLinkOnVerify) {
            const owner = await ctx.context.adapter.findOne<User>({
              model: "user",
              where: [{ field: "id", operator: "eq", value: optionalSession.user.id }],
            });

            if (owner) {
              const wallets = await ctx.context.adapter.findMany<TonWalletRow>({
                model: "tonWallet",
                where: [{ field: "userId", operator: "eq", value: owner.id }],
              });

              const shouldBePrimary =
                wallets.length === 0 || authRules.onlyPrimaryCanSignIn;

              await ctx.context.adapter.transaction(async (trx) => {
                await trx.create<Omit<TonWalletRow, "id">>({
                  model: "tonWallet",
                  data: {
                    userId: owner.id,
                    address: rawAddress,
                    publicKey: body.public_key.toLowerCase(),
                    network: body.network,
                    isPrimary: shouldBePrimary,
                    createdAt: new Date(),
                  },
                });

                await normalizePrimaryWalletForUser(trx, owner.id);
              });

              await ctx.context.internalAdapter.createAccount({
                userId: owner.id,
                providerId: "ton-connect",
                accountId: rawAddress,
                createdAt: new Date(),
                updatedAt: new Date(),
              });

              autoLinked = true;
              user = owner;

              await emitHook(
                events?.onWalletLinked,
                {
                  at: new Date(),
                  ip,
                  userAgent,
                  userId: owner.id,
                  address: rawAddress,
                  network: body.network,
                  isPrimary: shouldBePrimary,
                  source: "verify-auto-link",
                },
                ctx,
              );
            }
          }

          if (!user) {
            if (authRules.allowOnlyLinkedWallets) {
              await emitHook(
                events?.onVerifyFail,
                {
                  at: new Date(),
                  ip,
                  userAgent,
                  address: rawAddress,
                  network: body.network,
                  reason: "unlinked_wallet_signin_blocked",
                },
                ctx,
              );
              throw new APIError("UNAUTHORIZED", {
                message: "Only linked wallets can sign in.",
              });
            }

            const lookup = options.addressLookup
              ? await options.addressLookup({
                  address: rawAddress,
                  network: body.network,
                })
              : undefined;

            const friendlyAddress = Address.parse(body.address).toString({
              bounceable: false,
              urlSafe: true,
            });

            const email = createUserEmail
              ? `${rawAddress.replace(":", "_")}@${emailDomain}`
              : "";

            user = await ctx.context.internalAdapter.createUser({
              name: lookup?.name ?? friendlyAddress,
              email,
              emailVerified: false,
              image: lookup?.image ?? null,
            });

            if (!user) {
              throw new APIError("INTERNAL_SERVER_ERROR", {
                message: "Failed to create user.",
              });
            }

            await ctx.context.adapter.create<Omit<TonWalletRow, "id">>({
              model: "tonWallet",
              data: {
                userId: user.id,
                address: rawAddress,
                publicKey: body.public_key.toLowerCase(),
                network: body.network,
                isPrimary: true,
                createdAt: new Date(),
              },
            });

            await ctx.context.internalAdapter.createAccount({
              userId: user.id,
              providerId: "ton-connect",
              accountId: rawAddress,
              createdAt: new Date(),
              updatedAt: new Date(),
            });

            await emitHook(
              events?.onWalletLinked,
              {
                at: new Date(),
                ip,
                userAgent,
                userId: user.id,
                address: rawAddress,
                network: body.network,
                isPrimary: true,
                source: "initial-sign-in",
              },
              ctx,
            );
          }

          await ctx.context.adapter.transaction(async (trx) => {
            await normalizePrimaryWalletForUser(trx, user.id);
          });

          if (antiAbuse.enabled && antiAbuse.failedVerifyCooldown.enabled) {
            await clearVerifyFailures(ctx, {
              key: verifyCooldownKey,
              useSecondaryStorage,
            });
          }

          const session = await ctx.context.internalAdapter.createSession(user.id, false, {
            activeTonWalletAddress: rawAddress,
            activeTonWalletNetwork: body.network,
          });
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Failed to create session.",
            });
          }

          await setSessionCookie(ctx, { session, user });

          await emitHook(
            events?.onVerifySuccess,
            {
              at: new Date(),
              ip,
              userAgent,
              userId: user.id,
              address: rawAddress,
              network: body.network,
              autoLinked,
            },
            ctx,
          );

          return ctx.json({
            success: true as const,
            token: session.token,
            user: {
              id: user.id,
              address: rawAddress,
              network: body.network,
              activeWalletAddress: rawAddress,
              activeWalletNetwork: body.network,
            },
          });
        },
      ),

      /**
       * Link an additional wallet to the currently signed-in user.
       */
      linkTonConnect: createAuthEndpoint(
        "/ton-connect/link",
        {
          method: "POST",
          body: linkBodySchema,
          use: [sessionMiddleware],
          metadata: {
            openapi: {
              description: "Link an additional TON wallet to the current user.",
            },
          },
        },
        async (ctx) => {
          const body = ctx.body;
          const user = ctx.context.session.user;
          const headers = getHeaders(ctx);
          const ip = getIp(headers ?? new Headers(), ctx.context.options);
          const userAgent = getUserAgent(headers);

          if (!ctx.context.internalAdapter?.consumeVerificationValue) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message:
                "Internal adapter not initialized. Ensure database migrations have been run and the verification table exists. Run: npx @better-auth/cli@latest migrate",
            });
          }

          const challengeIdentifier = `${CHALLENGE_PREFIX}${body.proof.payload}`;
          const challenge =
            await ctx.context.internalAdapter.consumeVerificationValue(
              challengeIdentifier,
            );
          if (!challenge || challenge.expiresAt < new Date()) {
            throw new APIError("UNAUTHORIZED", {
              message: "Invalid or expired ton_proof challenge.",
            });
          }

          const result = await verifyTonProof(body, {
            allowedDomains: options.allowedDomains,
            allowedDomainsByNetwork: options.allowedDomainsByNetwork,
            validAuthTimeSec: options.validAuthTimeSec ?? DEFAULT_VALID_AUTH_TIME_SEC,
            getWalletPublicKey: options.getWalletPublicKey,
            allowedWalletVersions: options.allowedWalletVersions,
          });
          if (!result.ok) {
            throw new APIError("UNAUTHORIZED", {
              message: "ton_proof verification failed.",
            });
          }

          const rawAddress = toRawAddress(body.address);
          const existing = await ctx.context.adapter.findOne<TonWalletRow>({
            model: "tonWallet",
            where: [{ field: "address", operator: "eq", value: rawAddress }],
          });

          if (existing) {
            if (existing.userId !== user.id) {
              throw new APIError("CONFLICT", {
                message: "Wallet is already linked to another account.",
              });
            }
            return ctx.json({
              success: true as const,
              address: rawAddress,
              alreadyLinked: true as const,
            });
          }

          await ctx.context.adapter.transaction(async (trx) => {
            await trx.create<Omit<TonWalletRow, "id">>({
              model: "tonWallet",
              data: {
                userId: user.id,
                address: rawAddress,
                publicKey: body.public_key.toLowerCase(),
                network: body.network,
                isPrimary: false,
                createdAt: new Date(),
              },
            });

            await normalizePrimaryWalletForUser(trx, user.id);
          });

          await ctx.context.internalAdapter.createAccount({
            userId: user.id,
            providerId: "ton-connect",
            accountId: rawAddress,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          const linkedWallet = await ctx.context.adapter.findOne<TonWalletRow>({
            model: "tonWallet",
            where: [{ field: "address", operator: "eq", value: rawAddress }],
          });

          await emitHook(
            events?.onWalletLinked,
            {
              at: new Date(),
              ip,
              userAgent,
              userId: user.id,
              address: rawAddress,
              network: body.network,
              isPrimary: linkedWallet?.isPrimary ?? false,
              source: "link-endpoint",
            },
            ctx,
          );

          return ctx.json({
            success: true as const,
            address: rawAddress,
            alreadyLinked: false as const,
          });
        },
      ),

      /**
       * Unlink a TON wallet from the current user.
       */
      unlinkTonConnect: createAuthEndpoint(
        "/ton-connect/unlink",
        {
          method: "POST",
          body: unlinkBodySchema,
          use: [sessionMiddleware],
          metadata: {
            openapi: {
              description: "Remove a TON wallet from the current user.",
            },
          },
        },
        async (ctx) => {
          const user = ctx.context.session.user;
          const rawAddress = toRawAddress(ctx.body.address);

          await ctx.context.adapter.transaction(async (trx) => {
            const target = await trx.findOne<TonWalletRow>({
              model: "tonWallet",
              where: [
                { field: "address", operator: "eq", value: rawAddress },
                { field: "userId", operator: "eq", value: user.id },
              ],
            });
            if (!target) {
              throw new APIError("NOT_FOUND", {
                message: "Wallet is not linked to this account.",
              });
            }

            const others = await trx.findMany<TonWalletRow>({
              model: "tonWallet",
              where: [{ field: "userId", operator: "eq", value: user.id }],
            });

            if (others.length <= 1) {
              throw new APIError("BAD_REQUEST", {
                message:
                  "Cannot unlink the last remaining wallet for this account.",
              });
            }

            await trx.delete({
              model: "tonWallet",
              where: [{ field: "id", operator: "eq", value: target.id }],
            });

            await normalizePrimaryWalletForUser(trx, user.id);
          });

          return ctx.json({ success: true as const });
        },
      ),

      /** Explicitly set which linked wallet is primary. */
      setPrimaryTonConnectWallet: createAuthEndpoint(
        "/ton-connect/set-primary",
        {
          method: "POST",
          body: setPrimaryBodySchema,
          use: [sessionMiddleware],
          metadata: {
            openapi: {
              description: "Set a linked TON wallet as primary.",
            },
          },
        },
        async (ctx) => {
          const user = ctx.context.session.user;
          const rawAddress = toRawAddress(ctx.body.address);

          await ctx.context.adapter.transaction(async (trx) => {
            const wallet = await trx.findOne<TonWalletRow>({
              model: "tonWallet",
              where: [
                { field: "address", operator: "eq", value: rawAddress },
                { field: "userId", operator: "eq", value: user.id },
              ],
            });
            if (!wallet) {
              throw new APIError("NOT_FOUND", {
                message: "Wallet is not linked to this account.",
              });
            }

            await trx.updateMany({
              model: "tonWallet",
              where: [
                { field: "userId", operator: "eq", value: user.id },
                { field: "id", operator: "ne", value: wallet.id },
              ],
              update: { isPrimary: false },
            });

            await trx.update({
              model: "tonWallet",
              where: [{ field: "id", operator: "eq", value: wallet.id }],
              update: { isPrimary: true },
            });
          });

          return ctx.json({
            success: true as const,
            address: rawAddress,
          });
        },
      ),

      /** Switch active wallet context for the current session. */
      switchTonConnectSessionWallet: createAuthEndpoint(
        "/ton-connect/switch-session-wallet",
        {
          method: "POST",
          body: switchWalletSessionBodySchema,
          use: [sessionMiddleware],
          metadata: {
            openapi: {
              description:
                "Switch active TON wallet context for current session.",
            },
          },
        },
        async (ctx) => {
          const user = ctx.context.session.user;
          const activeSession = ctx.context.session.session;
          const rawAddress = toRawAddress(ctx.body.address);

          const wallet = await ctx.context.adapter.findOne<TonWalletRow>({
            model: "tonWallet",
            where: [
              { field: "address", operator: "eq", value: rawAddress },
              { field: "userId", operator: "eq", value: user.id },
            ],
          });
          if (!wallet) {
            throw new APIError("NOT_FOUND", {
              message: "Wallet is not linked to this account.",
            });
          }

          const updatedSession =
            (await ctx.context.internalAdapter.updateSession(activeSession.token, {
              activeTonWalletAddress: rawAddress,
              activeTonWalletNetwork: wallet.network,
              updatedAt: new Date(),
            })) ??
            {
              ...activeSession,
              activeTonWalletAddress: rawAddress,
              activeTonWalletNetwork: wallet.network,
              updatedAt: new Date(),
            };

          await setSessionCookie(ctx, {
            session: updatedSession,
            user,
          });

          return ctx.json({
            success: true as const,
            activeWalletAddress: rawAddress,
            activeWalletNetwork: wallet.network,
          });
        },
      ),

      /** List linked wallets for current user. */
      listTonWallets: createAuthEndpoint(
        "/ton-connect/wallets",
        {
          method: "GET",
          use: [sessionMiddleware],
          metadata: {
            openapi: {
              description: "List the current user's linked TON wallets.",
            },
          },
        },
        async (ctx) => {
          const user = ctx.context.session.user;
          const activeWalletAddress =
            (ctx.context.session.session as { activeTonWalletAddress?: string | null })
              .activeTonWalletAddress ?? null;

          const wallets = await ctx.context.adapter.findMany<TonWalletRow>({
            model: "tonWallet",
            where: [{ field: "userId", operator: "eq", value: user.id }],
          });

          return ctx.json({
            activeWalletAddress,
            wallets: wallets.map((w) => ({
              address: w.address,
              publicKey: w.publicKey,
              network: w.network,
              isPrimary: w.isPrimary,
              isActive: activeWalletAddress === w.address,
              createdAt: w.createdAt,
            })),
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
};

export type TonConnectPlugin = ReturnType<typeof tonConnect>;
