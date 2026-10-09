import { describe, expect, it } from "vitest";

import { verifyTonProof } from "../src/verify.js";
import { buildSignedProof, corruptSignature } from "./fixtures.js";

const DOMAIN = "localhost:3000";

describe("verifyTonProof", () => {
  it("accepts a valid ton_proof", async () => {
    const { request } = await buildSignedProof({
      domain: DOMAIN,
      payload: "challenge-value-1234",
    });

    const result = await verifyTonProof(request, {
      allowedDomains: [DOMAIN],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const { request } = await buildSignedProof({
      domain: DOMAIN,
      payload: "challenge-value-1234",
    });

    const bad = corruptSignature(request);
    const result = await verifyTonProof(bad, {
      allowedDomains: [DOMAIN],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("rejects an untrusted domain", async () => {
    const { request } = await buildSignedProof({
      domain: "evil.example",
      payload: "challenge-value-1234",
    });

    const result = await verifyTonProof(request, {
      allowedDomains: [DOMAIN],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("domain_not_allowed");
  });

  it("rejects an expired signature", async () => {
    const { request } = await buildSignedProof({
      domain: DOMAIN,
      payload: "challenge-value-1234",
      // Produced 24 hours ago.
      timestamp: Math.floor(Date.now() / 1000) - 24 * 60 * 60,
    });

    const result = await verifyTonProof(request, {
      allowedDomains: [DOMAIN],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_expired");
  });

  it("rejects a mismatched public key", async () => {
    const { request } = await buildSignedProof({
      domain: DOMAIN,
      payload: "challenge-value-1234",
    });

    const tampered = {
      ...request,
      public_key: "00".repeat(32),
    };
    const result = await verifyTonProof(tampered, {
      allowedDomains: [DOMAIN],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("public_key_mismatch");
  });

  it("rejects a signature from too far in the future", async () => {
    const { request } = await buildSignedProof({
      domain: DOMAIN,
      payload: "challenge-value-1234",
      timestamp: Math.floor(Date.now() / 1000) + 61,
    });
    const result = await verifyTonProof(request, { allowedDomains: [DOMAIN] });
    expect(result).toEqual({ ok: false, reason: "signature_from_future" });
  });

  it("rejects an incorrect domain byte length", async () => {
    const { request } = await buildSignedProof({
      domain: DOMAIN,
      payload: "challenge-value-1234",
    });
    const result = await verifyTonProof(
      {
        ...request,
        proof: {
          ...request.proof,
          domain: { ...request.proof.domain, lengthBytes: 1 },
        },
      },
      { allowedDomains: [DOMAIN] },
    );
    expect(result).toEqual({ ok: false, reason: "domain_length_mismatch" });
  });

  it("accepts wildcard domain policies", async () => {
    const { request } = await buildSignedProof({
      domain: "api.dev.example.com",
      payload: "challenge-value-1234",
    });

    const result = await verifyTonProof(request, {
      allowedDomains: ["*.example.com"],
    });

    expect(result.ok).toBe(true);
  });

  it("supports per-network domain policies", async () => {
    const { request } = await buildSignedProof({
      domain: "testnet.localhost:3000",
      payload: "challenge-value-1234",
      network: "-3",
    });

    const result = await verifyTonProof(request, {
      allowedDomains: {
        mainnet: ["mainnet.localhost:3000"],
        testnet: ["testnet.localhost:3000"],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects when no domain policy matches the request network", async () => {
    const { request } = await buildSignedProof({
      domain: "testnet.localhost:3000",
      payload: "challenge-value-1234",
      network: "-3",
    });

    const result = await verifyTonProof(request, {
      allowedDomains: {
        "-239": ["mainnet.localhost:3000"],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("domain_not_allowed");
  });
});
