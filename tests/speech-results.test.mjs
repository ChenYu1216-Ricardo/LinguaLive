import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnclearSpeechResult } from "../app/speech-results.ts";

test("keeps recognized speech when the browser has no confidence score", () => {
  assert.equal(isUnclearSpeechResult("Hello world", 0), false);
  assert.equal(isUnclearSpeechResult("Hello world", Number.NaN), false);
});

test("marks empty or genuinely low-confidence results as unclear", () => {
  assert.equal(isUnclearSpeechResult("   ", 0.9), true);
  assert.equal(isUnclearSpeechResult("maybe", 0.2), true);
  assert.equal(isUnclearSpeechResult("clear", 0.9), false);
});
