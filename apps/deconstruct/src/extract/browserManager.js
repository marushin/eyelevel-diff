/** Chromium 프로세스 하나를 공유하고, 동시에 여는 페이지 수를 제한한다. */
import { chromium } from "playwright";
import { errors } from "../errors.js";

const LAUNCH_ARGS = [
  // WebRTC의 UDP는 프록시를 거치지 않으므로 끈다.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-dev-shm-usage",
];

export class BrowserManager {
  constructor({ maxConcurrent, maxQueued, sandbox }) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.sandbox = sandbox;
    this.running = 0;
    this.waiting = [];
    this.browserPromise = null;
  }

  async getBrowser() {
    if (!this.browserPromise) {
      this.browserPromise = chromium
        .launch({ headless: true, chromiumSandbox: this.sandbox, args: LAUNCH_ARGS })
        .then((browser) => {
          // 크래시가 나면 다음 요청에서 새로 띄운다.
          browser.on("disconnected", () => {
            this.browserPromise = null;
          });
          return browser;
        })
        .catch((error) => {
          this.browserPromise = null;
          throw error;
        });
    }
    return this.browserPromise;
  }

  async run(task) {
    if (this.running >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueued) throw errors.busy();
      await new Promise((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await task(await this.getBrowser());
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // 자리를 그대로 넘겨주므로 running은 유지된다.
      else this.running -= 1;
    }
  }

  async close() {
    const pending = this.browserPromise;
    this.browserPromise = null;
    if (pending) await (await pending).close();
  }
}
