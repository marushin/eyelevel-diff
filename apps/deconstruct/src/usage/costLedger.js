/**
 * 유료 API 비용을 누적하고 한도에 닿으면 호출을 막는다. 막힌 호출은 예외가 되고,
 * 호출하는 쪽의 기존 폴백(규칙 분할, 주변 글자)으로 이어진다.
 *
 * 응답의 토큰 수에 문서상 가격을 곱한 추정값이다. 실제 청구액은 Console에서 확인해야 한다.
 * 이미 진행 중인 호출은 막지 못하므로 동시 호출 수만큼 한도를 조금 넘을 수 있다.
 */
// 100만 토큰당 [입력, 출력] 달러. Claude API 문서 기준(2026-10-06).
const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
const MOST_EXPENSIVE = [10, 50];

export class BudgetExhaustedError extends Error {}

export class CostLedger {
  constructor({ store, limitUsd }) {
    this.store = store;
    this.limitUsd = limitUsd;
    store.data.spentUsd ??= 0;
    store.data.byModel ??= {};
  }

  get spentUsd() {
    return this.store.data.spentUsd;
  }

  get exhausted() {
    return this.spentUsd >= this.limitUsd;
  }

  record(model, { inputTokens, outputTokens }) {
    // 가격을 모르는 모델은 가장 비싼 값으로 계산해 한도를 넘기지 않게 한다.
    const [input, output] = PRICES[model] ?? MOST_EXPENSIVE;
    const cost = (inputTokens * input + outputTokens * output) / 1e6;
    this.store.reload();
    this.store.data.spentUsd += cost;
    const entry = (this.store.data.byModel[model] ??= { inputTokens: 0, outputTokens: 0, usd: 0 });
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    entry.usd += cost;
    this.store.save();
    return cost;
  }

  /** find(items)가 { usage }를 돌려주는 모든 LLM 호출에 한도를 씌운다. */
  guard(caller, model) {
    return {
      ...caller,
      find: async (items) => {
        this.store.reload();
        if (this.exhausted) throw new BudgetExhaustedError(`spent ${this.spentUsd}`);
        const result = await caller.find(items);
        this.record(model, result.usage);
        return result;
      },
    };
  }

  summary() {
    return { spentUsd: Number(this.spentUsd.toFixed(4)), limitUsd: this.limitUsd, exhausted: this.exhausted };
  }
}
