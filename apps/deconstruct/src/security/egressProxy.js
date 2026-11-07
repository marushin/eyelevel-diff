/**
 * 요청 하나의 브라우저 트래픽 전체가 지나가는 로컬 포워드 프록시.
 *
 * page.route로 SSRF를 막지 않는 이유: route 핸들러는 리다이렉트 체인의 첫 요청에만 호출되고,
 * 서비스 워커나 WebSocket은 별도 경로로 빠진다. 여기서는 TCP 연결을 맺는 순간에 IP를 확인하고
 * 그 IP로 직접 연결하므로 리다이렉트, 서브리소스, iframe, WebSocket, DNS 리바인딩을 함께 막는다.
 *
 * 요청마다 프록시를 하나씩 띄우므로 바이트 예산을 페이지 단위로 적용할 수 있고,
 * close()가 남은 소켓을 모두 끊어 자원이 새지 않는다.
 */
import http from "node:http";
import net from "node:net";
import { BlockedTargetError } from "./urlPolicy.js";

export const BLOCKED_HEADER = "x-egress-blocked";
const HOP_BY_HOP = ["proxy-connection", "proxy-authorization", "connection", "keep-alive"];
const CONNECT_TIMEOUT_MS = 10_000;

export async function createEgressProxy({ policy, maxBytes = Infinity }) {
  const sockets = new Set();
  const stats = { requests: 0, bytes: 0, blocked: [], overBudget: false };
  const { promise: whenOverBudget, resolve: signalOverBudget } = Promise.withResolvers();

  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    return socket;
  };

  const countBytes = (size) => {
    stats.bytes += size;
    if (stats.bytes > maxBytes && !stats.overBudget) {
      stats.overBudget = true;
      for (const socket of sockets) socket.destroy();
      signalOverBudget();
    }
  };

  /** 허용되면 연결할 IP, 아니면 null. */
  const authorize = async (hostname, port) => {
    stats.requests += 1;
    if (stats.overBudget) return null;
    try {
      return await policy.resolve(hostname, port);
    } catch (error) {
      if (error instanceof BlockedTargetError) stats.blocked.push(`${hostname}:${port}`);
      return null;
    }
  };

  const server = http.createServer(async (req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    const address = target.protocol === "http:" ? await authorize(target.hostname, port) : null;
    if (!address) {
      res.writeHead(403, { [BLOCKED_HEADER]: "1" }).end();
      return;
    }
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    const upstream = http.request(
      { host: address, port, method: req.method, path: target.pathname + target.search, headers, agent: false },
      (response) => {
        res.writeHead(response.statusCode, response.rawHeaders);
        response.on("data", (chunk) => countBytes(chunk.length));
        response.pipe(res);
      },
    );
    upstream.setTimeout(CONNECT_TIMEOUT_MS * 3, () => upstream.destroy());
    upstream.on("socket", track);
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });

  // HTTPS와 WebSocket은 CONNECT 터널로 들어온다. 터널 안은 암호화되어 있으므로 IP만 확인하면 된다.
  server.on("connect", async (req, client, head) => {
    track(client);
    const { hostname, port: rawPort } = new URL(`http://${req.url}`);
    const port = Number(rawPort) || 443;
    const address = await authorize(hostname, port);
    if (!address) {
      client.end(`HTTP/1.1 403 Forbidden\r\n${BLOCKED_HEADER}: 1\r\n\r\n`);
      return;
    }
    const upstream = track(net.connect({ host: address, port, timeout: CONNECT_TIMEOUT_MS }));
    upstream.once("timeout", () => upstream.destroy());
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.on("data", (chunk) => countBytes(chunk.length));
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });

  server.on("connection", track);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    whenOverBudget,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
