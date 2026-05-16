/**
 * Better Auth plugin: Sign in with TON Connect (`ton_proof`).
 *
 * The plugin exposes three endpoints under the `/ton-connect` namespace:
 *
 *   POST /ton-connect/challenge
 *     Issue a one-time payload for the wallet to sign.
 *
 *   POST /ton-connect/verify
 *     Verify a `ton_proof` reply, create / link the user, start a session.
 *
 *   POST /ton-connect/link        (authenticated)
 *     Link an additional wallet to the current user.
 *
 *   POST /ton-connect/unlink      (authenticated)
 *     Remove a wallet link from the current user.
 *
 *   GET  /ton-connect/wallets     (authenticated)
 *     List the current user's linked wallets.
 *
 * Tokens issued by `/challenge` are stored in Better Auth's `verification`
 * table under the identifier `ton-proof-challenge:<nonce>` and are single
 * use. They must be presented back as `proof.payload` when verifying.
 */
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
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
  TonChain,
} from "./types.js";
import { verifyTonProof } from "./verify.js";

const CHALLENGE_PREFIX = "ton-proof-challenge:";

const tonChain = z.enum(["-239", "-3"]);

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
});

const linkBodySchema = verifyBodySchema;

const unlinkBodySchema = z.object({
  address: z.string().min(1),
});

