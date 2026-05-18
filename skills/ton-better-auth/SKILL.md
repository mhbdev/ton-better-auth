---
name: ton-better-auth
description: >
  Integrate TON Connect wallet authentication into Better Auth projects.
  This skill guides agents through setting up "Sign in with TON" using ton_proof verification,
  configuring the server plugin, wiring up the client, and connecting with @tonconnect/ui-react.
license: MIT
compatibility: Requires better-auth (>=1.3.0) and @better-auth/core
metadata:
  author: mhbdev
  version: "0.1.2"
  repository: https://github.com/mhbdev/ton-better-auth
---

# TON Better Auth Integration

Integrate TON Connect wallet authentication into Better Auth projects using the `ton-better-auth` package. This package provides a complete server plugin for verifying `ton_proof` payloads and a matching client plugin for typed helpers.

## Package Overview

`ton-better-auth` is a Better Auth plugin that adds "Sign in with TON Connect" using the official `ton_proof` protocol. It handles:

- Server-side verification of `ton_proof` payloads
- Replayable nonce challenges stored in the verification table
- Signature verification with Ed25519
- Wallet state-init parsing (v1 through v5)
- On-chain `get_public_key` fallback for non-standard wallets
- Session creation and user management via Better Auth
- Multi-wallet linking per user

## Installation

```bash
npm install ton-better-auth
```

Peer dependencies: `better-auth` (>= 1.3) and `@better-auth/core`.
Optional peer dependency for React helper: `react` (>= 18).

## Quick Start

### 1. Server Setup

```typescript
// src/auth.ts
import { betterAuth } from "better-auth";
import { tonConnect } from "ton-better-auth";

export const auth = betterAuth({
  database: /* your adapter */,
  plugins: [
    tonConnect({
      // Exactly the host the wallet signs. No protocol.
      // Include the port if your dev UI runs on one.
      allowedDomains: ["example.com", "localhost:5173"],
    }),
  ],
});
```

### 2. Database Migration

Run the CLI to generate/apply the `tonWallet` table:

```bash
npx @better-auth/cli@latest migrate
```

### 3. Client Setup

```typescript
// src/auth-client.ts
import { createAuthClient } from "better-auth/client";
import { tonConnectClient } from "ton-better-auth/client";

export const authClient = createAuthClient({
  plugins: [tonConnectClient()],
});
```

## Server Configuration Options

```typescript
tonConnect({
  // Required: domain policy (supports wildcard and per-network entries)
  allowedDomains: {
    default: ["your-app.com", "*.your-app.com"],
    testnet: ["localhost:3000"],
  },
  // Optional additive per-network policy
  allowedDomainsByNetwork: {
    "-3": ["*.dev.your-app.com"],
  },
  
  // Optional: signature TTL (default: 15 minutes)
  validAuthTimeSec: 15 * 60,
  
  // Optional: challenge nonce TTL (default: 10 minutes)
  challengeTtlSec: 10 * 60,
  
  // Optional: email domain for synthesized user emails
  emailDomain: "ton.local",
  
  // Optional: fallback when state-init parsing fails
  getWalletPublicKey: async (address, network) => {
    // Use @ton/ton's TonClient to call get_public_key
    return null;
  },
  
  // Optional: enrich new users from TON DNS
  addressLookup: async ({ address, network }) => ({
    name: "Alice",
    image: "https://example.com/avatar.png"
  }),
  
  // Optional: disable email synthesis
  createUserEmail: false,

  // Optional: anti-abuse controls
  antiAbuse: {
    challenge: { windowSec: 60, maxPerIp: 20, maxPerAddress: 0 },
    verify: { windowSec: 60, maxPerIp: 20, maxPerAddress: 8 },
    failedVerifyCooldown: {
      enabled: true,
      threshold: 5,
      windowSec: 10 * 60,
      cooldownSec: 10 * 60,
      keying: "ip+address",
    },
  },

  // Optional: multi-wallet sign-in behavior
  authRules: {
    onlyPrimaryCanSignIn: false,
    allowOnlyLinkedWallets: false,
    autoLinkOnVerify: true,
  },

  // Optional: lifecycle hooks
  events: {
    onChallengeIssued: async (event) => {},
    onVerifySuccess: async (event) => {},
    onVerifyFail: async (event) => {},
    onWalletLinked: async (event) => {},
  },
});
```

## Available Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/ton-connect/challenge` | no | Issue a one-shot `ton_proof` payload |
| POST | `/ton-connect/verify` | no | Verify a `ton_proof` and start a session |
| POST | `/ton-connect/link` | yes | Link an extra TON wallet to the user |
| POST | `/ton-connect/unlink` | yes | Remove a linked wallet |
| POST | `/ton-connect/set-primary` | yes | Explicitly set a linked wallet as primary |
| POST | `/ton-connect/switch-session-wallet` | yes | Switch active wallet context for the current session |
| GET | `/ton-connect/wallets` | yes | List the current user's linked wallets |

## Client API Methods

