const LOW_CONFIDENCE = 0.58;

export function isUnclearSpeechResult(source: string, confidence: number) {
  if (!source.trim()) return true;
  // Some browsers report zero when a confidence score is unavailable.
  return (
    Number.isFinite(confidence) &&
    confidence > 0 &&
    confidence < LOW_CONFIDENCE
  );
}
