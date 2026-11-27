import { StrictMode, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ProviderId, ProviderOption, ReviewEvent, ReviewMode, WebErrorCode, WebInfo,
} from '../src/review/types.js';
import {
  cancelReview, fetchInfo, reconnectReview, ReviewCancelledError, submitReview, WebReviewError,
} from './api.js';
import { ReviewResults } from './results.js';
import './styles.css';

const eventLabels = {
  extract: 'Выделяю требования',
  individual: 'Проверяю отдельные требования',
  set: 'Сопоставляю разделы документа',
} as const;

const providerLabels: Record<ProviderOption['provider'], string> = {
  Gemini: 'Gemini API',
  Local: 'Локальная модель',
  'Codex CLI': 'Codex CLI',
};

const fallbackActionLabels: Record<ProviderId, string> = {
  local: 'Повторить на локальной модели',
  gemini: 'Повторить через Gemini API',
  codex: 'Повторить через Codex CLI',
};

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
  JOB_NOT_FOUND: 'Предыдущая проверка больше недоступна на сервере.',
  INTERNAL_ERROR: 'Проверка прервалась. Попробуйте ещё раз.',
};

type Result = Extract<ReviewEvent, { type: 'report' }>;
type Progress = Extract<ReviewEvent, { type: 'progress' }>;

interface SavedJob {
  jobId: string;
  documentName: string;
  documentSize?: number;
}

const sessionJobKey = 'requirements-review-active-job';

function readSavedJob(): SavedJob | undefined {
  try {
    const raw = sessionStorage.getItem(sessionJobKey);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<SavedJob>;
    if (typeof parsed.jobId === 'string' && /^[a-f0-9]{32}$/u.test(parsed.jobId)
      && typeof parsed.documentName === 'string' && parsed.documentName) {
      return {
        jobId: parsed.jobId,
        documentName: parsed.documentName,
        documentSize: typeof parsed.documentSize === 'number' ? parsed.documentSize : undefined,
      };
    }
  } catch {
    // Ignore storage access errors in restricted browsing contexts.
  }
  return undefined;
}

function writeSavedJob(job?: SavedJob) {
  try {
    if (job) {
      sessionStorage.setItem(sessionJobKey, JSON.stringify(job));
    } else {
      sessionStorage.removeItem(sessionJobKey);
    }
  } catch {
    // Ignore storage access errors in restricted browsing contexts.
  }
}

