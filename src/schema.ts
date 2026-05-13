/**
 * Database schema additions for the TON Connect plugin.
 *
 * A single table `tonWallet` links one or more TON wallet addresses to
 * a Better Auth `user`. The user may have multiple wallets; exactly one
 * is marked `isPrimary` per user (enforced at the application layer).
 */
import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";

export const schema = {
  tonWallet: {
    fields: {
      userId: {
        type: "string",
        references: {
          model: "user",
          field: "id",
          onDelete: "cascade",
        },
        required: true,
      },
      /**
       * Canonical raw address in `workchain:hex` form, e.g.
       * `0:83d...af8`. We store the raw form so addresses are stable
       * regardless of bounceable / non-bounceable encoding.
       */
      address: {
        type: "string",
        required: true,
        unique: true,
      },
      /** Hex-encoded Ed25519 public key. */
      publicKey: {
        type: "string",
        required: true,
      },
      /** TON network id: `-239` for mainnet, `-3` for testnet. */
      network: {
        type: "string",
        required: true,
      },
      /** Whether this wallet is the user's primary TON identity. */
      isPrimary: {
        type: "boolean",
        required: true,
        defaultValue: false,
      },
      createdAt: {
        type: "date",
        required: true,
      },
    },
  },
} satisfies BetterAuthPluginDBSchema;

export type TonSchema = typeof schema;
