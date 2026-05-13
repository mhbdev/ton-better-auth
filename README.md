# ton-better-auth

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

```tsx
import { TonConnectUIProvider, useTonConnectUI } from "@tonconnect/ui-react";
import { authClient } from "./auth-client";

function SignInButton() {
  const [tonConnectUI] = useTonConnectUI();

  // Point TON Connect at your backend challenge endpoint.
  // The wallet will sign whatever the server returns.
  tonConnectUI.setConnectRequestParametersCallback(async () => {
    const { data } = await authClient.tonConnect.challenge();
    return data?.payload
      ? { state: "ready", value: { tonProof: data.payload } }
      : { state: "loading" };
  });

  // Subscribe to wallet connection events.
  tonConnectUI.onStatusChange(async (wallet) => {
    const proof = wallet?.connectItems?.tonProof;
    if (!wallet || !proof || !("proof" in proof)) return;

    const res = await authClient.tonConnect.verify({
      address: wallet.account.address,
      network: wallet.account.chain,
      public_key: wallet.account.publicKey!,
      proof: {
        timestamp: proof.proof.timestamp,
        domain: proof.proof.domain,
        payload: proof.proof.payload,
        signature: proof.proof.signature,
        state_init: wallet.account.walletStateInit,
      },
    });

    if (res.error) {
      await tonConnectUI.disconnect();
    }
  });

  return <button onClick={() => tonConnectUI.openModal()}>Sign in</button>;
}
```

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

## License

MIT
