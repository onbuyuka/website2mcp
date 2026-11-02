import { describe, expect, it } from "vitest";
import { assertPublicHost, isPublicIp, normalizeUrl } from "../src/url.js";

describe("URL safety", () => {
  it("accepts only credential-free HTTP URLs and strips fragments", () => {
    expect(normalizeUrl("https://example.test/path#section")?.href).toBe(
      "https://example.test/path",
    );
    expect(normalizeUrl("file:///C:/secret.txt")).toBeUndefined();
    expect(normalizeUrl("https://user:pass@example.test")).toBeUndefined();
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:0a00:1",
    "192.0.0.8",
    "192.0.2.10",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
  ])("rejects non-public IP %s", (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each(["192.0.78.182", "198.51.0.1", "203.0.1.1", "104.20.23.154"])(
    "accepts public IP %s outside the reserved ranges",
    (address) => {
      expect(isPublicIp(address)).toBe(true);
    },
  );

  it("accepts public IPs and rejects a hostname resolving to a private address", async () => {
    expect(isPublicIp("93.184.216.34")).toBe(true);
    await expect(
      assertPublicHost("rebound.example.test", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("non-public host");
  });
});