```typescript
// Get a challenge for the wallet to sign
const { data, error } = await authClient.tonConnect.challenge();

// Verify ton_proof and start a session
const { error } = await authClient.tonConnect.verify({
  address: wallet.account.address,
  network: wallet.account.chain,
  public_key: wallet.account.publicKey!,
  proof: {
    timestamp: item.proof.timestamp,
    domain: item.proof.domain,
    payload: item.proof.payload,
    signature: item.proof.signature,
    state_init: wallet.account.walletStateInit,
  },
});

// Link an additional wallet (requires authentication)
const { error } = await authClient.tonConnect.link({ /* same as verify */ });

// Unlink a wallet (requires authentication)
const { error } = await authClient.tonConnect.unlink({ address: "0:abc..." });

// List linked wallets (requires authentication)
const { data, error } = await authClient.tonConnect.wallets();

// Set a linked wallet as primary (requires authentication)
const { error: setPrimaryError } = await authClient.tonConnect.setPrimary({
  address: "0:abc...",
});

// Rotate active wallet context for current session (requires authentication)
const { error: switchSessionError } =
  await authClient.tonConnect.switchSessionWallet({
    address: "0:def...",
  });
```

## React Integration with @tonconnect/ui-react

```tsx
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { useTonConnectAuth } from "ton-better-auth/react";
import { authClient } from "./auth-client";

export function SignInButton() {
  const [tonConnectUI] = useTonConnectUI();
  const wallet = useTonWallet();
  const { authenticated, status, error, disconnect, refreshChallenge } =
    useTonConnectAuth({
      tonConnectUI,
      authClient,
      refreshIntervalMs: 9 * 60 * 1000,
      // Optional when server captcha checks are enabled
      getCaptchaToken: async ({ phase }) =>
        phase === "challenge" ? localStorage.getItem("captcha-token") : null,
      onError: (e) => console.error(e.code, e.message),
    });

  if (authenticated) {
    return (
      <button onClick={() => void disconnect()}>
        Disconnect {wallet?.account.address.slice(0, 6)}...
      </button>
    );
  }

  return (
    <button
      onClick={() => {
        void refreshChallenge();
        void tonConnectUI.openModal();
      }}
      disabled={status === "loading-challenge" || status === "verifying"}
      title={error?.message}
    >
      Sign in
    </button>
  );
}
```

`useTonConnectAuth` provides typed status and error lifecycle:
- `status`: `idle | loading-challenge | ready | verifying | authenticated | error`
- `error.code`: stable typed error codes (challenge/verify/wallet payload cases)
- helpers: `refreshChallenge()`, `disconnect()`, and optional captcha integration

## Standalone Verification

Use the verifier without the Better Auth plugin:

```typescript
import { verifyTonProof } from "ton-better-auth";

const result = await verifyTonProof(
  {
    address: "0:...",
    network: "-239",
    public_key: "...",
    proof: { timestamp, domain, payload, signature, state_init },
  },
  { allowedDomains: ["example.com"] },
);

if (!result.ok) {
  console.warn("ton_proof rejected:", result.reason);
}
```

## Runtime Compatibility

`ton-better-auth` depends on TON libraries that require Node.js primitives (primarily `Buffer`):

| Runtime | Setup Required |
|---------|----------------|
| Node.js 18+ | None (works out of the box) |
| Bun | None (Buffer provided) |
| Cloudflare Workers | Enable `nodejs_compat` flag in wrangler.toml |
| Vercel Edge Runtime | Use Node.js runtime (default) or add Buffer polyfill |
| Deno | Import `Buffer` from `node:buffer` |
| Browser | Use bundler polyfills (vite-plugin-node-polyfills) |

See the `ton-better-auth-runtime` skill for detailed runtime configuration.

## Security Notes

- Challenges are stored in the Better Auth `verification` table and consumed atomically
- Signatures older than `validAuthTimeSec` are rejected (default: 15 minutes)
- Signed domain policy supports wildcard patterns and per-network rules
- Anti-abuse supports per-IP/per-address limits, failed-verify cooldown, and optional captcha hooks
- The verifier follows the reference implementation from TON Connect demo dApp

## Common Issues

### "Buffer is not defined"

This error occurs in non-Node.js runtimes. Solutions:

1. **Cloudflare Workers**: Add `compatibility_flags = ["nodejs_compat"]` to wrangler.toml
2. **Vercel Edge**: Don't use edge runtime for auth routes, or add Buffer polyfill
3. **Browser**: Install `vite-plugin-node-polyfills` or webpack fallbacks

### Challenge not accepted

Verify `allowedDomains` matches exactly what the wallet signs (including port in development).

### Multiple verify calls

Ensure `onStatusChange` cleanup is working properly to avoid stacked listeners.

## Resources

- [Package Repository](https://github.com/mhbdev/ton-better-auth)
- [Better Auth Documentation](https://better-auth.com)
- [TON Connect Documentation](https://docs.ton.org/v3/guidelines/ton-connect/verifying-signed-in-users)
- [TON Connect UI React](https://github.com/ton-connect/sdk/tree/main/packages/ui-react)

## When to Use This Skill

- User wants to add TON wallet authentication to a Better Auth project
- User needs to implement "Sign in with TON" using TON Connect
- User is building a dApp that requires wallet-based authentication
- User needs to verify `ton_proof` payloads server-side
- User wants to link multiple TON wallets to a single user account

## Workflow for Agents

1. **Assess the project**: Check if it uses Better Auth and needs TON authentication
2. **Install package**: Add `ton-better-auth` to dependencies
3. **Configure server**: Set up the `tonConnect` plugin with proper `allowedDomains`
4. **Run migrations**: Execute `npx @better-auth/cli@latest migrate` to create tables
5. **Set up client**: Add `tonConnectClient` to the auth client
6. **Integrate UI**: Wire up with `@tonconnect/ui-react` or other TON Connect client
7. **Test flow**: Verify challenge generation, proof verification, and session creation
8. **Handle runtime**: Address Buffer requirements for the target environment
