/**
 * Integration tests — spin up a real Better Auth instance with the TON
 * plugin attached against an in-memory SQLite database and exercise the
 * full sign-in flow end-to-end through `auth.api.*`.
 */
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { beforeEach, describe, expect, it } from "vitest";

import { tonConnect, type TonConnectPluginOptions } from "../src/index.js";
import {
  buildSignedProof,
  buildSignedProofWithExistingKeyPair,
  corruptSignature,
} from "./fixtures.js";

const DOMAIN = "localhost:3000";

type TestKeyPair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

function buildOptions(
  pluginOverrides: Partial<TonConnectPluginOptions> = {},
) {
  return {
    database: new Database(":memory:"),
    secret: "0123456789abcdef0123456789abcdef0123456789abcdef",
    baseURL: `http://${DOMAIN}`,
    plugins: [
      tonConnect({
        allowedDomains: [DOMAIN],
        ...pluginOverrides,
      }),
    ],
  };
}

async function makeAuth(pluginOverrides: Partial<TonConnectPluginOptions> = {}) {
  const options = buildOptions(pluginOverrides);
  const migration = await getMigrations(options);
  await migration.runMigrations();
  return betterAuth(options);
}

type Auth = Awaited<ReturnType<typeof makeAuth>>;

async function verifyFresh(
  auth: Auth,
  options?: {
    domain?: string;
    network?: "-239" | "-3";
    keyPair?: TestKeyPair;
    headers?: Headers;
  },
) {
  const challenge = await auth.api.getTonConnectChallenge({
    headers: options?.headers,
  });

  const signed = options?.keyPair
    ? await buildSignedProofWithExistingKeyPair({
        keyPair: options.keyPair,
        domain: options.domain ?? DOMAIN,
        payload: challenge.payload,
        network: options.network,
      })
    : await buildSignedProof({
        domain: options?.domain ?? DOMAIN,
        payload: challenge.payload,
        network: options?.network,
      });

  const response = await auth.api.verifyTonConnect({
    body: signed.request,
    headers: options?.headers,
    returnHeaders: true,
  });
  return { request: signed.request, keyPair: signed.keyPair, response };
}

async function signInFresh(
  auth: Auth,
  options?: {
    domain?: string;
    network?: "-239" | "-3";
    keyPair?: TestKeyPair;
    headers?: Headers;
  },
) {
  const verified = await verifyFresh(auth, options);
  const setCookie = verified.response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Missing set-cookie header on sign-in");
  const headers = new Headers({ cookie: setCookie });
  return {
    request: verified.request,
    keyPair: verified.keyPair,
    response: verified.response.response,
    headers,
  };
}

async function linkFresh(
  auth: Auth,
  headers: Headers,
  options?: {
    domain?: string;
    network?: "-239" | "-3";
    keyPair?: TestKeyPair;
  },
) {
  const challenge = await auth.api.getTonConnectChallenge({ headers });
  const signed = options?.keyPair
    ? await buildSignedProofWithExistingKeyPair({
        keyPair: options.keyPair,
        domain: options.domain ?? DOMAIN,
        payload: challenge.payload,
        network: options.network,
      })
    : await buildSignedProof({
        domain: options?.domain ?? DOMAIN,
        payload: challenge.payload,
        network: options?.network,
      });

  const response = await auth.api.linkTonConnect({
    body: signed.request,
    headers,
  });
  return { request: signed.request, keyPair: signed.keyPair, response };
}

async function countPrimaryWallets(auth: Auth, headers: Headers) {
  const wallets = await auth.api.listTonWallets({ headers });
  return wallets.wallets.filter((w) => w.isPrimary).length;
}

describe("ton-better-auth integration", () => {
  let auth: Auth;

  beforeEach(async () => {
    auth = await makeAuth();
  });

  it("issues a challenge, verifies a ton_proof, and creates a user", async () => {
    const challenge = await auth.api.getTonConnectChallenge({});
    expect(challenge.payload).toMatch(/^[0-9a-f]{64}$/);

    const { request } = await buildSignedProof({
      domain: DOMAIN,
      payload: challenge.payload,
    });

    const result = await auth.api.verifyTonConnect({ body: request });
    expect(result.success).toBe(true);
    expect(result.token).toBeTypeOf("string");
    expect(result.user.address).toBe(request.address);
    expect(result.user.network).toBe("-239");
    expect(result.user.activeWalletAddress).toBe(request.address);
    expect(result.user.activeWalletNetwork).toBe("-239");
  });

  it("rejects replay of a consumed challenge", async () => {
    const challenge = await auth.api.getTonConnectChallenge({});

    const { request } = await buildSignedProof({
      domain: DOMAIN,
      payload: challenge.payload,
    });

    await auth.api.verifyTonConnect({ body: request });

    const { request: replay } = await buildSignedProof({
      domain: DOMAIN,
      payload: challenge.payload,
    });
    await expect(auth.api.verifyTonConnect({ body: replay })).rejects.toThrow(
      APIError,
    );
  });

  it("rejects a tampered signature", async () => {
    const challenge = await auth.api.getTonConnectChallenge({});
    const { request } = await buildSignedProof({
      domain: DOMAIN,
      payload: challenge.payload,
    });
    const bad = corruptSignature(request);
    await expect(auth.api.verifyTonConnect({ body: bad })).rejects.toThrow(
      APIError,
    );
  });
});

