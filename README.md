# ton-better-auth

<img width="200" height="200" alt="image" src="https://github.com/user-attachments/assets/40ad78aa-5621-4afd-8277-145fc843930a" />


Sign in with TON Connect for [Better Auth](https://better-auth.com). Ships
a server plugin that verifies `ton_proof` payloads end-to-end (replayable
nonce challenge, signature verification, wallet state-init parsing for v1
through v5, and on-chain `get_public_key` fallback) plus a matching
client plugin that gives you typed helpers on your Better Auth client.

## Why

TON Connect returns a `ton_proof` item to your dApp after the user picks
a wallet. The TON protocol docs describe the exact verification steps:

- https://docs.ton.org/v3/guidelines/ton-connect/verifying-signed-in-users
- https://github.com/ton-blockchain/ton-connect/blob/main/requests-responses.md#address-proof-signature-ton_proof

This package implements the server side of that flow and plugs it into
Better Auth's session machinery, so you get a normal Better Auth session
cookie after a successful TON wallet sign-in.

## Install

```bash
npm install ton-better-auth
```

Peer dependencies: `better-auth` (>= 1.3) and `@better-auth/core`.
Optional peer for `ton-better-auth/react`: `react` (>= 18).

## Server setup

```ts
// src/auth.ts
import { betterAuth } from "better-auth";
import { tonConnect } from "ton-better-auth";

export const auth = betterAuth({
  database: /* your adapter */,
  plugins: [
    tonConnect({
      // Domain policy can be global string[] or per-network object.
      // Supports wildcard patterns (e.g. *.example.com).
      allowedDomains: {
        default: ["example.com", "*.example.com"],
        mainnet: ["app.example.com"],
        testnet: ["localhost:5173", "*.staging.example.com"],
      },
      // Optional additive policy by network id.
      allowedDomainsByNetwork: {
        "-3": ["*.dev.example.com"],
      },
      // Optional tweaks:
      validAuthTimeSec: 15 * 60,  // signature TTL, defaults to 15 min
      challengeTtlSec: 10 * 60,   // nonce TTL, defaults to 10 min
      emailDomain: "ton.local",   // used to synth an email for new users
      antiAbuse: {
        verify: { maxPerIp: 20, maxPerAddress: 8, windowSec: 60 },
        failedVerifyCooldown: {
          enabled: true,
          threshold: 5,
          windowSec: 10 * 60,
          cooldownSec: 10 * 60,
          keying: "ip+address",
        },
      },
      authRules: {
        onlyPrimaryCanSignIn: false,
        allowOnlyLinkedWallets: false,
        autoLinkOnVerify: true,
      },
      events: {
        onVerifySuccess: async (event) => {
          console.log("TON verify success", event.userId, event.address);
        },
      },
      // Optional: fallback when state-init parsing fails (rare).
      // Called as getWalletPublicKey(address, network).
      getWalletPublicKey: async (address) => {
        // e.g. use @ton/ton's TonClient to call the wallet's get_public_key.
        return null;
      },
      // Optional: enrich new users with a name / avatar from TON DNS.
      addressLookup: async ({ address }) => ({ name: "Alice", image: "…" }),
    }),
  ],
});
```

Run the CLI to generate / apply the `tonWallet` table:

```bash
npx @better-auth/cli@latest migrate
# or, for Prisma / Drizzle:
npx @better-auth/cli@latest generate
```

## Client setup

```ts
// src/auth-client.ts
import { createAuthClient } from "better-auth/client";
import { tonConnectClient } from "ton-better-auth/client";

export const authClient = createAuthClient({
  plugins: [tonConnectClient()],
});
```

## Sign-in flow

The plugin exposes these endpoints under `/ton-connect`:

| Method | Path                      | Auth | Purpose                                    |
|--------|---------------------------|------|--------------------------------------------|
| POST   | `/ton-connect/challenge`  | no   | Issue a one-shot `ton_proof` payload (`body.address` optional) |
| POST   | `/ton-connect/verify`     | no   | Verify a `ton_proof` and start a session   |
| POST   | `/ton-connect/link`       | yes  | Link an extra TON wallet to the user       |
| POST   | `/ton-connect/unlink`     | yes  | Remove a linked wallet                     |
| POST   | `/ton-connect/set-primary`| yes  | Set a linked wallet as primary             |
| POST   | `/ton-connect/switch-session-wallet` | yes | Rotate active wallet context in session |
| GET    | `/ton-connect/wallets`    | yes  | List the current user's linked wallets     |

Lifecycle hooks:

- `onChallengeIssued`
- `onVerifySuccess`
- `onVerifyFail`
- `onWalletLinked`

### Wiring with `@tonconnect/ui-react` (recommended)

Use the built-in React helper from `ton-better-auth/react`. It wraps
challenge refresh + verify lifecycle + typed error states:

```tsx
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { useTonConnectAuth } from "ton-better-auth/react";
import { authClient } from "./auth-client";

export function SignInButton() {
  const [tonConnectUI] = useTonConnectUI();
  const wallet = useTonWallet();
  const {
    authenticated,
    status,
    error,
    disconnect,
    refreshChallenge,
  } = useTonConnectAuth({
    tonConnectUI,
    authClient,
    refreshIntervalMs: 9 * 60 * 1000,
    // Optional when server captcha checks are enabled.
    getCaptchaToken: async ({ phase }) =>
      phase === "challenge" ? window.localStorage.getItem("captcha-token") : null,
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
      Sign in with TON
    </button>
  );
}
```

`useTonConnectAuth` exposes:

- `status`: `idle | loading-challenge | ready | verifying | authenticated | error`
- `error`: typed error object with stable `code`
- `refreshChallenge()` and `disconnect()` helpers
- optional `getCaptchaToken` callback for captcha-protected flows
- lifecycle callbacks like `onVerified` / `onError`

## What gets stored

- A new user row when a wallet first signs in (email is synthesised as
  `<raw-address>@<emailDomain>`, `emailVerified: false`).
- A row in `account` with `providerId: "ton-connect"` and the raw address
  as `accountId`.
- A row in the plugin's `tonWallet` table holding `address`, `publicKey`,
  `network`, `isPrimary`, `createdAt`, linked to the user via `userId`.
- Session metadata `activeTonWalletAddress` and `activeTonWalletNetwork`
  so wallet-scoped dApps can switch active context without switching user.

A user may link additional wallets through `/ton-connect/link`; the first
is flagged as primary, and the plugin refuses to unlink the last one so
the account can't be locked out. Use `/ton-connect/set-primary` to choose
the primary wallet explicitly, and `/ton-connect/switch-session-wallet`
to rotate the active wallet for the current session.

## Security notes

- Challenges are stored in the Better Auth `verification` table and
  consumed atomically via `consumeVerificationValue`, so a valid
  `ton_proof` can only be used once.
- Signatures older than `validAuthTimeSec` are rejected.
- Domain policy supports exact entries, wildcard patterns (`*`), and
  per-network rules (`mainnet`/`testnet` or `-239`/`-3`).
- Anti-abuse controls include per-IP and per-address limits, failed
  verification cooldown, and optional captcha challenge/verify hooks.
  Default verify limits: `20/ip/min`, `8/address/min`.
- The verifier follows the reference implementation from the TON
  Connect demo dApp — it parses the `walletStateInit` to extract the
  public key, cross-checks it against the client-reported `public_key`,
  and re-derives the contract address to match the claimed one.

## Programmatic verification

You can use the verifier on its own without the Better Auth plugin:

```ts
import { verifyTonProof } from "ton-better-auth";

const result = await verifyTonProof(
  {
    address: "0:…",
    network: "-239",
    public_key: "…",
    proof: { /* timestamp, domain, payload, signature, state_init */ },
  },
  { allowedDomains: ["example.com"] },
);

if (!result.ok) {
  console.warn("ton_proof rejected:", result.reason);
}
```

## Runtime requirements (Buffer and friends)

`ton-better-auth` depends on `@ton/core`, `@ton/crypto`, `@ton/ton`, and
`tweetnacl`. These libraries expect Node.js primitives — primarily the
global `Buffer` — to be available at runtime.

- **Node.js 18+** — no setup needed.
- **Bun** — `Buffer` is provided out of the box.
- **Cloudflare Workers** — enable the Node.js compatibility flag:
  ```toml
  # wrangler.toml
  compatibility_flags = ["nodejs_compat"]
  compatibility_date = "2024-09-23"
  ```
- **Vercel Edge Runtime** — the edge runtime does not polyfill `Buffer`.
  Run auth routes on the Node.js runtime (the default) by not setting
  `export const runtime = "edge"` on the handler file, or add a polyfill
  (see below).
- **Deno** — `Buffer` is exposed via `node:buffer`; most bundlers handle
  this automatically, but set `"nodeModulesDir": true` in `deno.json`
  or import it explicitly at entry:
  ```ts
  import { Buffer } from "node:buffer";
  globalThis.Buffer ??= Buffer;
  ```
- **Browser** — this plugin is designed for **server-side use**. If you
  are running parts of it in the browser (for example, pre-verifying a
  signature client-side before submitting it), you need to shim `Buffer`
  through your bundler:
  ```bash
  npm i -D buffer
  ```
  Vite:
  ```ts
  // vite.config.ts
  import { defineConfig } from "vite";
  import { nodePolyfills } from "vite-plugin-node-polyfills";
  export default defineConfig({
    plugins: [nodePolyfills({ globals: { Buffer: true } })],
  });
  ```
  Webpack 5:
  ```ts
  // webpack.config.js
  resolve: {
    fallback: { buffer: require.resolve("buffer/") },
  },
  plugins: [
    new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }),
  ],
  ```
  Next.js (edge-only routes): add a polyfill at the top of the handler:
  ```ts
  import { Buffer } from "buffer";
  globalThis.Buffer = globalThis.Buffer ?? Buffer;
  ```

If `Buffer` is missing, you will see errors like
`ReferenceError: Buffer is not defined` the first time the plugin
touches `ton_proof`. None of this applies to a normal Next.js / Express
/ SvelteKit server running on Node.js.

## License

MIT