function App() {
  const [info, setInfo] = useState<WebInfo>();
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>();
  const [mode, setMode] = useState<ReviewMode>('standard');
  const [file, setFile] = useState<File>();
  const [savedJob, setSavedJob] = useState<SavedJob | undefined>(() => readSavedJob());
  const [activeJobId, setActiveJobId] = useState<string>();
  const [accessCode, setAccessCode] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<Progress>();
  const [result, setResult] = useState<Result>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<WebErrorCode>();
  const fileInput = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController>(null);
  const resultRegion = useRef<HTMLElement>(null);
  const autoReconnected = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchInfo(controller.signal).then((loaded) => {
      setInfo(loaded);
      if (loaded.defaultMode) {
        setMode(loaded.defaultMode);
      }
      setSelectedProvider((current) => {
        if (current && loaded.providers?.some((option) => option.id === current)) {
          return current;
        }
        return loaded.providers?.[0]?.id;
      });
    }).catch(() => {
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
    if (info && !info.requiresAccessCode && savedJob && !autoReconnected.current && !activeRequest.current) {
      autoReconnected.current = true;
      void resumeReview(savedJob, '');
    }
  }, [info, savedJob]);

  useEffect(() => {
    if (result) {
      resultRegion.current?.focus();
    }
  }, [result]);

  function selectFile(next?: File) {
    if (busy || !next) {
      return;
    }
    writeSavedJob(undefined);
    setSavedJob(undefined);
    setActiveJobId(undefined);
    setFile(undefined);
    setResult(undefined);
    setProgress(undefined);
    setNotice(undefined);
    setError(undefined);
    setErrorCode(undefined);
    if (!/\.(?:pdf|md|markdown|txt)$/iu.test(next.name)) {
      setError(errors.UNSUPPORTED_FORMAT);
      setErrorCode('UNSUPPORTED_FORMAT');
    } else if (!next.size) {
      setError('Файл пуст. Выберите документ с требованиями.');
    } else if (next.size > (info?.maxBytes ?? 10 * 1024 * 1024)) {
      setError(errors.LIMIT_EXCEEDED);
      setErrorCode('LIMIT_EXCEEDED');
    } else {
      setFile(next);
    }
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files[0]);
  }

  async function resumeReview(job: SavedJob, code: string) {
    if (activeRequest.current) {
      return;
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    setActiveJobId(job.jobId);
    setBusy(true);
    setCancelling(false);
    setError(undefined);
    setErrorCode(undefined);
    setNotice(undefined);
    setProgress(undefined);
    try {
      const completed = await reconnectReview(job.jobId, code, controller.signal, {
        onStarted: ({ jobId, documentName }) => {
          setActiveJobId(jobId);
          const next = { jobId, documentName, documentSize: job.documentSize };
          setSavedJob(next);
          writeSavedJob(next);
        },
        onProgress: setProgress,
      });
      setResult(completed);
    } catch (cause) {
      if (cause instanceof ReviewCancelledError) {
        writeSavedJob(undefined);
        setSavedJob(undefined);
        setActiveJobId(undefined);
        setNotice('Проверка отменена.');
      } else if (!controller.signal.aborted) {
        if (cause instanceof WebReviewError && cause.code === 'JOB_NOT_FOUND') {
          writeSavedJob(undefined);
          setSavedJob(undefined);
          setActiveJobId(undefined);
        } else {
          const code = cause instanceof WebReviewError ? cause.code : 'INTERNAL_ERROR';
          setErrorCode(code);
          setError(errors[code] ?? errors.INTERNAL_ERROR);
        }
      }
    } finally {
      activeRequest.current = null;
      setBusy(false);
      setCancelling(false);
    }
  }

  async function startReview(providerOverride?: ProviderId) {
    if (!file || activeRequest.current || !info?.configured) {
      return;
    }
    const providerToUse = providerOverride ?? selectedProvider ?? info.providers?.[0]?.id;
    if (providerOverride) {
      setSelectedProvider(providerOverride);
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    setActiveJobId(undefined);
    setBusy(true);
    setCancelling(false);
    setError(undefined);
    setErrorCode(undefined);
    setNotice(undefined);
    setProgress(undefined);
    setResult(undefined);
    try {
      const completed = await submitReview(file, accessCode, controller.signal, {
        onStarted: ({ jobId, documentName }) => {
          setActiveJobId(jobId);
          const next = { jobId, documentName, documentSize: file.size };
          setSavedJob(next);
          writeSavedJob(next);
        },
        onProgress: setProgress,
      }, providerToUse, mode);
      setResult(completed);
    } catch (cause) {
      if (cause instanceof ReviewCancelledError) {
        writeSavedJob(undefined);
        setSavedJob(undefined);
        setActiveJobId(undefined);
        setNotice('Проверка отменена.');
      } else if (!controller.signal.aborted) {
        const code = cause instanceof WebReviewError ? cause.code : 'INTERNAL_ERROR';
        if (code !== 'BUSY') {
          writeSavedJob(undefined);
          setSavedJob(undefined);
        }
        setErrorCode(code);
        setError(errors[code] ?? errors.INTERNAL_ERROR);
      }
    } finally {
      activeRequest.current = null;
      setBusy(false);
      setCancelling(false);
    }
  }

  async function handleCancel() {
    if (!busy || cancelling) {
      return;
    }
    setCancelling(true);
    const jobId = activeJobId ?? savedJob?.jobId;
    try {
      if (jobId) {
        await cancelReview(jobId, accessCode);
      }
      activeRequest.current?.abort();
      writeSavedJob(undefined);
      setSavedJob(undefined);
      setActiveJobId(undefined);
      setProgress(undefined);
      setError(undefined);
      setErrorCode(undefined);
      setNotice('Проверка отменена.');
    } catch (cause) {
      const code = cause instanceof WebReviewError ? cause.code : 'INTERNAL_ERROR';
      setErrorCode(code);
      setError(errors[code] ?? errors.INTERNAL_ERROR);
    } finally {
      setCancelling(false);
    }
  }

  const availableProviders = info?.providers ?? [];
  const activeProvider = availableProviders.find((option) => option.id === selectedProvider) ?? availableProviders[0];
  const fallbackProvider = (errorCode === 'MODEL_LIMIT' || errorCode === 'MODEL_UNAVAILABLE' || errorCode === 'MODEL_CONTEXT')
    ? availableProviders.find((option) => option.id !== activeProvider?.id)
    : undefined;
  const displayFileName = file?.name ?? savedJob?.documentName;
  const displayFileSize = file?.size ?? savedJob?.documentSize;
  const canReconnectWithCode = Boolean(
    info?.requiresAccessCode && savedJob && !busy && !result,
  );
  const displayProvider = activeProvider?.provider ?? info?.provider;
  const displayModel = activeProvider?.model ?? info?.model;

  const configuredLabel = info?.configured && displayProvider
    ? providerLabels[displayProvider]
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
              className={`drop-zone ${dragging ? 'is-dragging' : ''} ${displayFileName ? 'has-file' : ''}`}
              onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setDragging(false);
                }
              }}
              onDrop={drop}
            >
              <span className="file-symbol" aria-hidden="true">{displayFileName ? '✓' : '↑'}</span>
              <div className="file-detail">
                <strong>{displayFileName ?? 'Перетащите файл сюда'}</strong>
                <span>
                  {displayFileName
                    ? (displayFileSize !== undefined ? formatFileSize(displayFileSize) : 'Активная сессия проверки')
                    : 'PDF, Markdown или TXT · до 10 МБ'}
                </span>
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
              >
                {displayFileName ? 'Заменить' : 'Выбрать файл'}
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

            <div className="provider-field">
              <span className="provider-label" id="mode-label">Режим проверки</span>
              <div className="provider-switch" role="group" aria-labelledby="mode-label">
                <button
                  type="button"
                  aria-pressed={mode === 'standard'}
                  disabled={busy}
                  onClick={() => setMode('standard')}
                >
                  Стандартный
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'fintech'}
                  disabled={busy}
                  onClick={() => setMode('fintech')}
                >
                  FinTech / Банкинг
                </button>
              </div>
              {mode === 'fintech' && (
                <p className="mode-hint">
                  Дополнительно проверяет идемпотентность, валюты и округления, часовые пояса, сторно, маскирование PII/PCI и аудит.
                </p>
              )}
            </div>

            {availableProviders.length > 1 && (
              <div className="provider-field">
                <span className="provider-label" id="provider-label">Модель проверки</span>
                <div className="provider-switch" role="group" aria-labelledby="provider-label">
                  {availableProviders.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={activeProvider?.id === option.id}
                      disabled={busy}
                      onClick={() => {
                        setSelectedProvider(option.id);
                        setError(undefined);
                        setErrorCode(undefined);
                      }}
                    >
                      {providerLabels[option.provider]}
                    </button>
                  ))}
                </div>
              </div>
            )}

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
                onClick={() => void startReview()}
                disabled={busy || !file || !info?.configured || (info.requiresAccessCode && !accessCode.trim())}
              >
                {busy ? 'Идёт проверка' : 'Проверить требования'}
                <span aria-hidden="true">{busy ? '…' : '→'}</span>
              </button>
              {busy && (
                <button
                  type="button"
                  className="button secondary cancel-button"
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? 'Отменяю…' : 'Отменить'}
                </button>
              )}
              {canReconnectWithCode && savedJob && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void resumeReview(savedJob, accessCode)}
                  disabled={!accessCode.trim()}
                >
                  Вернуться к проверке
                </button>
              )}
            </div>
            {busy && (
              <p className="progress" role="status">
                <span className="spinner" aria-hidden="true" />
                {progress ? eventLabels[progress.phase] : 'Подключаюсь к проверке'}
                {progress && progress.total > 1 ? ` (${progress.completed + 1}/${progress.total})` : ''}
              </p>
            )}
            {notice && !error && <p className="notice" role="status">{notice}</p>}
            {error && (
              <div className="notice error" role="alert">
                <p>{error}</p>
                {fallbackProvider && file && !busy && (
                  <button
                    type="button"
                    className="button secondary fallback-button"
                    onClick={() => void startReview(fallbackProvider.id)}
                    disabled={Boolean(info?.requiresAccessCode && !accessCode.trim())}
                  >
                    {fallbackActionLabels[fallbackProvider.id]}
                  </button>
                )}
              </div>
            )}
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
              {mode === 'fintech' && (
                <li>
                  <span className="method-icon" aria-hidden="true">₽</span>
                  <div>
                    <strong>FinTech-аудит</strong>
                    <p>Идемпотентность, округление валют, сторно, маскирование PII/PCI и аудит операций.</p>
                  </div>
                </li>
              )}
            </ul>
            {displayModel && <div className="model-name">{displayModel}</div>}
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