describe("ton-better-auth wallet management", () => {
  let auth: Auth;

  beforeEach(async () => {
    auth = await makeAuth();
  });

  it("lists linked wallets after sign-in", async () => {
    const { request, headers } = await signInFresh(auth);

    const wallets = await auth.api.listTonWallets({ headers });
    expect(wallets.wallets).toHaveLength(1);
    expect(wallets.activeWalletAddress).toBe(request.address);
    const first = wallets.wallets[0];
    expect(first).toBeDefined();
    expect(first!.address).toBe(request.address);
    expect(first!.isPrimary).toBe(true);
    expect(first!.isActive).toBe(true);
  });

  it("refuses to unlink the last remaining wallet", async () => {
    const { request, headers } = await signInFresh(auth);

    await expect(
      auth.api.unlinkTonConnect({
        body: { address: request.address },
        headers,
      }),
    ).rejects.toThrow(APIError);
  });

  it("marks the first linked wallet as primary when wallet rows were missing", async () => {
    const { response, headers } = await signInFresh(auth);

    const db = auth.options.database;
    db.prepare("DELETE FROM tonWallet WHERE userId = ?").run(response.user.id);

    const linked = await linkFresh(auth, headers);
    const wallets = await auth.api.listTonWallets({ headers });

    expect(wallets.wallets).toHaveLength(1);
    expect(wallets.wallets[0]?.address).toBe(linked.request.address);
    expect(wallets.wallets[0]?.isPrimary).toBe(true);
  });

  it("heals duplicate primary wallets while unlinking", async () => {
    const { request: first, headers } = await signInFresh(auth);

    const third = await linkFresh(auth, headers);
    const second = await linkFresh(auth, headers);

    const db = auth.options.database;
    db.prepare("UPDATE tonWallet SET isPrimary = 1 WHERE address = ?").run(
      second.request.address,
    );

    expect(await countPrimaryWallets(auth, headers)).toBe(2);

    await auth.api.unlinkTonConnect({
      body: { address: first.address },
      headers,
    });

    const wallets = await auth.api.listTonWallets({ headers });
    const primaryWallets = wallets.wallets.filter((w) => w.isPrimary);

    expect(third.response.success).toBe(true);
    expect(primaryWallets).toHaveLength(1);
  });

  it("sets a linked wallet as primary explicitly", async () => {
    const { headers } = await signInFresh(auth);
    const linked = await linkFresh(auth, headers);

    const result = await auth.api.setPrimaryTonConnectWallet({
      body: { address: linked.request.address },
      headers,
    });

    expect(result.success).toBe(true);
    expect(result.address).toBe(linked.request.address);

    const wallets = await auth.api.listTonWallets({ headers });
    const primary = wallets.wallets.find((w) => w.isPrimary);
    expect(primary?.address).toBe(linked.request.address);
  });

  it("switches active wallet context in the current session", async () => {
    const { headers } = await signInFresh(auth);
    const linked = await linkFresh(auth, headers);

    const switched = await auth.api.switchTonConnectSessionWallet({
      body: { address: linked.request.address },
      headers,
    });
    expect(switched.success).toBe(true);
    expect(switched.activeWalletAddress).toBe(linked.request.address);

    const wallets = await auth.api.listTonWallets({ headers });
    const active = wallets.wallets.find((w) => w.isActive);
    expect(active?.address).toBe(linked.request.address);
  });
});

describe("ton-better-auth domain policies", () => {
  it("accepts per-network domain policy for testnet", async () => {
    const auth = await makeAuth({
      allowedDomains: {
        mainnet: ["mainnet.localhost:3000"],
        testnet: ["testnet.localhost:3000"],
      },
    });

    const signed = await verifyFresh(auth, {
      domain: "testnet.localhost:3000",
      network: "-3",
    });

    expect(signed.response.response.success).toBe(true);
    expect(signed.response.response.user.network).toBe("-3");
  });

  it("accepts wildcard domains", async () => {
    const auth = await makeAuth({
      allowedDomains: ["*.example.com"],
    });

    const signed = await verifyFresh(auth, {
      domain: "wallet.dev.example.com",
    });

    expect(signed.response.response.success).toBe(true);
  });
});

