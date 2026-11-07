/**
 * 어떤 주소로 나가도 되는지 결정하는 정책. 입력 URL 검사와 이그레스 프록시가 같은 정책을 쓴다.
 * 정책 객체: { resolve(hostname, port) => Promise<string> }. 허용되면 연결할 IP를 돌려주고, 아니면 던진다.
 */
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { errors } from "../errors.js";

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const MAX_URL_LENGTH = 2048;

export class BlockedTargetError extends Error {}
export class DnsLookupError extends Error {}

/** ipaddr.js는 "unicast"를 공인 대역의 나머지로 정의한다. 사설, 루프백, 링크로컬, CGNAT 등은 모두 다른 값이다. */
export function isPublicIp(address) {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address); // IPv4-mapped IPv6를 IPv4로 풀어 준다.
  return parsed.range() === "unicast";
}

export const publicInternetPolicy = {
  async resolve(hostname, port) {
    if (!ALLOWED_PORTS.has(port)) throw new BlockedTargetError(`port ${port}`);
    const host = hostname.replace(/^\[|\]$/g, "");
    if (ipaddr.isValid(host)) {
      if (!isPublicIp(host)) throw new BlockedTargetError(host);
      return host;
    }
    let records;
    try {
      records = await lookup(host, { all: true, order: "ipv4first" });
    } catch {
      throw new DnsLookupError(host);
    }
    // 하나라도 내부 주소면 거부한다. 공인 IP와 내부 IP를 섞어 답하는 DNS를 막기 위해서다.
    if (records.length === 0 || !records.every((record) => isPublicIp(record.address))) {
      throw new BlockedTargetError(host);
    }
    return records[0].address;
  },
};

export function parseInputUrl(raw) {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) throw errors.invalidUrl("길이 제한 초과");
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw errors.invalidUrl("형식 오류");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw errors.invalidUrl("http, https만 지원합니다");
  if (url.username || url.password) throw errors.invalidUrl("계정 정보가 포함된 URL은 지원하지 않습니다");
  return url;
}

export function urlPort(url) {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/** 브라우저를 띄우기 전에 빠르게 거른다. 실제 방어는 이그레스 프록시가 연결마다 수행한다. */
export async function assertAllowedUrl(url, policy = publicInternetPolicy) {
  try {
    await policy.resolve(url.hostname, urlPort(url));
  } catch (error) {
    if (error instanceof BlockedTargetError) throw errors.blockedUrl();
    if (error instanceof DnsLookupError) throw errors.dnsFailed();
    throw error;
  }
}