export interface TonConnectPluginOptions {
  /**
   * Allowed app domains, in the exact form TON Connect sends them
   * (e.g. `"example.com"`, `"app.example.com:5173"`). The wallet's
   * signed domain must match one of these entries.
   */
  allowedDomains: string[];
  /**
   * Email domain used to synthesise placeholder emails for new users.
   * Defaults to `"ton.local"`. Emails look like `<address>@<domain>`.
   */
  emailDomain?: string;
  /**
   * How long, in seconds, a `ton_proof` is considered valid after it
   * was produced. Defaults to 15 minutes.
   */
  validAuthTimeSec?: number;
  /**
   * How long, in seconds, an issued challenge remains valid before it
   * must be re-requested. Defaults to 10 minutes.
   */
  challengeTtlSec?: number;
  /**
   * Fallback used when the wallet's state init can't be parsed (older
   * or non-standard wallet contracts). Should call `get_public_key` on
   * the wallet contract via a TON API client and return the raw key.
   */
  getWalletPublicKey?: GetWalletPublicKey;
  /**
   * Optional hook for resolving a display name / avatar for new users
   * (e.g. from TON DNS or a social profile service).
   */
  addressLookup?: TonAddressLookup;
  /**
   * Whether users created by TON Connect should receive a synthesised
   * email address. Defaults to `true`; set to `false` if your schema
   * allows nullable emails and you want to leave the field empty.
   */
  createUserEmail?: boolean;
  /**
   * Override the Better Auth plugin schema — useful for renaming the
   * table or adding additional fields.
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
  findMany: <T>(data: {
    model: string;
    where?: Where[];
  }) => Promise<T[]>;
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

/** Convert any TON address representation to the canonical `wc:hex` raw form. */
function toRawAddress(address: string): string {
  return Address.parse(address).toRawString();
}

/**
 * The TON Connect sign-in plugin for Better Auth.
 */
export const tonConnect = (options: TonConnectPluginOptions) => {
  if (!options.allowedDomains?.length) {
    throw new Error(
      "[ton-better-auth] `allowedDomains` must contain at least one entry.",
    );
  }
  const challengeTtlMs = (options.challengeTtlSec ?? 10 * 60) * 1000;
  const emailDomain = options.emailDomain ?? "ton.local";
  const createUserEmail = options.createUserEmail ?? true;

  return {
    id: "ton-connect",
    schema: mergeSchema(schema, options.schema),
    rateLimit: [
      {
        pathMatcher: (path) =>
          path === "/ton-connect/challenge" ||
          path === "/ton-connect/verify",
        window: 60,
        max: 20,
      },
    ],
    endpoints: {
      /**
       * Issue a one-time challenge payload the wallet must sign.
       * The nonce is stored in the `verification` table and consumed
       * on `/verify`.
       */
      getTonConnectChallenge: createAuthEndpoint(
        "/ton-connect/challenge",
        {
          method: "POST",
          body: z.object({}).optional(),
          metadata: {
            openapi: {
              description:
                "Generate a single-use ton_proof challenge payload.",
              responses: {
                "200": {
                  description: "New challenge payload",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          payload: { type: "string" },
                          expiresAt: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (ctx) => {
          const raw = await getSecureRandomBytes(32);
          const payload = Buffer.from(raw).toString("hex");
          const expiresAt = new Date(Date.now() + challengeTtlMs);

          if (!ctx.context.internalAdapter?.createVerificationValue) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message:
                "Internal adapter not initialized. Ensure database migrations have been run and the verification table exists. Run: npx @better-auth/cli@latest migrate",
            });
          }

          await ctx.context.internalAdapter.createVerificationValue({
            identifier: `${CHALLENGE_PREFIX}${payload}`,
            value: payload,
            expiresAt,
          });

          return ctx.json({
            payload,
            expiresAt: expiresAt.getTime(),
          });
        },
      ),

      /**
       * Verify a `ton_proof` reply. On success, creates the user if
       * needed, links the wallet, and starts a session (cookie + token).
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

          if (!ctx.context.internalAdapter?.consumeVerificationValue) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message:
                "Internal adapter not initialized. Ensure database migrations have been run and the verification table exists. Run: npx @better-auth/cli@latest migrate",
            });
          }

          // Atomically consume the challenge — single use, race-safe.
          const identifier = `${CHALLENGE_PREFIX}${body.proof.payload}`;
          const verification =
            await ctx.context.internalAdapter.consumeVerificationValue(
              identifier,
            );
          if (!verification || verification.expiresAt < new Date()) {
            throw new APIError("UNAUTHORIZED", {
              message: "Invalid or expired ton_proof challenge.",
            });
          }

          // Verify the proof itself.
          const result = await verifyTonProof(body, {
            allowedDomains: options.allowedDomains,
            validAuthTimeSec: options.validAuthTimeSec,
            getWalletPublicKey: options.getWalletPublicKey,
          });
          if (!result.ok) {
            throw new APIError("UNAUTHORIZED", {
              message: "ton_proof verification failed.",
            });
          }

          const rawAddress = toRawAddress(body.address);

          // Look for an existing wallet link.
          const existing = await ctx.context.adapter.findOne<TonWalletRow>({
            model: "tonWallet",
            where: [
              { field: "address", operator: "eq", value: rawAddress },
            ],
          });

          let user: User | null = null;

          if (existing) {
            user = await ctx.context.adapter.findOne<User>({
              model: "user",
              where: [
                { field: "id", operator: "eq", value: existing.userId },
              ],
            });
          }

          if (!user) {
            // Create a new user. Email is synthesised from the address.
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
          }

          await ctx.context.adapter.transaction(async (trx) => {
            await normalizePrimaryWalletForUser(trx, user.id);
          });

          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            false,
          );
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Failed to create session.",
            });
          }

          await setSessionCookie(ctx, { session, user });

          return ctx.json({
            success: true as const,
            token: session.token,
            user: {
              id: user.id,
              address: rawAddress,
              network: body.network,
            },
          });
        },
      ),

      /**
       * Link an additional TON wallet to the currently signed-in user.
       * Requires the client to submit a fresh ton_proof for the wallet.
       */
      linkTonConnect: createAuthEndpoint(
        "/ton-connect/link",
        {
          method: "POST",
          body: linkBodySchema,
          use: [sessionMiddleware],
          metadata: {
            openapi: {
              description:
                "Link an additional TON wallet to the current user.",
            },
          },
        },
        async (ctx) => {
          const body = ctx.body;
          const user = ctx.context.session.user;

          if (!ctx.context.internalAdapter?.consumeVerificationValue) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message:
                "Internal adapter not initialized. Ensure database migrations have been run and the verification table exists. Run: npx @better-auth/cli@latest migrate",
            });
          }

          const identifier = `${CHALLENGE_PREFIX}${body.proof.payload}`;
          const verification =
            await ctx.context.internalAdapter.consumeVerificationValue(
              identifier,
            );
          if (!verification || verification.expiresAt < new Date()) {
            throw new APIError("UNAUTHORIZED", {
              message: "Invalid or expired ton_proof challenge.",
            });
          }

          const result = await verifyTonProof(body, {
            allowedDomains: options.allowedDomains,
            validAuthTimeSec: options.validAuthTimeSec,
            getWalletPublicKey: options.getWalletPublicKey,
          });
          if (!result.ok) {
            throw new APIError("UNAUTHORIZED", {
              message: "ton_proof verification failed.",
            });
          }

          const rawAddress = toRawAddress(body.address);
          const existing = await ctx.context.adapter.findOne<TonWalletRow>({
            model: "tonWallet",
            where: [
              { field: "address", operator: "eq", value: rawAddress },
            ],
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

          return ctx.json({
            success: true as const,
            address: rawAddress,
            alreadyLinked: false as const,
          });
        },
      ),

      /**
       * Unlink a TON wallet from the current user. Refuses to remove
       * the last remaining wallet if the user has no other credentials.
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
              // Refuse to remove the last wallet — otherwise the user
              // could lock themselves out if they have no other auth method.
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

      /** List the currently authenticated user's linked wallets. */
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
          const wallets = await ctx.context.adapter.findMany<TonWalletRow>({
            model: "tonWallet",
            where: [{ field: "userId", operator: "eq", value: user.id }],
          });
          return ctx.json({
            wallets: wallets.map((w) => ({
              address: w.address,
              publicKey: w.publicKey,
              network: w.network,
              isPrimary: w.isPrimary,
              createdAt: w.createdAt,
            })),
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
};

export type TonConnectPlugin = ReturnType<typeof tonConnect>;
