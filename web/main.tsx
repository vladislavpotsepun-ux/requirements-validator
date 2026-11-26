import { StrictMode, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReviewEvent, WebErrorCode, WebInfo } from '../src/review/types.js';
import { fetchInfo, submitReview, WebReviewError } from './api.js';
import { ReviewResults } from './results.js';
import './styles.css';

const eventLabels = {
  extract: 'Выделяю требования',
  individual: 'Проверяю отдельные требования',
  set: 'Сопоставляю разделы документа',
} as const;

const errors: Record<WebErrorCode, string> = {
  UNSUPPORTED_FORMAT: 'Выберите файл PDF, Markdown или TXT.',
  INVALID_DOCUMENT: 'Файл не удалось прочитать. Проверьте формат и попробуйте другой документ.',
  LIMIT_EXCEEDED: 'Документ превышает лимит. Допускается до 10 МБ, 50 страниц PDF или 48 000 символов текста.',
  NO_TEXT: 'В файле нет доступного текста. Для скана нужен PDF с текстовым слоем.',
  NO_REQUIREMENTS: 'Агент не нашёл проверяемых требований в этом документе.',
  INVALID_MODEL_OUTPUT: 'Модель вернула неполный результат или ссылки, которые не удалось проверить. Повторите анализ.',
  MODEL_CONFIG: 'Модель не настроена. Проверьте ключ API, название модели и доступ к ней.',
  MODEL_CONTEXT: 'Документ слишком объёмный для локальной модели. Сократите его или запустите проверку через Gemini.',
  MODEL_LIMIT: 'Лимит запросов к модели исчерпан. Попробуйте позже.',
  MODEL_UNAVAILABLE: 'Модель не ответила. Повторите анализ через несколько минут.',
  BUSY: 'Другой документ уже проверяется. Повторите запуск чуть позже.',
  ACCESS_DENIED: 'Проверьте код доступа.',
  INTERNAL_ERROR: 'Проверка прервалась. Попробуйте ещё раз.',
};

type Result = Extract<ReviewEvent, { type: 'report' }>;
type Progress = Extract<ReviewEvent, { type: 'progress' }>;

