/**
 * 로컬 엔진 패널 안의 'LLM 연결' 구역. Gemini Nano(기본)·Claude·OpenAI·로컬 LLM 중 하나를 고르고,
 * 모델·키·주소를 넣고 연결을 시험한다. 바뀐 값은 바로 llm.ts에 반영된다.
 */
import { CLAUDE_MODELS, DEFAULT_LOCAL_URL, DEFAULT_OPENAI_URL, llm, PROVIDER_LABEL, type LlmEngine, type ProviderId } from './llm.ts';

const OPTIONS: [ProviderId, string][] = [
  ['nano', 'Gemini Nano · Chrome 내장, 무료'],
  ['claude', 'Claude API · 유료'],
  ['openai', 'OpenAI API · 유료'],
  ['local', '로컬 LLM · Ollama, LM Studio 등'],
];

const PLACEHOLDER: Record<Exclude<ProviderId, 'nano'>, { model: string; url: string }> = {
  claude: { model: CLAUDE_MODELS[0]!, url: '' },
  openai: { model: '모델 이름 (목록 버튼으로 불러오기)', url: DEFAULT_OPENAI_URL },
  local: { model: '예: gemma3, qwen3 (목록 버튼)', url: DEFAULT_LOCAL_URL },
};

let uid = 0;

function field(label: string, input: HTMLElement): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.className = 'local-llm-field';
  const name = document.createElement('span');
  name.className = 'local-status-name';
  name.textContent = label;
  wrap.append(name, input);
  return wrap;
}

function checkbox(text: string): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = document.createElement('label');
  root.className = 'local-llm-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  root.append(input, document.createTextNode(` ${text}`));
  return { root, input };
}

