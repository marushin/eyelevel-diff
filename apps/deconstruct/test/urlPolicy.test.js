import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicIp, parseInputUrl, publicInternetPolicy, BlockedTargetError } from "../src/security/urlPolicy.js";

test("내부 대역 IP를 거부한다", () => {
  const internal = [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
  ];
  for (const address of internal) assert.equal(isPublicIp(address), false, address);
});

test("공인 IP를 허용한다", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicIp(address), true, address);
});

test("URL 표기를 바꿔도 내부 주소로 정규화되어 거부된다", async () => {
  const disguised = ["http://2130706433/", "http://0x7f.0.0.1/", "http://017700000001/", "http://[::ffff:7f00:1]/", "http://localhost/"];
  for (const raw of disguised) {
    const url = parseInputUrl(raw);
    await assert.rejects(publicInternetPolicy.resolve(url.hostname, 80), BlockedTargetError, raw);
  }
});

test("허용되지 않은 포트를 거부한다", async () => {
  await assert.rejects(publicInternetPolicy.resolve("8.8.8.8", 22), BlockedTargetError);
});

test("http, https 외의 스킴과 계정 정보를 거부한다", () => {
  for (const raw of ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "http://user:pw@example.com", "nonsense"]) {
    assert.throws(() => parseInputUrl(raw), { code: "INVALID_URL" }, raw);
  }
});
