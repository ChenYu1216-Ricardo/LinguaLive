"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { isUnclearSpeechResult } from "./speech-results";

type SessionState = "idle" | "starting" | "listening" | "paused" | "error";
type MicrophoneState = "idle" | "checking" | "silent" | "active";

type Caption = {
  id: number;
  source: string;
  text: string;
  createdAt: number;
  sourceLanguage: string;
  targetLanguage: string;
  pending?: boolean;
};

type WordLookup = {
  word: string;
  meaning: string;
  targetLanguage: string;
};

type LanguageOption = {
  code: string;
  label: string;
  short: string;
  speech: string;
};

type SpeechRecognitionAlternativeLike = {
  transcript: string;
  confidence: number;
};

type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
};

type SpeechRecognitionEventLike = Event & {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorEventLike = Event & {
  readonly error: string;
};

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onnomatch: (() => void) | null;
};

type TranslatorLike = {
  translate: (text: string, options?: { signal?: AbortSignal }) => Promise<string>;
  destroy?: () => void;
};

type TranslatorConstructorLike = {
  availability?: (options: {
    sourceLanguage: string;
    targetLanguage: string;
  }) => Promise<string>;
  create: (options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: EventTarget) => void;
  }) => Promise<TranslatorLike>;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    Translator?: TranslatorConstructorLike;
  }
}

const UNCLEAR = "【未听清】";
const TRANSLATION_UNAVAILABLE = "【翻译暂不可用】";
const NO_SOUND_MESSAGE = "未检测到声音，请检查当前麦克风输入。";
const NO_RESULT_MESSAGE =
  "已检测到麦克风声音，但当前浏览器没有返回语音字幕。请复制链接，用最新版 Chrome 打开。";
const NETWORK_FAILURE_MESSAGE = "浏览器语音识别服务连续连接失败。请检查网络，或用最新版 Chrome 打开此页面重试。"; const MAX_HISTORY = 2_000;
const HISTORY_STORAGE_KEY = "classroom-interpreter-history-v1";
const LANGUAGE_STORAGE_KEY = "classroom-interpreter-languages-v1";
const GUIDE_STORAGE_KEY = "classroom-interpreter-guide-v1";
const SILENCE_NOTICE_MS = 4_500;
const RECOGNITION_STALL_MS = 10_000;
const PARTIAL_TRANSLATION_INTERVAL_MS = 650;
const TRANSLATION_TIMEOUT_MS = 12_000;
const MAX_STALL_RESTARTS = 3;

const WORD_PATTERN = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/;

const LANGUAGES: LanguageOption[] = [
  { code: "en", label: "英语", short: "EN", speech: "en-AU" },
  { code: "zh-CN", label: "简体中文", short: "中", speech: "zh-CN" },
  { code: "es", label: "西班牙语", short: "ES", speech: "es-ES" },
  { code: "fr", label: "法语", short: "FR", speech: "fr-FR" },
  { code: "de", label: "德语", short: "DE", speech: "de-DE" },
  { code: "ja", label: "日语", short: "日", speech: "ja-JP" },
  { code: "ko", label: "韩语", short: "한", speech: "ko-KR" },
  { code: "pt", label: "葡萄牙语", short: "PT", speech: "pt-BR" },
  { code: "it", label: "意大利语", short: "IT", speech: "it-IT" },
  { code: "ru", label: "俄语", short: "RU", speech: "ru-RU" },
  { code: "ar", label: "阿拉伯语", short: "AR", speech: "ar-SA" },
  { code: "hi", label: "印地语", short: "HI", speech: "hi-IN" },
  { code: "id", label: "印度尼西亚语", short: "ID", speech: "id-ID" },
  { code: "vi", label: "越南语", short: "VI", speech: "vi-VN" },
  { code: "th", label: "泰语", short: "TH", speech: "th-TH" },
];

const languageByCode = (code: string) =>
  LANGUAGES.find((language) => language.code === code) ?? LANGUAGES[0];