describe("ton-better-auth anti-abuse", () => {
  it("applies per-address verify rate limits", async () => {
    const auth = await makeAuth({
      antiAbuse: {
        verify: {
          windowSec: 60,
          maxPerIp: 100,
          maxPerAddress: 1,
        },
      },
    });

    const first = await verifyFresh(auth);
    expect(first.response.response.success).toBe(true);

    await expect(
      verifyFresh(auth, {
        keyPair: first.keyPair,
      }),
    ).rejects.toThrow(APIError);
  });

  it("enforces failed verification cooldown", async () => {
    const auth = await makeAuth({
      antiAbuse: {
        verify: {
          windowSec: 60,
          maxPerIp: 100,
          maxPerAddress: 100,
        },
        failedVerifyCooldown: {
          enabled: true,
          threshold: 1,
          windowSec: 60,
          cooldownSec: 60,
          keying: "ip+address",
        },
      },
    });

    const challenge = await auth.api.getTonConnectChallenge({});
    const signed = await buildSignedProof({
      domain: DOMAIN,
      payload: challenge.payload,
    });
    const bad = corruptSignature(signed.request);

    await expect(auth.api.verifyTonConnect({ body: bad })).rejects.toThrow(APIError);

    await expect(
      verifyFresh(auth, {
        keyPair: signed.keyPair,
      }),
    ).rejects.toThrow(APIError);
  });

  it("supports captcha checks on challenge", async () => {
    const auth = await makeAuth({
      antiAbuse: {
        captcha: {
          enabled: true,
          shouldRequire: () => true,
          verify: ({ token }) => token === "captcha-ok",
        },
      },
    });

    await expect(auth.api.getTonConnectChallenge({})).rejects.toThrow(APIError);

    const challenge = await auth.api.getTonConnectChallenge({
      headers: new Headers({ "x-captcha-token": "captcha-ok" }),
    });
    expect(challenge.payload).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies per-address challenge rate limits when address is provided", async () => {
    const auth = await makeAuth({
      antiAbuse: {
        challenge: {
          windowSec: 60,
          maxPerIp: 100,
          maxPerAddress: 1,
        },
      },
    });

    const wallet = await buildSignedProof({
      domain: DOMAIN,
      payload: "warmup",
    });

    await auth.api.getTonConnectChallenge({
      body: { address: wallet.request.address },
    });

    await expect(
      auth.api.getTonConnectChallenge({
        body: { address: wallet.request.address },
      }),
    ).rejects.toThrow(APIError);
  });
});

describe("ton-better-auth auth rules", () => {
  it("blocks non-primary wallet sign-in when onlyPrimaryCanSignIn is enabled", async () => {
    const auth = await makeAuth({
      authRules: {
        onlyPrimaryCanSignIn: true,
      },
    });

    const first = await signInFresh(auth);
    const linked = await linkFresh(auth, first.headers);

    await expect(
      verifyFresh(auth, {
        keyPair: linked.keyPair,
      }),
    ).rejects.toThrow(APIError);
  });

  it("blocks unknown wallets when allowOnlyLinkedWallets is enabled", async () => {
    const auth = await makeAuth({
      authRules: {
        allowOnlyLinkedWallets: true,
      },
    });

    await expect(verifyFresh(auth)).rejects.toThrow(APIError);
  });

  it("auto-links on verify for authenticated sessions", async () => {
    const auth = await makeAuth({
      authRules: {
        autoLinkOnVerify: true,
      },
    });

    const signedIn = await signInFresh(auth);
    const autoLinked = await verifyFresh(auth, {
      headers: signedIn.headers,
    });

    expect(autoLinked.response.response.success).toBe(true);

    const wallets = await auth.api.listTonWallets({ headers: signedIn.headers });
    expect(wallets.wallets.length).toBeGreaterThan(1);
  });
});

describe("ton-better-auth event hooks", () => {
  it("emits lifecycle hooks", async () => {
    const events: {
      challenge: number;
      verifySuccess: number;
      verifyFail: number;
      linked: number;
    } = {
      challenge: 0,
      verifySuccess: 0,
      verifyFail: 0,
      linked: 0,
    };

    const auth = await makeAuth({
      events: {
        onChallengeIssued: () => {
          events.challenge += 1;
        },
        onVerifySuccess: () => {
          events.verifySuccess += 1;
        },
        onVerifyFail: () => {
          events.verifyFail += 1;
        },
        onWalletLinked: () => {
          events.linked += 1;
        },
      },
    });

    await signInFresh(auth);
    const challenge = await auth.api.getTonConnectChallenge({});
    const signed = await buildSignedProof({
      domain: DOMAIN,
      payload: challenge.payload,
    });
    await expect(
      auth.api.verifyTonConnect({ body: corruptSignature(signed.request) }),
    ).rejects.toThrow(APIError);

    expect(events.challenge).toBeGreaterThanOrEqual(2);
    expect(events.verifySuccess).toBeGreaterThanOrEqual(1);
    expect(events.verifyFail).toBeGreaterThanOrEqual(1);
    expect(events.linked).toBeGreaterThanOrEqual(1);
  });
});
