/**
 * 로컬 실행 진단 패널. 서버 대신 브라우저가 해야 하는 세 가지가 준비됐는지 보여 준다.
 * 1) 다른 출처 문서 읽기(CORS 꺼짐)  2) Gemini Nano(텍스트·이미지)  3) 임베딩 모델
 * 모델 다운로드는 사용자 클릭이 필요하므로 버튼으로 시작한다.
 */
import './status-panel.css';
import { nano, type NanoStatus } from './nano.ts';
import { isCrossOriginReadable } from './remote-fetch.ts';
import { activateTranslator, translatorStatus } from './translate.ts';
import { embedder, type EmbedderState } from './deconstruct/embed.ts';
import { PROGRESS_EVENT } from './events.ts';

type Level = 'ok' | 'warn' | 'bad' | 'busy';

const NANO_LABEL: Record<NanoStatus, [string, Level]> = {
  ready: ['준비됨', 'ok'],
  downloadable: ['모델 받기 필요', 'warn'],
  downloading: ['모델 받는 중', 'busy'],
  unavailable: ['이 기기에서 사용 불가 · 대체 경로 사용', 'bad'],
  unsupported: ['Prompt API 없음 · 대체 경로 사용', 'bad'],
};

function row(label: string): { root: HTMLElement; value: HTMLElement; action: HTMLButtonElement } {
  const root = document.createElement('div');
  root.className = 'local-status-row';
  const name = document.createElement('span');
  name.className = 'local-status-name';
  name.textContent = label;
  const value = document.createElement('span');
  value.className = 'local-status-value';
  const action = document.createElement('button');
  action.type = 'button';
  action.hidden = true;
  root.append(name, value, action);
  return { root, value, action };
}

function setValue(target: HTMLElement, text: string, level: Level) {
  target.textContent = text;
  target.dataset.level = level;
}

const formatMb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;