function EnglishWords({
  text,
  onSelect,
}: {
  text: string;
  onSelect: (word: string) => void;
}) {
  const parts = text.split(/([A-Za-z]+(?:['’-][A-Za-z]+)*)/g);

  return (
    <span className="word-text" lang="en">
      {parts.map((part, index) =>
        WORD_PATTERN.test(part) ? (
          <button
            className="word-button"
            key={`${part}-${index}`}
            type="button"
            onClick={() => onSelect(part)}
            title={`查询 ${part}`}
          >
            {part}
          </button>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </span>
  );
}

const PRESERVE_PATTERN = new RegExp(
  [
    String.raw`https?:\/\/\S+`,
    String.raw`\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b`,
    String.raw`\$[^$]+\$`,
    String.raw`\\\([^)]*\\\)`,
    String.raw`\\\[[^\]]*\\\]`,
    String.raw`\b(?:mRNA|pH|eGFR|[a-z][A-Z]{2,}[A-Za-z0-9-]*)\b`,
    String.raw`\b(?:[A-Z][A-Z0-9]*)(?:[-/][A-Z0-9]+)*\b`,
    String.raw`[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?\s?(?:%|‰|°[CF]|[kMGTmunpµμ]?(?:m|g|s|A|K|mol|cd|L|l|Hz|Pa|J|W|V|Ω|ohm|B|bps)(?:[²³23]|\^[+-]?\d+)?(?:\/[A-Za-zµμΩ0-9²³^+-]+)?)?`,
    String.raw`\b[A-Za-zΔλμΩ][A-Za-z0-9_]*(?:\s*[=<>≤≥≈±×÷]\s*[-+]?\s*[A-Za-z0-9_().^/*+-]+)+`,
  ].join("|"),
  "g",
);

function protectExactText(text: string) {
  const fragments: Array<{ text: string; exact: boolean }> = [];
  const matcher = new RegExp(PRESERVE_PATTERN.source, "g");
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text))) {
    if (match.index > cursor) {
      fragments.push({ text: text.slice(cursor, match.index), exact: false });
    }
    fragments.push({ text: match[0], exact: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    fragments.push({ text: text.slice(cursor), exact: false });
  }

  let exactIndex = 0;
  const protectedText = fragments
    .map((fragment) =>
      fragment.exact ? `ZXQ${exactIndex++}QXZ` : fragment.text,
    )
    .join("");

  return {
    protectedText,
    fragments,
    restore(translated: string) {
      let restored = translated;
      const values = fragments.filter((fragment) => fragment.exact);
      for (const [index, fragment] of values.entries()) {
        const marker = new RegExp(`ZXQ\\s*${index}\\s*QXZ`, "gi");
        const matches = restored.match(marker);
        if (matches?.length !== 1) return null;
        restored = restored.replace(marker, fragment.text);
      }
      if (/ZXQ\s*\d+\s*QXZ/i.test(restored)) return null;
      return restored.replace(/\s+([，。！？；：、])/g, "$1").trim();
    },
  };
}

function errorMessage(error: string) {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "无法使用麦克风，请允许麦克风权限后重试。";
    case "audio-capture":
      return "未找到可用麦克风，请检查输入设备。";
    case "network":
      return "连接中断，正在等待重试。";
    default:
      return "语音识别暂不可用，请重试。";
  }
}

function microphoneErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) {
    return "无法启动麦克风，请重试。";
  }

  switch (error.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "无法使用麦克风，请允许此网站和当前浏览器使用麦克风后重试。";
    case "NotFoundError":
      return "未找到可用麦克风，请检查输入设备。";
    case "NotReadableError":
    case "AbortError":
      return "麦克风正被其他应用占用，请关闭占用后重试。";
    default:
      return "无法启动麦克风，请重试。";
  }
}

async function withTranslationTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(),
    TRANSLATION_TIMEOUT_MS,
  );
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new DOMException("Translation interrupted", "AbortError")),
      { once: true },
    );
  });
  if (externalSignal?.aborted) controller.abort();

  try {
    return await Promise.race([work(controller.signal), aborted]);
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

export default function Home() {
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [microphoneState, setMicrophoneState] =
    useState<MicrophoneState>("idle");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [interimSource, setInterimSource] = useState("");
  const [interimCaption, setInterimCaption] = useState("");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState("");
  const [translatorReady, setTranslatorReady] = useState(true);
  const [linkCopied, setLinkCopied] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyReady, setHistoryReady] = useState(false);
  const [historyCopied, setHistoryCopied] = useState(false);
  const [selectedWord, setSelectedWord] = useState("");
  const [wordLookup, setWordLookup] = useState<WordLookup | null>(null);
  const [wordLoading, setWordLoading] = useState(false);
  const [wordError, setWordError] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState("en");
  const [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [languageReady, setLanguageReady] = useState(false);
  const [followLatest, setFollowLatest] = useState(true);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideStep, setGuideStep] = useState(0);
  const [copiedCaptionId, setCopiedCaptionId] = useState<number | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const translatorRef = useRef<TranslatorLike | null>(null);
  const translatorPromiseRef = useRef<Promise<TranslatorLike | null> | null>(null);
  const translatorPairRef = useRef("");
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const monitorFrameRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const shouldListenRef = useRef(false);
  const isPausedRef = useRef(false);
  const recognitionActiveRef = useRef(false);
  const voiceEnabledRef = useRef(true);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const utterancesRef = useRef(new Set<SpeechSynthesisUtterance>());
  const captionIdRef = useRef(0);
  const partialSequenceRef = useRef(0);
  const partialAbortRef = useRef<AbortController | null>(null);
  const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const partialLastStartedRef = useRef(0);
  const translationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const restartDelayRef = useRef(240);
  const microphoneStateRef = useRef<MicrophoneState>("idle");
  const monitorStartedAtRef = useRef(0);
  const lastAudioAtRef = useRef(0);
  const unrecognizedAudioAtRef = useRef(0);
  const lastMeterUpdateRef = useRef(0);
  const recognitionStalledRef = useRef(false);
  const noSpeechCountRef = useRef(0); const networkFailureCountRef = useRef(0);
  const stallRestartCountRef = useRef(0);
  const committedResultsRef = useRef(new Set<number>());
  const lastNoMatchAtRef = useRef(0);
  const interimCaptionRef = useRef("");
  const wordLookupAbortRef = useRef<AbortController | null>(null);
  const wordLookupCacheRef = useRef(new Map<string, WordLookup>());
  const sourceLanguageRef = useRef("en");
  const targetLanguageRef = useRef("zh-CN");
  const captionsViewportRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);

  const statusLabel = {
    idle: "未开始",
    starting: "正在连接",
    listening: "正在聆听",
    paused: "已暂停",
    error: "需要处理",
  }[sessionState];

  const setMicrophoneStatus = useCallback((state: MicrophoneState) => {
    if (microphoneStateRef.current === state) return;
    microphoneStateRef.current = state;
    setMicrophoneState(state);
  }, []);

  const releaseMicrophone = useCallback(
    (updateState = true) => {
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      if (monitorFrameRef.current !== null) {
        window.cancelAnimationFrame(monitorFrameRef.current);
        monitorFrameRef.current = null;
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => undefined);
        audioContextRef.current = null;
      }
      if (updateState) setMicrophoneStatus("idle");
    },
    [setMicrophoneStatus],
  );

  const startMicrophoneMonitor = useCallback(
    (stream: MediaStream) => {
      setMicrophoneStatus("checking");
      monitorStartedAtRef.current = Date.now();
      lastAudioAtRef.current = 0;
      unrecognizedAudioAtRef.current = 0;
      lastMeterUpdateRef.current = 0;
      recognitionStalledRef.current = false;
      noSpeechCountRef.current = 0;

      try {
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.7;
        source.connect(analyser);
        audioContextRef.current = audioContext;

        const samples = new Uint8Array(analyser.fftSize);
        const monitor = () => {
          if (
            mediaStreamRef.current !== stream ||
            !shouldListenRef.current ||
            isPausedRef.current
          ) {
            return;
          }

          analyser.getByteTimeDomainData(samples);
          let energy = 0;
          for (const sample of samples) {
            const normalized = (sample - 128) / 128;
            energy += normalized * normalized;
          }
          const rms = Math.sqrt(energy / samples.length);
          const now = Date.now();

          if (rms >= 0.018) {
            lastAudioAtRef.current = now;
            if (unrecognizedAudioAtRef.current === 0) {
              unrecognizedAudioAtRef.current = now;
            }
            if (now - lastMeterUpdateRef.current >= 120) {
              setMicrophoneStatus("active");
              lastMeterUpdateRef.current = now;
            }
            setError((current) =>
              current === NO_SOUND_MESSAGE ? "" : current,
            );
          } else if (
            lastAudioAtRef.current === 0 &&
            now - monitorStartedAtRef.current >= SILENCE_NOTICE_MS
          ) {
            setMicrophoneStatus("silent");
            setError((current) => current || NO_SOUND_MESSAGE);
          }

          if (
            !recognitionStalledRef.current &&
            unrecognizedAudioAtRef.current > 0 &&
            now - unrecognizedAudioAtRef.current >= RECOGNITION_STALL_MS
          ) {
            recognitionStalledRef.current = true;
            unrecognizedAudioAtRef.current = 0;
            stallRestartCountRef.current += 1;
            if (stallRestartCountRef.current >= MAX_STALL_RESTARTS) {
              shouldListenRef.current = false;
              recognitionRef.current?.abort();
              setSessionState("error");
              setError(NO_RESULT_MESSAGE);
              releaseMicrophone();
              return;
            }
            setSessionState("starting");
            setError("语音识别暂时没有返回字幕，正在重新连接…");
            recognitionRef.current?.abort();
          }

          monitorFrameRef.current = window.requestAnimationFrame(monitor);
        };

        monitorFrameRef.current = window.requestAnimationFrame(monitor);
      } catch {
        // Permission/device preflight still succeeds if Web Audio is unavailable.
        setMicrophoneStatus("active");
      }
    },
    [releaseMicrophone, setMicrophoneStatus],
  );

  const prepareMicrophone = useCallback(async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new DOMException("Microphone unavailable", "SecurityError");
    }

    releaseMicrophone();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const liveTrack = stream
      .getAudioTracks()
      .find((track) => track.readyState === "live");
    if (!liveTrack) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("Microphone unavailable", "NotReadableError");
    }

    mediaStreamRef.current = stream;
    startMicrophoneMonitor(stream);
  }, [releaseMicrophone, startMicrophoneMonitor]);

  const scheduleRecognitionStart = useCallback((initialDelay = 240) => {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
    }
    if (
      !shouldListenRef.current ||
      isPausedRef.current ||
      recognitionActiveRef.current
    ) {
      restartTimerRef.current = null;
      return;
    }

    setSessionState("starting");
    const attempt = () => {
      restartTimerRef.current = null;
      if (
        !shouldListenRef.current ||
        isPausedRef.current ||
        recognitionActiveRef.current
      ) {
        return;
      }

      try {
        recognitionRef.current?.start();
      } catch {
        restartDelayRef.current = Math.min(
          Math.max(restartDelayRef.current * 2, 480),
          4000,
        );
        restartTimerRef.current = window.setTimeout(
          attempt,
          restartDelayRef.current,
        );
      }
    };

    restartTimerRef.current = window.setTimeout(attempt, initialDelay);
  }, []);

  const ensureTranslator = useCallback(async (sourceCode: string, targetCode: string) => {
    const pair = `${sourceCode}:${targetCode}`;
    if (translatorRef.current && translatorPairRef.current === pair) {
      return translatorRef.current;
    }
    if (translatorPromiseRef.current && translatorPairRef.current === pair) {
      return translatorPromiseRef.current;
    }

    translatorRef.current?.destroy?.();
    translatorRef.current = null;
    translatorPromiseRef.current = null;
    translatorPairRef.current = pair;

    const TranslatorApi = window.Translator;
    if (!TranslatorApi?.create) {
      setTranslatorReady(true);
      return null;
    }

    translatorPromiseRef.current = TranslatorApi.create({
      sourceLanguage: sourceCode,
      targetLanguage: targetCode,
    })
      .then((translator) => {
        if (translatorPairRef.current === pair) {
          translatorRef.current = translator;
        }
        setTranslatorReady(true);
        return translator;
      })
      .catch(() => {
        setTranslatorReady(true);
        return null;
      });

    return translatorPromiseRef.current;
  }, []);

  const translateText = useCallback(
    async (
      source: string,
      signal?: AbortSignal,
      sourceCode = sourceLanguageRef.current,
      targetCode = targetLanguageRef.current,
    ) => {
      const cleaned = source.replace(/\s+/g, " ").trim();
      if (!cleaned) return "";
      if (sourceCode === targetCode) return cleaned;

      return withTranslationTimeout(async (operationSignal) => {
      const protectedSource = protectExactText(cleaned);

      const translateRaw = async (input: string) => {
        if (operationSignal.aborted) throw new DOMException("Aborted", "AbortError");

        const localTranslator = await ensureTranslator(sourceCode, targetCode);
        if (localTranslator) {
          try {
            return await localTranslator.translate(input, { signal: operationSignal });
          } catch (translationError) {
            if (operationSignal.aborted) throw translationError;
            translatorRef.current?.destroy?.();
            translatorRef.current = null;
            translatorPromiseRef.current = null;
          }
        }

        const response = await fetch("/api/translate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: input,
            source: sourceCode,
            target: targetCode,
          }),
          signal: operationSignal,
        });

        if (!response.ok) throw new Error("translation_failed");
        const payload = (await response.json()) as { translation?: string };
        if (!payload.translation) throw new Error("translation_failed");
        return payload.translation;
      };

      const maskedTranslation = await translateRaw(protectedSource.protectedText);
      const restored = protectedSource.restore(maskedTranslation);
      if (restored !== null) return restored;

      const safeParts: string[] = [];
      for (const fragment of protectedSource.fragments) {
        if (fragment.exact || !fragment.text.trim()) {
          safeParts.push(fragment.text);
        } else {
          safeParts.push(await translateRaw(fragment.text));
        }
      }

      return safeParts.join("").replace(/\s+([，。！？；：、])/g, "$1").trim();
      }, signal);
    },
    [ensureTranslator],
  );

  const speak = useCallback((text: string, speechLanguage?: string) => {
    if (!voiceEnabledRef.current || !("speechSynthesis" in window)) return;

    const utterance = new SpeechSynthesisUtterance(
      text === UNCLEAR ? "未听清" : text,
    );
    const voiceLanguage = speechLanguage ?? languageByCode(targetLanguageRef.current).speech;
    const voicePrefix = voiceLanguage.split("-")[0];
    utterance.lang = voiceLanguage;
    utterance.rate = 1.08;
    utterance.pitch = 1;
    utterance.voice =
      voicesRef.current.find(
        (voice) => voice.lang.toLowerCase() === voiceLanguage.toLowerCase(),
      ) ??
      voicesRef.current.find((voice) =>
        voice.lang.toLowerCase().startsWith(`${voicePrefix.toLowerCase()}-`),
      ) ??
      null;
    const release = () => utterancesRef.current.delete(utterance);
    utterance.onend = release;
    utterance.onerror = release;
    utterancesRef.current.add(utterance);
    window.speechSynthesis.speak(utterance);
  }, []);

  const setStableInterimCaption = useCallback((text: string) => {
    interimCaptionRef.current = text;
    setInterimCaption(text);
  }, []);

  const addCaption = useCallback(
    (
      source: string,
      text: string,
      pending = false,
      sourceCode = sourceLanguageRef.current,
      targetCode = targetLanguageRef.current,
    ) => {
      const id = ++captionIdRef.current;
      setHistoryCopied(false);
      setCaptions((current) =>
        [
          ...current,
          {
            id,
            source,
            text,
            pending,
            createdAt: Date.now(),
            sourceLanguage: sourceCode,
            targetLanguage: targetCode,
          },
        ].slice(-MAX_HISTORY),
      );
      return id;
    },
    [],
  );

  const updateCaption = useCallback((id: number, text: string) => {
    setHistoryCopied(false);
    setCaptions((current) =>
      current.map((caption) =>
        caption.id === id ? { ...caption, text, pending: false } : caption,
      ),
    );
  }, []);

  const commitFinal = useCallback(
    (source: string, confidence: number) => {
      const sourceCode = sourceLanguageRef.current;
      const targetCode = targetLanguageRef.current;
      const targetSpeech = languageByCode(targetCode).speech;
      const stablePreview = interimCaptionRef.current.trim();
      setInterimSource("");
      setStableInterimCaption("");
      partialSequenceRef.current += 1;
      partialAbortRef.current?.abort();

      if (isUnclearSpeechResult(source, confidence)) {
        addCaption(UNCLEAR, UNCLEAR, false, sourceCode, targetCode);
        speak(UNCLEAR, targetSpeech);
        return;
      }

      const cleanSource = source.replace(/\s+/g, " ").trim();
      const id = addCaption(
        cleanSource,
        stablePreview || "正在翻译…",
        true,
        sourceCode,
        targetCode,
      );
      translationQueueRef.current = translationQueueRef.current.then(async () => {
        try {
          const translated = await translateText(
            source,
            undefined,
            sourceCode,
            targetCode,
          );
          if (!translated) {
            updateCaption(id, TRANSLATION_UNAVAILABLE);
            setError("翻译暂不可用，请稍后重试。");
            return;
          }
          updateCaption(id, translated);
          speak(translated, targetSpeech);
          setError("");
        } catch {
          updateCaption(id, TRANSLATION_UNAVAILABLE);
          setError("翻译暂不可用，请稍后重试。");
        }
      });
    },
    [
      addCaption,
      setStableInterimCaption,
      speak,
      translateText,
      updateCaption,
    ],
  );

  const translateInterim = useCallback(
    (source: string) => {
      const sourceCode = sourceLanguageRef.current;
      const targetCode = targetLanguageRef.current;
      if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
      const sequence = ++partialSequenceRef.current;
      if (!source.trim()) return;

      const delay = Math.max(
        0,
        PARTIAL_TRANSLATION_INTERVAL_MS -
          (Date.now() - partialLastStartedRef.current),
      );

      partialTimerRef.current = setTimeout(async () => {
        partialLastStartedRef.current = Date.now();
        partialAbortRef.current?.abort();
        const controller = new AbortController();
        partialAbortRef.current = controller;
        try {
          const translated = await translateText(
            source,
            controller.signal,
            sourceCode,
            targetCode,
          );
          if (
            sequence === partialSequenceRef.current &&
            sourceCode === sourceLanguageRef.current &&
            targetCode === targetLanguageRef.current
          ) {
            setStableInterimCaption(translated);
          }
        } catch {
          // Final-result translation will retry; avoid flashing errors for partials.
        }
      }, delay);
    },
    [setStableInterimCaption, translateText],
  );

  const createRecognition = useCallback(() => {
    const Recognition =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) return null;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = languageByCode(sourceLanguageRef.current).speech;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      recognitionActiveRef.current = true;
      committedResultsRef.current.clear();
      recognitionStalledRef.current = false;
      restartDelayRef.current = 240;
      unrecognizedAudioAtRef.current = 0;
      if (shouldListenRef.current && !isPausedRef.current) {
        setSessionState("listening");
        setError("");
      }
    };

    recognition.onresult = (event) => {
      let interim = "";
      unrecognizedAudioAtRef.current = 0;
      recognitionStalledRef.current = false;
      stallRestartCountRef.current = 0; networkFailureCountRef.current = 0;
      noSpeechCountRef.current = 0;
      setError((current) =>
        current === NO_SOUND_MESSAGE || current === NO_RESULT_MESSAGE
          ? ""
          : current,
      );

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternative = result[0];
        if (!alternative) continue;

        if (result.isFinal) {
          if (!committedResultsRef.current.has(index)) {
            committedResultsRef.current.add(index);
            commitFinal(alternative.transcript, alternative.confidence);
          }
        } else {
          interim += alternative.transcript;
        }
      }

      setInterimSource(interim.replace(/\s+/g, " ").trim());
      translateInterim(interim);
    };

    recognition.onnomatch = () => {
      if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
      partialSequenceRef.current += 1;
      partialAbortRef.current?.abort();
      setInterimSource("");
      setStableInterimCaption("");
      const now = Date.now();
      if (
        (lastAudioAtRef.current > 0 && now - lastAudioAtRef.current > 2_500) ||
        now - lastNoMatchAtRef.current < 3_000
      ) {
        return;
      }
      lastNoMatchAtRef.current = now;
      const targetSpeech = languageByCode(targetLanguageRef.current).speech;
      addCaption(
        UNCLEAR,
        UNCLEAR,
        false,
        sourceLanguageRef.current,
        targetLanguageRef.current,
      );
      speak(UNCLEAR, targetSpeech);
    };

    recognition.onerror = (event) => {
      if (event.error === "aborted") return;
      if (event.error === "no-speech") {
        noSpeechCountRef.current += 1;
        if (
          noSpeechCountRef.current >= 2 &&
          microphoneStateRef.current !== "active"
        ) {
          setMicrophoneStatus("silent");
          setError((current) => current || NO_SOUND_MESSAGE);
        }
        return;
      }
      setError(errorMessage(event.error));
      if (event.error === "network") { networkFailureCountRef.current += 1; if (networkFailureCountRef.current >= 3) { shouldListenRef.current = false; setSessionState("error"); setError(NETWORK_FAILURE_MESSAGE); releaseMicrophone(); return; }
        restartDelayRef.current = Math.min(
          Math.max(restartDelayRef.current * 2, 1000),
          4000,
        );
      }
      if (
        [
          "not-allowed",
          "service-not-allowed",
          "audio-capture",
          "language-not-supported",
        ].includes(event.error)
      ) {
        shouldListenRef.current = false;
        setSessionState("error");
        releaseMicrophone();
      }
    };

    recognition.onend = () => {
      recognitionActiveRef.current = false;
      if (shouldListenRef.current && !isPausedRef.current) {
        scheduleRecognitionStart(restartDelayRef.current);
      }
    };

    return recognition;
  }, [
    addCaption,
    commitFinal,
    releaseMicrophone,
    scheduleRecognitionStart,
    setStableInterimCaption,
    setMicrophoneStatus,
    speak,
    translateInterim,
  ]);

  const startListening = useCallback(async () => {
    setError("");
    setLinkCopied(false);
    setSessionState("starting");
    shouldListenRef.current = true; networkFailureCountRef.current = 0;
    isPausedRef.current = false;

    void ensureTranslator(sourceLanguageRef.current, targetLanguageRef.current);

    try {
      await prepareMicrophone();
    } catch (microphoneError) {
      shouldListenRef.current = false;
      setSessionState("error");
      setError(microphoneErrorMessage(microphoneError));
      releaseMicrophone();
      return;
    }

    const recognition = recognitionRef.current ?? createRecognition();
    if (!recognition) {
      shouldListenRef.current = false;
      setSessionState("error");
      setError("当前浏览器不支持实时语音识别，请使用最新版 Chrome。 ");
      releaseMicrophone();
      return;
    }

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      scheduleRecognitionStart(restartDelayRef.current);
    }
  }, [
    createRecognition,
    ensureTranslator,
    prepareMicrophone,
    releaseMicrophone,
    scheduleRecognitionStart,
  ]);

  const pauseListening = useCallback(() => {
    isPausedRef.current = true;
    setSessionState("paused");
    setInterimSource("");
    setStableInterimCaption("");
    partialSequenceRef.current += 1;
    partialAbortRef.current?.abort();
    recognitionRef.current?.stop();
    releaseMicrophone();
  }, [releaseMicrophone, setStableInterimCaption]);

  const resumeListening = useCallback(async () => {
    isPausedRef.current = false;
    setSessionState("starting");
    setError("");
    setLinkCopied(false);
    try {
      await prepareMicrophone();
    } catch (microphoneError) {
      shouldListenRef.current = false;
      setSessionState("error");
      setError(microphoneErrorMessage(microphoneError));
      releaseMicrophone();
      return;
    }
    scheduleRecognitionStart(240);
  }, [prepareMicrophone, releaseMicrophone, scheduleRecognitionStart]);

  const stopListening = useCallback(() => {
    shouldListenRef.current = false;
    isPausedRef.current = false;
    setSessionState("idle");
    setInterimSource("");
    setStableInterimCaption("");
    partialSequenceRef.current += 1;
    partialAbortRef.current?.abort();
    recognitionRef.current?.stop();
    releaseMicrophone();
    window.speechSynthesis?.cancel();
    utterancesRef.current.clear();
  }, [releaseMicrophone, setStableInterimCaption]);

  const copyPageLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
    } catch {
      setLinkCopied(false);
    }
  }, []);

  const lookupWordMeaning = useCallback(async (rawWord: string) => {
    const word = rawWord
      .replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/g, "")
      .toLowerCase();
    if (!word) return;

    setSelectedWord(word);
    setWordError("");
    wordLookupAbortRef.current?.abort();
    const targetCode = targetLanguageRef.current;
    const sourceCode = sourceLanguageRef.current;
    const cacheKey = `${sourceCode}:${targetCode}:${word}`;
    const cached = wordLookupCacheRef.current.get(cacheKey);
    if (cached) {
      setWordLookup(cached);
      setWordLoading(false);
      return;
    }

    const controller = new AbortController();
    wordLookupAbortRef.current = controller;
    setWordLookup(null);
    setWordLoading(true);

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: word,
          source: sourceCode,
          target: targetCode,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("lookup_failed");
      const payload = (await response.json()) as { translation?: string };
      const meaning = payload.translation?.trim();
      if (!meaning) throw new Error("lookup_failed");
      const result = { word, meaning, targetLanguage: targetCode };
      wordLookupCacheRef.current.set(cacheKey, result);
      setWordLookup(result);
    } catch (lookupError) {
      if (
        !(lookupError instanceof DOMException) ||
        lookupError.name !== "AbortError"
      ) {
        setWordError("暂时查不到这个单词，请稍后重试。");
      }
    } finally {
      if (wordLookupAbortRef.current === controller) {
        setWordLoading(false);
      }
    }
  }, []);

  const speakSourceWord = useCallback((word: string) => {
    if (!("speechSynthesis" in window)) return;
    const speechLanguage = languageByCode(sourceLanguageRef.current).speech;
    const speechPrefix = speechLanguage.split("-")[0];
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = speechLanguage;
    utterance.rate = 0.86;
    utterance.voice =
      voicesRef.current.find(
        (voice) => voice.lang.toLowerCase() === speechLanguage.toLowerCase(),
      ) ??
      voicesRef.current.find((voice) =>
        voice.lang.toLowerCase().startsWith(`${speechPrefix.toLowerCase()}-`),
      ) ??
      null;
    window.speechSynthesis.speak(utterance);
  }, []);

  const copyTranscript = useCallback(async () => {
    const fullText = captions
      .map((caption) => {
        const sourceLabel = languageByCode(caption.sourceLanguage).short;
        const targetLabel = languageByCode(caption.targetLanguage).short;
        return `${sourceLabel}  ${caption.source}\n${targetLabel}  ${caption.text}`;
      })
      .join("\n\n");
    if (!fullText) return;
    try {
      await navigator.clipboard.writeText(fullText);
      setHistoryCopied(true);
    } catch {
      setHistoryCopied(false);
    }
  }, [captions]);

  const copyCaption = useCallback(async (caption: Caption) => {
    const sourceLabel = languageByCode(caption.sourceLanguage).short;
    const targetLabel = languageByCode(caption.targetLanguage).short;
    try {
      await navigator.clipboard.writeText(
        `${sourceLabel}  ${caption.source}\n${targetLabel}  ${caption.text}`,
      );
      setCopiedCaptionId(caption.id);
      window.setTimeout(() => setCopiedCaptionId(null), 1_500);
    } catch {
      setCopiedCaptionId(null);
    }
  }, []);

  const resetPartialTranslation = useCallback(() => {
    setInterimSource("");
    setStableInterimCaption("");
    partialSequenceRef.current += 1;
    partialAbortRef.current?.abort();
    translatorRef.current?.destroy?.();
    translatorRef.current = null;
    translatorPromiseRef.current = null;
    translatorPairRef.current = "";
  }, [setStableInterimCaption]);

  const changeSourceLanguage = useCallback(
    (nextCode: string) => {
      if (nextCode === targetLanguageRef.current) return;
      sourceLanguageRef.current = nextCode;
      setSourceLanguage(nextCode);
      resetPartialTranslation();
      if (recognitionRef.current) {
        recognitionRef.current.lang = languageByCode(nextCode).speech;
        if (shouldListenRef.current && !isPausedRef.current) {
          recognitionRef.current.stop();
        }
      }
    },
    [resetPartialTranslation],
  );

  const changeTargetLanguage = useCallback(
    (nextCode: string) => {
      if (nextCode === sourceLanguageRef.current) return;
      targetLanguageRef.current = nextCode;
      setTargetLanguage(nextCode);
      resetPartialTranslation();
      setSelectedWord("");
    },
    [resetPartialTranslation],
  );

  const swapLanguages = useCallback(() => {
    const nextSource = targetLanguageRef.current;
    const nextTarget = sourceLanguageRef.current;
    sourceLanguageRef.current = nextSource;
    targetLanguageRef.current = nextTarget;
    setSourceLanguage(nextSource);
    setTargetLanguage(nextTarget);
    resetPartialTranslation();
    setSelectedWord("");
    if (recognitionRef.current) {
      recognitionRef.current.lang = languageByCode(nextSource).speech;
      if (shouldListenRef.current && !isPausedRef.current) {
        recognitionRef.current.stop();
      }
    }
  }, [resetPartialTranslation]);

  const translateManualText = useCallback(async () => {
    const cleanText = manualText.replace(/\s+/g, " ").trim();
    if (!cleanText || manualBusy) return;
    const sourceCode = sourceLanguageRef.current;
    const targetCode = targetLanguageRef.current;
    const captionId = addCaption(
      cleanText,
      "正在翻译…",
      true,
      sourceCode,
      targetCode,
    );
    setManualBusy(true);
    try {
      const translated = await translateText(
        cleanText,
        undefined,
        sourceCode,
        targetCode,
      );
      updateCaption(captionId, translated || TRANSLATION_UNAVAILABLE);
      if (translated) speak(translated, languageByCode(targetCode).speech);
      setManualText("");
      setManualOpen(false);
      setError("");
    } catch {
      updateCaption(captionId, TRANSLATION_UNAVAILABLE);
      setError("翻译暂不可用，请稍后重试。");
    } finally {
      setManualBusy(false);
    }
  }, [addCaption, manualBusy, manualText, speak, translateText, updateCaption]);

  const handleCaptionScroll = useCallback(() => {
    const viewport = captionsViewportRef.current;
    if (!viewport) return;
    const nextFollow =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 64;
    followLatestRef.current = nextFollow;
    setFollowLatest(nextFollow);
  }, []);

  const scrollToLatest = useCallback(() => {
    const viewport = captionsViewportRef.current;
    if (!viewport) return;
    followLatestRef.current = true;
    setFollowLatest(true);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
  }, []);

  const scrollCaptions = useCallback((direction: -1 | 1) => {
    const viewport = captionsViewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      top: direction * Math.max(160, viewport.clientHeight * 0.75),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    if (direction < 0) {
      followLatestRef.current = false;
      setFollowLatest(false);
    }
  }, []);

  const closeGuide = useCallback(() => {
    setGuideOpen(false);
    try {
      window.localStorage.setItem(GUIDE_STORAGE_KEY, "seen");
    } catch {
      // Closing the guide should never block the interpreter.
    }
  }, []);

  const toggleVoice = useCallback(() => {
    setVoiceEnabled((current) => {
      const next = !current;
      voiceEnabledRef.current = next;
      if (!next) {
        window.speechSynthesis?.cancel();
        utterancesRef.current.clear();
      }
      return next;
    });
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      setError("当前环境无法进入全屏。 ");
    }
  }, []);

  useEffect(() => {
    const handleFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () => document.removeEventListener("fullscreenchange", handleFullscreen);
  }, []);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const rawHistory = window.localStorage.getItem(HISTORY_STORAGE_KEY);
        const parsed = rawHistory ? (JSON.parse(rawHistory) as unknown) : [];
        if (Array.isArray(parsed)) {
          const restored = parsed
            .filter(
              (item): item is Partial<Caption> =>
                typeof item === "object" &&
                item !== null &&
                typeof (item as Partial<Caption>).source === "string" &&
                typeof (item as Partial<Caption>).text === "string",
            )
            .slice(-MAX_HISTORY)
            .map((item, index) => ({
              id:
                typeof item.id === "number" && Number.isFinite(item.id)
                  ? item.id
                  : index + 1,
              source: item.source ?? "",
              text: item.text ?? "",
              createdAt:
                typeof item.createdAt === "number" &&
                Number.isFinite(item.createdAt)
                  ? item.createdAt
                  : Date.now() + index,
              sourceLanguage:
                typeof item.sourceLanguage === "string"
                  ? item.sourceLanguage
                  : "en",
              targetLanguage:
                typeof item.targetLanguage === "string"
                  ? item.targetLanguage
                  : "zh-CN",
              pending: false,
            }));
          captionIdRef.current = restored.reduce(
            (highest, caption) => Math.max(highest, caption.id),
            0,
          );
          setCaptions(restored);
        }
      } catch {
        // Keep the current session usable if saved history is malformed.
      } finally {
        setHistoryReady(true);
      }
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, []);

  useEffect(() => {
    if (!historyReady) return;
    try {
      window.localStorage.setItem(
        HISTORY_STORAGE_KEY,
        JSON.stringify(captions.slice(-MAX_HISTORY)),
      );
    } catch {
      // Full in-memory history remains available when storage is unavailable.
    }
  }, [captions, historyReady]);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const rawLanguages = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
        const stored = rawLanguages
          ? (JSON.parse(rawLanguages) as { source?: unknown; target?: unknown })
          : null;
        const storedSource =
          typeof stored?.source === "string" &&
          LANGUAGES.some((language) => language.code === stored.source)
            ? stored.source
            : "en";
        const storedTarget =
          typeof stored?.target === "string" &&
          LANGUAGES.some((language) => language.code === stored.target) &&
          stored.target !== storedSource
            ? stored.target
            : "zh-CN";
        sourceLanguageRef.current = storedSource;
        targetLanguageRef.current = storedTarget;
        setSourceLanguage(storedSource);
        setTargetLanguage(storedTarget);
        if (!window.localStorage.getItem(GUIDE_STORAGE_KEY)) {
          setGuideOpen(true);
        }
      } catch {
        // Defaults keep the app ready when preferences are unavailable.
      } finally {
        setLanguageReady(true);
      }
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, []);

  useEffect(() => {
    if (!languageReady) return;
    try {
      window.localStorage.setItem(
        LANGUAGE_STORAGE_KEY,
        JSON.stringify({ source: sourceLanguage, target: targetLanguage }),
      );
    } catch {
      // Language choices still work for the current session.
    }
  }, [languageReady, sourceLanguage, targetLanguage]);

  useEffect(() => {
    if (!followLatestRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = captionsViewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [captions, interimCaption, interimSource]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const refreshVoices = () => {
      voicesRef.current = window.speechSynthesis.getVoices();
    };
    refreshVoices();
    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", refreshVoices);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") {
        setSelectedWord("");
        setHistoryOpen(false);
        setManualOpen(false);
        closeGuide();
        return;
      }
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLButtonElement
      ) {
        return;
      }
      if (event.key.toLowerCase() === "v") toggleVoice();
      if (event.key.toLowerCase() === "f") void toggleFullscreen();
      if (event.key.toLowerCase() === "s" && shouldListenRef.current) stopListening();
      if (event.code === "Space") {
        event.preventDefault();
        if (sessionState === "listening") pauseListening();
        else if (sessionState === "paused") void resumeListening();
        else if (sessionState === "idle" || sessionState === "error") void startListening();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeGuide, pauseListening, resumeListening, sessionState, startListening, stopListening, toggleFullscreen, toggleVoice]);

  useEffect(() => {
    const utterances = utterancesRef.current;
    return () => {
      shouldListenRef.current = false;
      recognitionRef.current?.abort();
      translatorRef.current?.destroy?.();
      if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
      partialAbortRef.current?.abort();
      wordLookupAbortRef.current?.abort();
      releaseMicrophone(false);
      window.speechSynthesis?.cancel();
      utterances.clear();
    };
  }, [releaseMicrophone]);

  const hasCaptions =
    captions.length > 0 || Boolean(interimSource) || Boolean(interimCaption);
  const visibleCaptions = captions.slice(-100);
  const sourceOption = languageByCode(sourceLanguage);
  const targetOption = languageByCode(targetLanguage);
  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase();
  const filteredHistory = (
    normalizedHistoryQuery
      ? captions.filter((caption) =>
          `${caption.source}\n${caption.text}`
            .toLocaleLowerCase()
            .includes(normalizedHistoryQuery),
        )
      : captions
  )
    .slice()
    .reverse();
  const active = sessionState === "listening" || sessionState === "starting" || sessionState === "paused";
  const microphoneLabel = {
    idle: "",
    checking: "检测麦克风",
    silent: "未检测到声音",
    active: "麦克风有声音",
  }[microphoneState];
  const emptyHint =
    sessionState === "idle"
      ? `点击开始同传 · ${sourceOption.label}与${targetOption.label}同步显示`
      : sessionState === "starting"
        ? microphoneState === "checking"
          ? "正在检测麦克风…"
          : "正在连接语音识别…"
        : sessionState === "paused"
          ? "同传已暂停"
          : microphoneState === "silent"
            ? "未检测到声音，请检查麦克风"
            : microphoneState === "active"
              ? `已检测到声音，正在识别${sourceOption.label}…`
              : "正在聆听…";

  return (
    <main
      className={`interpreter ${isFullscreen ? "is-fullscreen" : ""} ${historyOpen ? "history-is-open" : ""}`}
    >
      <header className="topbar">
        <div className="brand" aria-label="LinguaLive">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>LinguaLive</span>
        </div>

        <div className="top-actions">
          
          <button
            className={`utility-button history-toggle ${historyOpen ? "is-on" : ""}`}
            type="button"
            onClick={() => setHistoryOpen((current) => !current)}
            aria-expanded={historyOpen}
            aria-controls="translation-history"
          >
            <span aria-hidden="true">≡</span>
            记录
            <span className="history-badge">{captions.length}</span>
          </button>
          <button
            className={`utility-button ${voiceEnabled ? "is-on" : ""}`}
            type="button"
            onClick={toggleVoice}
            aria-pressed={voiceEnabled}
            aria-label={voiceEnabled ? "关闭翻译语音播报" : "开启翻译语音播报"}
          >
            <span className="speaker-icon" aria-hidden="true">◖</span>
            播报 {voiceEnabled ? "开" : "关"}
            <span className="key-hint">V</span>
          </button>
          <button
            className="utility-button icon-button"
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen ? "退出全屏" : "进入全屏"}
          >
            <span aria-hidden="true">{isFullscreen ? "↙" : "↗"}</span>
            <span className="fullscreen-label">{isFullscreen ? "退出" : "全屏"}</span>
            <span className="key-hint">F</span>
          </button>
        </div>
      </header>

      <section className="stage" aria-label="实时多语言双语字幕">
        <div className="stage-head">
          <div className="language-toolbar" aria-label="翻译语言设置">
            <label className="language-select">
              <span>输入语言</span>
              <select
                value={sourceLanguage}
                onChange={(event) => changeSourceLanguage(event.target.value)}
                aria-label="选择输入语言"
              >
                {LANGUAGES.map((language) => (
                  <option
                    key={language.code}
                    value={language.code}
                    disabled={language.code === targetLanguage}
                  >
                    {language.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="swap-language-button"
              type="button"
              onClick={swapLanguages}
              aria-label="交换输入和翻译语言"
              title="交换语言"
            >
              ⇄
            </button>
            <label className="language-select">
              <span>翻译为</span>
              <select
                value={targetLanguage}
                onChange={(event) => changeTargetLanguage(event.target.value)}
                aria-label="选择翻译语言"
              >
                {LANGUAGES.map((language) => (
                  <option
                    key={language.code}
                    value={language.code}
                    disabled={language.code === sourceLanguage}
                  >
                    {language.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="toolbar-actions">
              <button type="button" onClick={() => setManualOpen(true)}>
                ✎ 手动输入
              </button>
              <button
                type="button"
                onClick={() => {
                  setGuideStep(0);
                  setGuideOpen(true);
                }}
              >
                ? 导览
              </button>
            </div>
          </div>

          <div className="stage-meta">
            <div className={`status status-${sessionState}`} role="status" aria-live="polite">
              <span className="status-dot" aria-hidden="true" />
              {statusLabel}
            </div>
            {(sessionState === "listening" || sessionState === "starting") &&
              microphoneState !== "idle" && (
              <div
                className={`microphone-signal signal-${microphoneState}`}
                aria-label={microphoneLabel}
              >
                <div className="listening-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <span>{microphoneLabel}</span>
              </div>
            )}
          </div>
        </div>

        <div className="captions-shell">
          <div className="caption-navigation" aria-label="字幕滚动导航">
            <span><span aria-hidden="true">↕</span> 上下滑动浏览字幕</span>
            <div>
              <button type="button" onClick={() => scrollCaptions(-1)} disabled={!hasCaptions} aria-label="向上浏览字幕">↑ 上一屏</button>
              <button type="button" onClick={() => scrollCaptions(1)} disabled={!hasCaptions} aria-label="向下浏览字幕">↓ 下一屏</button>
              <button type="button" onClick={scrollToLatest} disabled={!hasCaptions} aria-pressed={followLatest}>跟随最新</button>
            </div>
          </div>
          <div
            className="captions"
            ref={captionsViewportRef}
            onScroll={handleCaptionScroll}
            aria-live="polite"
            aria-atomic="false"
          >
          {!hasCaptions && (
            <div className="empty-state">
              <p>等待下一段语音</p>
              <span>{emptyHint}</span>
            </div>
          )}

          {visibleCaptions.map((caption) => {
            const captionSource = languageByCode(caption.sourceLanguage);
            const captionTarget = languageByCode(caption.targetLanguage);
            return (
              <div
                className="caption-pair"
                key={caption.id}
                role="group"
                aria-label="已确认双语字幕"
              >
                <p className="english-line">
                  <span className="language-tag" aria-hidden="true">{captionSource.short}</span>
                  <EnglishWords
                    text={caption.source}
                    onSelect={(word) => void lookupWordMeaning(word)}
                  />
                </p>
                <p className={`caption-line ${caption.pending ? "is-pending" : ""}`}>
                  <span className="language-tag" aria-hidden="true">{captionTarget.short}</span>
                  <span lang={captionTarget.speech}>{caption.text}</span>
                </p>
                <button
                  className="caption-copy"
                  type="button"
                  onClick={() => void copyCaption(caption)}
                  aria-label="复制这段双语字幕"
                >
                  {copiedCaptionId === caption.id ? "已复制" : "复制"}
                </button>
              </div>
            );
          })}

          {interimSource && (
            <div className="caption-pair live-caption" aria-label="正在识别的双语字幕">
              <p className="english-line">
                <span className="language-tag" aria-hidden="true">{sourceOption.short}</span>
                <EnglishWords
                  text={interimSource}
                  onSelect={(word) => void lookupWordMeaning(word)}
                />
              </p>
              <p className="caption-line">
                <span className="language-tag" aria-hidden="true">{targetOption.short}</span>
                <span lang={targetOption.speech}>{interimCaption || "正在翻译…"}</span>
              </p>
            </div>
          )}
          </div>

          {!followLatest && hasCaptions && (
            <button
              className="follow-latest"
              type="button"
              onClick={scrollToLatest}
            >
              ↓ 跟随最新
            </button>
          )}
        </div>

        {error && (
          <div className="inline-error" role="alert">
            <span aria-hidden="true">!</span>
            <p>{error.trim()}</p>
            <button
              type="button"
              onClick={() => {
                if (error === NO_RESULT_MESSAGE) void copyPageLink();
                else if (active) setError("");
                else void startListening();
              }}
            >
              {error === NO_RESULT_MESSAGE
                ? linkCopied
                  ? "已复制"
                  : "复制链接"
                : active
                  ? "关闭"
                  : "重试"}
            </button>
          </div>
        )}
      </section>

      <footer className="control-dock">
        <div className="session-note">
          <span>{translatorReady ? "翻译就绪" : "正在准备翻译"}</span>
          <span className="note-separator">·</span>
          <span>{sourceOption.label} → {targetOption.label}</span>
        </div>

        <div className="main-controls">
          {sessionState === "listening" ? (
            <button className="primary-button pause-button" type="button" onClick={pauseListening}>
              <span className="pause-symbol" aria-hidden="true"><i /><i /></span>
              暂停
              <span className="key-hint light">Space</span>
            </button>
          ) : sessionState === "paused" ? (
            <button className="primary-button" type="button" onClick={() => void resumeListening()}>
              <span className="play-symbol" aria-hidden="true" />
              继续
              <span className="key-hint light">Space</span>
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={() => void startListening()}
              disabled={sessionState === "starting"}
            >
              <span className={`mic-symbol ${sessionState === "starting" ? "connecting" : ""}`} aria-hidden="true" />
              {sessionState === "starting" ? "正在连接" : captions.length ? "重新开始" : "开始同传"}
              <span className="key-hint light">Space</span>
            </button>
          )}

          {active && (
            <button className="stop-button" type="button" onClick={stopListening}>
              <span aria-hidden="true" />
              停止
              <span className="key-hint">S</span>
            </button>
          )}
        </div>
      </footer>

      {historyOpen && (
        <>
          <button
            className="panel-backdrop"
            type="button"
            aria-label="关闭翻译记录"
            onClick={() => setHistoryOpen(false)}
          />
          <aside
            className="history-panel"
            id="translation-history"
            role="dialog"
            aria-modal="true"
            aria-label="完整翻译记录"
          >
            <div className="history-header">
              <div>
                <span className="panel-eyebrow">课堂全文</span>
                <h2>翻译记录</h2>
              </div>
              <button
                className="panel-close"
                type="button"
                onClick={() => setHistoryOpen(false)}
                aria-label="关闭翻译记录"
              >
                ×
              </button>
            </div>

            <div className="history-tools">
              <label className="history-search">
                <span aria-hidden="true">⌕</span>
                <input
                  type="search"
                  value={historyQuery}
                  onChange={(event) => setHistoryQuery(event.target.value)}
                  placeholder="搜索原文或译文"
                  aria-label="搜索翻译记录"
                />
              </label>
              <button
                className="copy-transcript"
                type="button"
                onClick={() => void copyTranscript()}
                disabled={!captions.length}
              >
                {historyCopied ? "已复制" : "复制全文"}
              </button>
            </div>

            <div className="history-summary">
              <span>{captions.length} 段记录</span>
              <span>点击带下划线的词查释义</span>
            </div>

            <div className="history-list">
              {filteredHistory.length ? (
                filteredHistory.map((caption) => {
                  const captionSource = languageByCode(caption.sourceLanguage);
                  const captionTarget = languageByCode(caption.targetLanguage);
                  return (
                  <article className="history-item" key={caption.id}>
                    <button
                      className="history-item-copy"
                      type="button"
                      onClick={() => void copyCaption(caption)}
                    >
                      {copiedCaptionId === caption.id ? "已复制" : "复制"}
                    </button>
                    <time dateTime={new Date(caption.createdAt).toISOString()}>
                      {new Date(caption.createdAt).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    <p className="history-english">
                      <span className="language-tag" aria-hidden="true">{captionSource.short}</span>
                      <EnglishWords
                        text={caption.source}
                        onSelect={(word) => void lookupWordMeaning(word)}
                      />
                    </p>
                    <p className="history-chinese" lang={captionTarget.speech}>
                      <span className="language-tag" aria-hidden="true">{captionTarget.short}</span>
                      <span>{caption.text}</span>
                    </p>
                  </article>
                  );
                })
              ) : (
                <div className="history-empty">
                  {captions.length ? "没有匹配的记录" : "翻译开始后，全文会保存在这里"}
                </div>
              )}
            </div>
          </aside>
        </>
      )}

      {manualOpen && (
        <>
          <button
            className="panel-backdrop modal-backdrop"
            type="button"
            aria-label="关闭手动翻译"
            onClick={() => setManualOpen(false)}
          />
          <section
            className="center-modal manual-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-title"
          >
            <div className="modal-header">
              <div>
                <span className="panel-eyebrow">补充翻译</span>
                <h2 id="manual-title">手动输入</h2>
              </div>
              <button
                className="panel-close"
                type="button"
                onClick={() => setManualOpen(false)}
                aria-label="关闭手动翻译"
              >
                ×
              </button>
            </div>
            <p className="modal-route">
              {sourceOption.label} <span>→</span> {targetOption.label}
            </p>
            <textarea
              value={manualText}
              onChange={(event) => setManualText(event.target.value.slice(0, 1800))}
              placeholder={`输入要翻译的${sourceOption.label}内容`}
              aria-label="输入待翻译内容"
            />
            <div className="manual-footer">
              <span>{manualText.length} / 1800</span>
              <button
                type="button"
                onClick={() => void translateManualText()}
                disabled={!manualText.trim() || manualBusy}
              >
                {manualBusy ? "正在翻译…" : "翻译并加入记录"}
              </button>
            </div>
          </section>
        </>
      )}

      {guideOpen && (
        <>
          <button
            className="panel-backdrop modal-backdrop"
            type="button"
            aria-label="关闭使用导览"
            onClick={closeGuide}
          />
          <section
            className="center-modal guide-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-title"
          >
            <div className="modal-header">
              <div>
                <span className="panel-eyebrow">快速上手 · {guideStep + 1}/3</span>
                <h2 id="guide-title">
                  {guideStep === 0
                    ? "先选择语言"
                    : guideStep === 1
                      ? "开始实时翻译"
                      : "浏览与查询"}
                </h2>
              </div>
              <button
                className="panel-close"
                type="button"
                onClick={closeGuide}
                aria-label="关闭使用导览"
              >
                ×
              </button>
            </div>
            <div className="guide-visual" aria-hidden="true">
              {guideStep === 0 ? "英语  ⇄  简体中文" : guideStep === 1 ? "●  正在聆听" : "↕  字幕记录  ⌕"}
            </div>
            <p>
              {guideStep === 0
                ? "在字幕上方选择老师使用的语言和你要看到的译文语言，可随时交换。"
                : guideStep === 1
                  ? "点击“开始同传”并允许麦克风。也可以用“手动输入”翻译文字。"
                  : "字幕区可上下滑动；点“跟随最新”回到底部。记录支持搜索、复制，带下划线的词可查释义。"}
            </p>
            <div className="guide-footer">
              <div className="guide-dots" aria-hidden="true">
                {[0, 1, 2].map((step) => (
                  <span key={step} className={step === guideStep ? "is-active" : ""} />
                ))}
              </div>
              <div>
                {guideStep > 0 && (
                  <button type="button" onClick={() => setGuideStep((step) => step - 1)}>
                    上一步
                  </button>
                )}
                <button
                  className="guide-next"
                  type="button"
                  onClick={() => {
                    if (guideStep < 2) setGuideStep((step) => step + 1);
                    else closeGuide();
                  }}
                >
                  {guideStep < 2 ? "下一步" : "开始使用"}
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {selectedWord && (
        <section
          className="word-card"
          role="dialog"
          aria-label={`${selectedWord} 的${targetOption.label}释义`}
        >
          <div className="word-card-header">
            <span>单词释义</span>
            <button
              type="button"
              onClick={() => setSelectedWord("")}
              aria-label="关闭单词释义"
            >
              ×
            </button>
          </div>
          <div className="word-heading">
            <strong lang={sourceOption.speech}>{selectedWord}</strong>
            <button
              type="button"
              onClick={() => speakSourceWord(selectedWord)}
              aria-label={`播放 ${selectedWord} 的发音`}
            >
              ◖ 发音
            </button>
          </div>
          <div className="word-meaning" aria-live="polite">
            {wordLoading ? (
              <span>查询中…</span>
            ) : wordLookup ? (
              <p lang={languageByCode(wordLookup.targetLanguage).speech}>
                {wordLookup.meaning}
              </p>
            ) : (
              <span>{wordError || "查询中…"}</span>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
