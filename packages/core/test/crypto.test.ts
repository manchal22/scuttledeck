import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex, verifyGithubSignature } from "../src/crypto.js";

describe("verifyGithubSignature", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ hello: "world" });
  const goodSig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a valid signature", () => {
    expect(verifyGithubSignature(secret, body, goodSig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyGithubSignature(secret, body + " ", goodSig)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const sig = "sha256=" + createHmac("sha256", "other").update(body).digest("hex");
    expect(verifyGithubSignature(secret, body, sig)).toBe(false);
  });

  it("rejects missing/malformed headers", () => {
    expect(verifyGithubSignature(secret, body, undefined)).toBe(false);
    expect(verifyGithubSignature(secret, body, "sha1=abc")).toBe(false);
    expect(verifyGithubSignature(secret, body, "sha256=zz")).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("hashes deterministically", () => {
    expect(sha256Hex("token")).toBe(sha256Hex("token"));
    expect(sha256Hex("token")).toHaveLength(64);
  });
});
