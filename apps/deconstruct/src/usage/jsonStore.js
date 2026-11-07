/** 서버를 재시작해도 남아야 하는 작은 데이터(누적 비용, 이미지 설명)를 JSON 파일에 저장한다. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore {
  constructor(path, initial = {}) {
    this.path = path;
    this.data = initial;
    this.reload();
  }

  /** 서버와 터미널 도구가 같은 파일을 쓰므로, 갱신하기 전에 다시 읽어야 서로의 기록을 덮어쓰지 않는다. */
  reload() {
    try {
      this.data = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  /** 임시 파일에 쓴 뒤 교체하므로 도중에 꺼져도 파일이 깨지지 않는다. */
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data));
    renameSync(temporary, this.path);
  }
}