function App() {
  const [info, setInfo] = useState<WebInfo>();
  const [file, setFile] = useState<File>();
  const [accessCode, setAccessCode] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress>();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController>(null);
  const resultRegion = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchInfo(controller.signal).then(setInfo).catch(() => {
      if (!controller.signal.aborted) {
        setError('Не удалось получить настройки сервера. Обновите страницу.');
      }
    });
    return () => {
      controller.abort();
      activeRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (result) {
      resultRegion.current?.focus();
    }
  }, [result]);

  function selectFile(next?: File) {
    if (busy || !next) {
      return;
    }
    setFile(undefined);
    setResult(undefined);
    setProgress(undefined);
    setError(undefined);
    if (!/\.(?:pdf|md|markdown|txt)$/iu.test(next.name)) {
      setError(errors.UNSUPPORTED_FORMAT);
    } else if (!next.size) {
      setError('Файл пуст. Выберите документ с требованиями.');
    } else if (next.size > (info?.maxBytes ?? 10 * 1024 * 1024)) {
      setError(errors.LIMIT_EXCEEDED);
    } else {
      setFile(next);
    }
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files[0]);
  }

  async function startReview() {
    if (!file || activeRequest.current || !info?.configured) {
      return;
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setError(undefined);
    setProgress(undefined);
    setResult(undefined);
    try {
      setResult(await submitReview(file, accessCode, controller.signal, setProgress));
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof WebReviewError
          ? errors[cause.code] ?? errors.INTERNAL_ERROR
          : errors.INTERNAL_ERROR);
      }
    } finally {
      activeRequest.current = null;
      setBusy(false);
    }
  }

  const configuredLabel = info?.configured
    ? (info.provider === 'Local' ? 'Локальная модель' : info.provider === 'Codex CLI' ? 'Codex CLI' : 'Gemini API')
    : (info ? 'Модель не настроена' : 'Проверка подключения');

  return (
    <>
      <header className="site-header">
        <div className="container header-inner">
          <span className="brand"><span className="brand-mark" aria-hidden="true" /> Ревью требований</span>
          <span className={`connection ${info?.configured ? 'is-connected' : ''}`}>
            <span aria-hidden="true" /> {configuredLabel}
          </span>
        </div>
      </header>
      <main className="container">
        <div className="intro">
          <h1>Готовы ли требования<br className="desktop-break" /> к разработке?</h1>
          <p>
            Загрузите спецификацию и получите отчёт о противоречиях, пробелах и выполнимости
            со ссылками на исходный текст.
          </p>
        </div>

        <div className="workspace">
          <section className="upload-card" aria-labelledby="document-title">
            <h2 id="document-title">Документ требований</h2>
            <div
              className={`drop-zone ${dragging ? 'is-dragging' : ''} ${file ? 'has-file' : ''}`}
              onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setDragging(false);
                }
              }}
              onDrop={drop}
            >
              <span className="file-symbol" aria-hidden="true">{file ? '✓' : '↑'}</span>
              <div className="file-detail">
                <strong>{file?.name ?? 'Перетащите файл сюда'}</strong>
                <span>{file ? formatFileSize(file.size) : 'PDF, Markdown или TXT · до 10 МБ'}</span>
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
              >
                {file ? 'Заменить' : 'Выбрать файл'}
              </button>
              <input
                ref={fileInput}
                type="file"
                hidden
                aria-label="Документ требований"
                accept=".pdf,.md,.markdown,.txt"
                onChange={(event) => {
                  selectFile(event.currentTarget.files?.[0]);
                  event.currentTarget.value = '';
                }}
              />
            </div>

            {info?.requiresAccessCode && (
              <label className="access-field">
                Код доступа
                <input
                  type="password"
                  value={accessCode}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => setAccessCode(event.target.value)}
                />
              </label>
            )}
            <div className="upload-actions">
              <button
                type="button"
                className="button primary"
                onClick={startReview}
                disabled={busy || !file || !info?.configured || (info.requiresAccessCode && !accessCode.trim())}
              >
                {busy ? 'Идёт проверка' : 'Проверить требования'}
                <span aria-hidden="true">{busy ? '…' : '→'}</span>
              </button>
              {busy && (
                <button type="button" className="button text-button" onClick={() => activeRequest.current?.abort()}>
                  Отменить
                </button>
              )}
            </div>
            {busy && (
              <p className="progress" role="status">
                <span className="spinner" aria-hidden="true" />
                {progress ? eventLabels[progress.phase] : 'Читаю документ'}
                {progress && progress.total > 1 ? ` (${progress.completed + 1}/${progress.total})` : ''}
              </p>
            )}
            {error && <p className="notice error" role="alert">{error}</p>}
            {info && !info.configured && !error && <p className="notice">{errors.MODEL_CONFIG}</p>}
          </section>

          <aside className="method-card" aria-labelledby="method-title">
            <h2 id="method-title">Что проверит агент</h2>
            <ul>
              <li>
                <span className="method-icon" aria-hidden="true">≡</span>
                <div><strong>Формулировки</strong><p>Можно ли однозначно понять и проверить каждое требование.</p></div>
              </li>
              <li>
                <span className="method-icon" aria-hidden="true">⇄</span>
                <div><strong>Согласованность</strong><p>Совпадают ли бизнес-правила, API и критерии приёмки.</p></div>
              </li>
              <li>
                <span className="method-icon" aria-hidden="true">✓</span>
                <div><strong>Выполнимость</strong><p>Каких решений и сведений не хватает для начала работ.</p></div>
              </li>
            </ul>
            {info?.model && <div className="model-name">{info.model}</div>}
          </aside>
        </div>

        {result && (
          <section className="result-region" aria-labelledby="result-title" tabIndex={-1} ref={resultRegion}>
            <ReviewResults report={result.report} file={result.file} />
          </section>
        )}
      </main>
      <footer className="container footer">Критерии качества основаны на ISO/IEC/IEEE 29148 и IEEE 830.</footer>
    </>
  );
}

function formatFileSize(bytes: number): string {
  const formatter = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });
  return bytes < 1024 * 1024
    ? `${formatter.format(bytes / 1024)} КБ`
    : `${formatter.format(bytes / (1024 * 1024))} МБ`;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
