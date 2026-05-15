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

Peer dependencies: `better-auth` (>= 1.3) and its `@better-auth/core`.

## Server setup

```ts
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
      // Optional tweaks:
      validAuthTimeSec: 15 * 60,  // signature TTL, defaults to 15 min
      challengeTtlSec: 10 * 60,   // nonce TTL, defaults to 10 min
      emailDomain: "ton.local",   // used to synth an email for new users
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
| POST   | `/ton-connect/challenge`  | no   | Issue a one-shot `ton_proof` payload       |
| POST   | `/ton-connect/verify`     | no   | Verify a `ton_proof` and start a session   |
| POST   | `/ton-connect/link`       | yes  | Link an extra TON wallet to the user       |
| POST   | `/ton-connect/unlink`     | yes  | Remove a linked wallet                     |
| GET    | `/ton-connect/wallets`    | yes  | List the current user's linked wallets     |

### Wiring with `@tonconnect/ui-react`

The plugin works with any TON Connect client, but the official
`@tonconnect/ui-react` package is the smoothest fit. There are two
pieces: refresh the challenge the wallet will sign, and handle the
`ton_proof` reply when the wallet connects.

```tsx
import {
  useTonConnectUI,
  useTonWallet,
} from "@tonconnect/ui-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "./auth-client";

// Refresh the challenge roughly every 9 min — TON Connect signatures
// are valid for 15 min in this plugin, so we stay comfortably fresh.
const REFRESH_INTERVAL_MS = 9 * 60 * 1000;

export function SignInButton() {
  const [tonConnectUI] = useTonConnectUI();
  const wallet = useTonWallet();
  const [authed, setAuthed] = useState(false);
  const firstLoad = useRef(true);

  // (1) Keep the wallet supplied with a fresh challenge payload.
  const refreshChallenge = useCallback(async () => {
    if (firstLoad.current) {
      // Show the wallet a "loading" state while we hit our backend.
      tonConnectUI.setConnectRequestParameters({ state: "loading" });
      firstLoad.current = false;
    }

    const { data, error } = await authClient.tonConnect.challenge();

    if (error || !data?.payload) {
      tonConnectUI.setConnectRequestParameters(null);
      return;
    }

    tonConnectUI.setConnectRequestParameters({
      state: "ready",
      value: { tonProof: data.payload },
    });
  }, [tonConnectUI]);

  useEffect(() => {
    void refreshChallenge();
    const id = setInterval(() => {
      void refreshChallenge();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refreshChallenge]);

  // (2) Verify the ton_proof once the wallet sends it back.
  useEffect(() => {
    return tonConnectUI.onStatusChange(async (w) => {
      if (!w) {
        setAuthed(false);
        return;
      }
      const item = w.connectItems?.tonProof;
      if (!item || !("proof" in item)) return;

      const { error } = await authClient.tonConnect.verify({
        address: w.account.address,
        network: w.account.chain,
        public_key: w.account.publicKey!,
        proof: {
          timestamp: item.proof.timestamp,
          domain: item.proof.domain,
          payload: item.proof.payload,
          signature: item.proof.signature,
          state_init: w.account.walletStateInit,
        },
      });

      if (error) {
        await tonConnectUI.disconnect();
        setAuthed(false);
        return;
      }
      setAuthed(true);
    });
  }, [tonConnectUI]);

  if (authed) {
    return (
      <button onClick={() => tonConnectUI.disconnect()}>
        Disconnect {wallet?.account.address.slice(0, 6)}…
      </button>
    );
  }
  return <button onClick={() => tonConnectUI.openModal()}>Sign in</button>;
}
```

Two patterns worth noting here:

- `setConnectRequestParameters` is called from a `useEffect` (plus an
  interval). Calling it on every render would force React to re-register
  the request mid-flight and confuse the wallet UI.
- `onStatusChange` returns an **unsubscribe function**, and `useEffect`
  cleanups run that function when the component unmounts. Otherwise
  every remount stacks another listener and your `/verify` endpoint gets
  called multiple times per connect.

## What gets stored

- A new user row when a wallet first signs in (email is synthesised as
  `<raw-address>@<emailDomain>`, `emailVerified: false`).
- A row in `account` with `providerId: "ton-connect"` and the raw address
  as `accountId`.
- A row in the plugin's `tonWallet` table holding `address`, `publicKey`,
  `network`, `isPrimary`, `createdAt`, linked to the user via `userId`.

A user may link additional wallets through `/ton-connect/link`; the first
is flagged as primary, and the plugin refuses to unlink the last one so
the account can't be locked out.

## Security notes

- Challenges are stored in the Better Auth `verification` table and
  consumed atomically via `consumeVerificationValue`, so a valid
  `ton_proof` can only be used once.
- Signatures older than `validAuthTimeSec` are rejected.
- The signed app domain must match one of `allowedDomains` exactly
  (case-sensitive, include the port in dev).
- `challenge` and `verify` are rate-limited to 20 requests / 60s by
  default via the plugin's `rateLimit` rule.
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
