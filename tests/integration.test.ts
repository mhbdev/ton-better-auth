/**
 * Integration tests — spin up a real Better Auth instance with the TON
 * plugin attached against an in-memory SQLite database and exercise the
 * full sign-in flow end-to-end through `auth.api.*`.
 *
 * NOTE: we construct the auth instance with a literal options object
 * rather than a widened `BetterAuthOptions` so TypeScript can infer the
 * plugin's endpoint types on `auth.api.*`.
 */
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { beforeEach, describe, expect, it } from "vitest";

import { tonConnect } from "../src/index.js";
import { buildSignedProof, corruptSignature } from "./fixtures.js";

const DOMAIN = "localhost:3000";

function buildOptions() {
  return {
    database: new Database(":memory:"),
    secret: "0123456789abcdef0123456789abcdef0123456789abcdef",
    baseURL: `http://${DOMAIN}`,
    plugins: [tonConnect({ allowedDomains: [DOMAIN] })],
  };
}

async function makeAuth() {
  const options = buildOptions();
  const migration = await getMigrations(options);
  await migration.runMigrations();
  return betterAuth(options);
}

type Auth = Awaited<ReturnType<typeof makeAuth>>;

async function signInFresh(auth: Auth) {
  const challenge = await auth.api.getTonConnectChallenge({});
  const { request } = await buildSignedProof({
    domain: DOMAIN,
    payload: challenge.payload,
  });
  const response = await auth.api.verifyTonConnect({
    body: request,
    returnHeaders: true,
  });
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Missing set-cookie header on sign-in");
  const headers = new Headers({ cookie: setCookie });
  return { request, response: response.response, headers };
}

async function linkFresh(auth: Auth, headers: Headers) {
  const challenge = await auth.api.getTonConnectChallenge({});
  const { request } = await buildSignedProof({
    domain: DOMAIN,
    payload: challenge.payload,
  });
  const response = await auth.api.linkTonConnect({
    body: request,
    headers,
  });
  return { request, response };
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
  });

  it("rejects replay of a consumed challenge", async () => {
    const challenge = await auth.api.getTonConnectChallenge({});

    const { request } = await buildSignedProof({
      domain: DOMAIN,
      payload: challenge.payload,
    });

    await auth.api.verifyTonConnect({ body: request });

    // Second call re-using the same challenge payload should fail —
    // the challenge row has already been consumed.
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
    const first = wallets.wallets[0];
    expect(first).toBeDefined();
    expect(first!.address).toBe(request.address);
    expect(first!.isPrimary).toBe(true);
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
});