/** onChange는 연결이나 상태가 바뀔 때마다 불린다(패널이 Nano 줄을 숨기고 요약 색을 다시 칠한다). */
export function mountLlmSettings(host: HTMLElement, onChange: () => void, engine: LlmEngine = llm): () => void {
  const id = `local-llm-${uid += 1}`;
  const root = document.createElement('div');
  root.className = 'local-llm';

  const select = document.createElement('select');
  for (const [value, text] of OPTIONS) select.append(new Option(text, value));
  const head = field('LLM 연결', select);
  head.classList.add('local-llm-head');

  const form = document.createElement('div');
  form.className = 'local-llm-form';

  const model = document.createElement('input');
  model.type = 'text';
  model.spellcheck = false;
  model.setAttribute('list', `${id}-models`);
  const models = document.createElement('datalist');
  models.id = `${id}-models`;
  const listButton = document.createElement('button');
  listButton.type = 'button';
  listButton.textContent = '목록';
  listButton.title = '서버에서 쓸 수 있는 모델 목록을 불러옵니다';
  const modelRow = document.createElement('div');
  modelRow.className = 'local-llm-inline';
  modelRow.append(model, listButton, models);

  const key = document.createElement('input');
  key.type = 'password';
  key.autocomplete = 'off';
  key.spellcheck = false;
  const url = document.createElement('input');
  url.type = 'url';
  url.spellcheck = false;

  const vision = checkbox('이미지 설명도 맡기기 (이미지를 읽는 모델일 때)');
  const remember = checkbox('이 기기에 API 키 기억');
  remember.root.title = '분해할 때 대상 웹페이지의 스크립트가 이 앱과 같은 출처에서 돌기 때문에, 저장한 키를 그 스크립트가 읽을 수 있습니다. 끄면 키는 이 탭에만 있다가 닫으면 사라집니다.';

  const note = document.createElement('p');
  note.className = 'local-llm-note';

  const testButton = document.createElement('button');
  testButton.type = 'button';
  testButton.textContent = '연결 테스트';
  const result = document.createElement('span');
  result.className = 'local-status-value';
  const testRow = document.createElement('div');
  testRow.className = 'local-llm-inline';
  testRow.append(testButton, result);

  const modelField = field('모델', modelRow);
  const keyField = field('API 키', key);
  const urlField = field('주소', url);
  form.append(modelField, keyField, urlField, vision.root, remember.root, note, testRow);
  root.append(head, form);
  host.append(root);

  const setResult = (text: string, level: 'ok' | 'warn' | 'bad' | 'busy' | '') => {
    result.textContent = text;
    if (level) result.dataset.level = level;
    else delete result.dataset.level;
  };

  const render = () => {
    const settings = engine.settings;
    const provider = settings.provider;
    select.value = provider;
    form.hidden = provider === 'nano';
    if (provider !== 'nano') {
      const current = settings[provider];
      // 입력 중인 칸은 덮어쓰지 않는다.
      if (document.activeElement !== model) model.value = current.model;
      if (document.activeElement !== key) key.value = current.apiKey;
      model.placeholder = PLACEHOLDER[provider].model;
      key.placeholder = provider === 'local' ? '필요한 서버만 (보통 비워 둠)' : provider === 'claude' ? 'sk-ant-…' : 'sk-…';
      urlField.hidden = provider === 'claude';
      if (provider !== 'claude' && document.activeElement !== url) url.value = settings[provider].baseUrl;
      url.placeholder = PLACEHOLDER[provider].url;
      vision.root.hidden = provider !== 'local';
      vision.input.checked = settings.local.vision;
      remember.root.hidden = provider === 'local' && !current.apiKey;
      remember.input.checked = settings.remember;
      note.textContent = provider === 'local'
        ? `${url.value || DEFAULT_LOCAL_URL} 의 OpenAI 호환 API로 보냅니다. 요금은 없고 이 PC 자원을 씁니다.`
        : `검색·분해할 때마다 ${PROVIDER_LABEL[provider]} API 요금이 나갑니다. 콘솔에서 월 사용 한도를 걸어 두세요. 키는 ${settings.remember ? '이 기기에 저장됩니다.' : '이 탭에만 있다가 닫으면 사라집니다.'}`;
      const missing = engine.missing();
      if (missing && result.dataset.level !== 'busy') setResult(missing, 'warn');
      else if (!missing && result.dataset.level === 'warn') setResult('', '');
    }
    onChange();
  };

  select.addEventListener('change', () => {
    setResult('', '');
    models.replaceChildren();
    engine.update({ provider: select.value as ProviderId });
  });
  const patchCurrent = (patch: { model?: string; apiKey?: string; baseUrl?: string }) => {
    const provider = engine.provider;
    if (provider === 'nano') return;
    if (provider === 'claude') engine.update({ claude: { model: patch.model, apiKey: patch.apiKey } });
    else engine.update({ [provider]: patch });
  };
  // 키를 한 글자씩 저장소에 쓰지 않도록 칸을 떠날 때(change) 반영한다.
  model.addEventListener('change', () => patchCurrent({ model: model.value.trim() }));
  key.addEventListener('change', () => patchCurrent({ apiKey: key.value.trim() }));
  url.addEventListener('change', () => patchCurrent({ baseUrl: url.value.trim() }));
  vision.input.addEventListener('change', () => engine.update({ local: { vision: vision.input.checked } }));
  remember.input.addEventListener('change', () => engine.update({ remember: remember.input.checked }));

  listButton.addEventListener('click', async () => {
    listButton.disabled = true;
    try {
      const names = await engine.listModels();
      models.replaceChildren(...names.map((name) => new Option(name, name)));
      setResult(names.length ? `모델 ${names.length}개 · 칸을 눌러 고르세요` : '모델이 없습니다', names.length ? 'ok' : 'warn');
      if (!model.value && names.length === 1) {
        model.value = names[0]!;
        patchCurrent({ model: names[0]! });
      }
      model.focus();
    } catch (error) {
      setResult(`목록 실패: ${error instanceof Error ? error.message : error}`, 'bad');
    } finally {
      listButton.disabled = false;
    }
  });

  testButton.addEventListener('click', async () => {
    // 입력 칸에서 바로 누른 경우에도 마지막 값을 반영한다.
    patchCurrent({ model: model.value.trim(), apiKey: key.value.trim(), ...(engine.provider !== 'claude' ? { baseUrl: url.value.trim() } : {}) });
    testButton.disabled = true;
    setResult('확인 중…', 'busy');
    const outcome = await engine.test();
    setResult(outcome.ok ? `연결됨 · ${(outcome.ms / 1000).toFixed(1)}초` : `실패: ${outcome.message}`, outcome.ok ? 'ok' : 'bad');
    testButton.disabled = false;
    onChange();
  });

  const unsubscribe = engine.subscribe(render);
  render();
  return () => {
    unsubscribe();
    root.remove();
  };
}