export function mountStatusPanel(host: HTMLElement = document.body): () => void {
  const panel = document.createElement('details');
  panel.className = 'local-status';
  const summary = document.createElement('summary');
  summary.textContent = '로컬 엔진';
  const activity = document.createElement('p');
  activity.className = 'local-status-activity';
  activity.hidden = true;

  const cors = row('사이트 읽기');
  const text = row('Gemini Nano');
  const image = row('Nano 이미지');
  const translate = row('번역 영→한');
  const embed = row('임베딩 모델');
  panel.append(summary, cors.root, text.root, image.root, translate.root, embed.root, activity);
  host.append(panel);

  let disposed = false;
  const levels = new Map<string, Level>();
  const refreshSummary = () => {
    const values = [...levels.values()];
    panel.dataset.level = values.includes('bad') ? 'bad' : values.includes('warn') ? 'warn' : values.includes('busy') ? 'busy' : 'ok';
    if (values.includes('bad') && !panel.dataset.opened) {
      panel.open = true;
      panel.dataset.opened = 'true';
    }
  };

  void isCrossOriginReadable().then((ok) => {
    if (disposed) return;
    setValue(cors.value, ok ? 'CORS 꺼짐 · 정상' : 'CORS 켜짐 · 검색과 분해 불가', ok ? 'ok' : 'bad');
    cors.root.title = ok ? '' : 'pnpm local 로 실행하면 CORS를 끈 전용 Chrome 프로필이 열립니다.';
    levels.set('cors', ok ? 'ok' : 'bad');
    refreshSummary();
  });

  const showNano = async (modality: 'text' | 'image', target: ReturnType<typeof row>, fresh = false) => {
    const status = await nano.status(modality, fresh);
    if (disposed) return;
    const [label, level] = NANO_LABEL[status];
    setValue(target.value, label, level);
    levels.set(modality, modality === 'image' && level === 'bad' ? 'warn' : level);
    target.action.hidden = status !== 'downloadable';
    target.action.textContent = '받기';
    refreshSummary();
    if (status === 'downloading') setTimeout(() => void showNano(modality, target, true), 5_000);
  };
  const activate = (modality: 'text' | 'image', target: ReturnType<typeof row>) => async () => {
    target.action.disabled = true;
    target.action.hidden = true;
    // create()는 다운로드가 끝나야 돌아오고 진행 이벤트가 늦게 오는 경우가 있어, 상태를 따로 다시 묻는다.
    setValue(target.value, '모델 받는 중', 'busy');
    setTimeout(() => void showNano(modality, target, true), 2_000);
    try {
      const status = await nano.activate(modality, (ratio) => setValue(target.value, `모델 받는 중 ${Math.round(ratio * 100)}%`, 'busy'));
      if (status !== 'ready') setTimeout(() => void showNano(modality, target, true), 3_000);
    } catch (error) {
      setValue(target.value, `받기 실패: ${error instanceof Error ? error.message : error}`, 'bad');
    } finally {
      target.action.disabled = false;
      void showNano(modality, target, true);
    }
  };
  text.action.addEventListener('click', activate('text', text));
  image.action.addEventListener('click', activate('image', image));
  void showNano('text', text);
  void showNano('image', image);

  // Nano는 한국어 출력이 공식 지원되지 않아 영어 결과를 옮길 때 쓴다. 없어도 동작한다.
  const showTranslator = async () => {
    const status = await translatorStatus();
    if (disposed) return;
    const [label, level] = NANO_LABEL[status];
    setValue(translate.value, status === 'unavailable' || status === 'unsupported' ? '사용 불가 · 영어 그대로 사용' : label, level === 'bad' ? 'warn' : level);
    levels.set('translate', level === 'bad' ? 'warn' : level);
    translate.action.hidden = status !== 'downloadable';
    translate.action.textContent = '받기';
    refreshSummary();
    if (status === 'downloading') setTimeout(() => void showTranslator(), 3_000);
  };
  translate.action.addEventListener('click', async () => {
    translate.action.disabled = true;
    translate.action.hidden = true;
    setValue(translate.value, '모델 받는 중', 'busy');
    setTimeout(() => void showTranslator(), 2_000);
    try {
      await activateTranslator((ratio) => setValue(translate.value, `모델 받는 중 ${Math.round(ratio * 100)}%`, 'busy'));
    } catch (error) {
      setValue(translate.value, `받기 실패: ${error instanceof Error ? error.message : error}`, 'bad');
    } finally {
      translate.action.disabled = false;
      void showTranslator();
    }
  });
  void showTranslator();

  const showEmbed = (state: EmbedderState) => {
    if (disposed) return;
    embed.action.hidden = state.status !== 'idle' && state.status !== 'error';
    embed.action.textContent = state.status === 'error' ? '다시 시도' : '미리 받기';
    if (state.status === 'idle') setValue(embed.value, '분해 때 받음 · 약 700MB', 'warn');
    else if (state.status === 'loading') setValue(embed.value, state.total ? `받는 중 ${formatMb(state.loaded)} / ${formatMb(state.total)}` : '불러오는 중', 'busy');
    else if (state.status === 'ready') setValue(embed.value, `준비됨 (${state.device})`, 'ok');
    else setValue(embed.value, `실패: ${state.message}`, 'bad');
    levels.set('embed', state.status === 'idle' ? 'ok' : state.status === 'loading' ? 'busy' : state.status === 'ready' ? 'ok' : 'bad');
    refreshSummary();
  };
  const unsubscribe = embedder.subscribe(showEmbed);
  embed.action.addEventListener('click', () => void embedder.load().catch(() => {}));

  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  const onProgress = (event: Event) => {
    activity.hidden = false;
    activity.textContent = String((event as CustomEvent).detail ?? '');
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { activity.hidden = true; }, 15_000);
  };
  window.addEventListener(PROGRESS_EVENT, onProgress);

  return () => {
    disposed = true;
    unsubscribe();
    clearTimeout(clearTimer);
    window.removeEventListener(PROGRESS_EVENT, onProgress);
    panel.remove();
  };
}
