/**
 * Vision에 넣을 이미지를 서버가 직접 내려받아 줄인다. Vision 비용이 이미지 크기에 비례하고,
 * 핫링크를 막는 사이트에서도 페이지를 주소로 밝혀 받을 수 있기 때문이다.
 * 이미지 URL도 페이지가 정한 값이므로 브라우저와 같은 정책으로 매 리다이렉트마다 검사한다.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import sharp from "sharp";

const MAX_REDIRECTS = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; DeconstructAPI/0.1)";
// 채널 표준편차가 이보다 작으면 사실상 한 가지 색이다. 투명 마스크나 자리표시 이미지가 여기에 해당한다.
const BLANK_STDEV = 3;

/** toVisionImage의 결과. 내용 없는 이미지를 Vision 전에 걸러 비용과 빈 노드를 줄인다. */
export const BLANK_IMAGE = Symbol("blank image");

function requestOnce(url, { policy, referer, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    policy.resolve(url.hostname, port).then((address) => {
      const family = net.isIPv6(address) ? 6 : 4;
      const client = url.protocol === "https:" ? https : http;
      const request = client.get(
        url,
        {
          agent: false,
          timeout: timeoutMs,
          // 위키미디어처럼 User-Agent가 없으면 거부하는 서버가 있다.
          headers: { accept: "image/*", "user-agent": USER_AGENT, ...(referer ? { referer } : {}) },
          // 검사한 IP로만 연결해 검사와 연결 사이에 DNS 응답이 바뀌는 공격을 막는다.
          lookup: (_host, options, callback) =>
            options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
        },
        (response) => {
          const { statusCode, headers } = response;
          if (statusCode >= 300 && statusCode < 400 && headers.location) {
            response.destroy();
            resolve({ redirect: new URL(headers.location, url) });
            return;
          }
          if (statusCode !== 200 || !(headers["content-type"] ?? "").startsWith("image/")) {
            response.destroy();
            reject(new Error(`unusable response ${statusCode}`));
            return;
          }
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy(new Error("image too large"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => resolve({ buffer: Buffer.concat(chunks) }));
          response.on("error", reject);
        },
      );
      request.on("timeout", () => request.destroy(new Error("timeout")));
      request.on("error", reject);
    }, reject);
  });
}

export async function fetchImage(rawUrl, options) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported scheme");
    const result = await requestOnce(url, options);
    if (result.buffer) return result.buffer;
    url = result.redirect;
  }
  throw new Error("too many redirects");
}

/** 긴 변을 줄인 JPEG의 base64. 아이콘처럼 작으면 설명할 가치가 없어 null을 돌려준다. */
export async function toVisionImage(buffer, { maxEdge, minEdge }) {
  const image = sharp(buffer, { limitInputPixels: 50_000_000 });
  const { width, height, format } = await image.metadata();
  if (format === "svg" || Math.max(width, height) < minEdge) return null;
  const output = await image
    .flatten({ background: "#ffffff" })
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  const { channels } = await sharp(output).stats();
  if (channels.every((channel) => channel.stdev < BLANK_STDEV)) return BLANK_IMAGE;
  return output.toString("base64");
}
