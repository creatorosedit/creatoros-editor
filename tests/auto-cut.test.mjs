import assert from "node:assert/strict";
import {afterEach, test} from "node:test";
import {
  buildAudioChunkFilterGraph,
  createSilenceReviewCandidates,
  detectSilencesFromRms,
  getAudioChunkParts,
  getSourcePosition,
  mapRangeAfterCuts,
  normalizeCutRanges,
  parseSilenceDetectionLog,
  registerAbortCleanup,
  reflowTimelineClips,
  resolveWordIndexRange,
  splitTimelineClips,
  throwIfAborted,
} from "../src/lib/video/auto-cut.ts";
import {generateGeminiJson, parseGeminiJson} from "../src/lib/ai/gemini.ts";
import {FreeQuotaExhaustedError} from "../src/lib/ai/provider-policy.ts";
import {
  appendWhisperChunkWords,
  describeWhisperResponseShape,
  mapWhisperWordsToTimeline,
  parseWhisperResponse,
} from "../src/lib/ai/whisper-transcript.ts";

const originalApiKey = globalThis.process.env.GEMINI_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalApiKey === undefined) delete globalThis.process.env.GEMINI_API_KEY;
  else globalThis.process.env.GEMINI_API_KEY = originalApiKey;
  globalThis.fetch = originalFetch;
});

test("language transcript ranges use only the selected Whisper timestamps", () => {
  const examples = [
    {text: ["आज", "मुझे", "मतलब", "आज", "काम", "करना", "है"], range: [2, 2]},
    {text: ["main", "kal", "I", "mean", "parso", "aaunga"], range: [2, 3]},
    {text: ["I", "wanted", "to", "to", "say", "hello"], range: [2, 3]},
  ];

  for (const example of examples) {
    const words = example.text.map((word, index) => ({
      word,
      start: index * 0.5,
      end: index * 0.5 + 0.3,
    }));
    const resolved = resolveWordIndexRange(words, example.range[0], example.range[1], 10);
    assert.deepEqual(resolved, {
      start: example.range[0] * 0.5,
      end: example.range[1] * 0.5 + 0.3,
    });
  }
});

test("Whisper parser preserves word-level timestamps for English, Hindi, and Hinglish", () => {
  const examples = [
    {text: "I wanted to say hello.", words: ["I", " wanted", " to", " say", " hello."]},
    {text: "आज मुझे काम करना है।", words: ["आज", " मुझे", " काम", " करना", " है।"]},
    {text: "main kal I mean parso aaunga", words: ["main", " kal", " I", " mean", " parso", " aaunga"]},
  ];

  for (const example of examples) {
    const response = {
      task: "transcribe",
      language: "english",
      duration: example.words.length,
      text: example.text,
      segments: [{start: 0, end: example.words.length, text: example.text}],
      words: example.words.map((word, index) => ({
        word,
        start: index,
        end: index + 0.8,
      })),
    };
    const parsed = parseWhisperResponse(response);
    assert.equal(parsed.transcriptText, example.text);
    assert.deepEqual(parsed.transcriptWords, response.words);
  }
});

test("Whisper parser rejects empty words, segment-only responses, and missing timestamps", () => {
  const base = {text: "hello", duration: 1, segments: [{start: 0, end: 1, text: "hello"}]};
  assert.throws(() => parseWhisperResponse({...base, words: []}), /segment-level timestamps/);
  assert.throws(() => parseWhisperResponse(base), /segment-level timestamps/);
  assert.throws(() => parseWhisperResponse({
    ...base,
    words: [{word: "hello", end: 0.8}],
  }), /invalid word timestamp/);
  assert.throws(() => parseWhisperResponse({
    ...base,
    words: [{word: "hello", start: 0, end: 0.8}],
    duration: undefined,
  }), /valid audio duration/);
  assert.throws(() => parseWhisperResponse({
    ...base,
    text: "   ",
    words: [{word: "hello", start: 0, end: 0.8}],
  }), /empty transcript/);
});

test("Whisper parser rejects non-finite, negative, reversed, and out-of-duration timestamps", () => {
  const response = {text: "hello", duration: 1};
  for (const word of [
    {word: "hello", start: Number.NaN, end: 0.8},
    {word: "hello", start: -0.1, end: 0.8},
    {word: "hello", start: 0.8, end: 0.7},
    {word: "hello", start: 0.2, end: 1.1},
    {word: "hello", start: 0, end: Number.POSITIVE_INFINITY},
  ]) {
    assert.throws(() => parseWhisperResponse({...response, words: [word]}), /invalid word timestamp/);
  }
});

test("Whisper diagnostics expose response keys and types without transcript or word text", () => {
  const summary = describeWhisperResponseShape({
    text: "private transcript",
    duration: 2,
    words: [{word: "private word", start: 0, end: 1}],
  });
  assert.match(summary, /text:string/);
  assert.match(summary, /duration:number/);
  assert.match(summary, /words:array\(1\)/);
  assert.match(summary, /firstWord=\{word:string,start:number,end:number\}/);
  assert.doesNotMatch(summary, /private/);
});

test("Whisper chunk timestamps map to timeline offsets and boundary overlaps are handled", () => {
  const firstChunk = mapWhisperWordsToTimeline([
    {word: "hello", start: 59.7, end: 60},
  ], 0, 60);
  const secondChunk = mapWhisperWordsToTimeline([
    {word: "hello", start: 0, end: 0.3},
    {word: "world", start: 0.35, end: 0.8},
  ], 60, 60);
  assert.deepEqual(firstChunk, [{word: "hello", start: 59.7, end: 60}]);
  assert.deepEqual(secondChunk, [
    {word: "hello", start: 60, end: 60.3},
    {word: "world", start: 60.35, end: 60.8},
  ]);
  assert.deepEqual(
    appendWhisperChunkWords(firstChunk, secondChunk, 60),
    [...firstChunk, ...secondChunk],
  );

  const overlappingDuplicate = appendWhisperChunkWords(
    [{word: "hello", start: 59.8, end: 60.2}],
    [{word: "HELLO", start: 59.8, end: 60.2}],
    60,
  );
  assert.deepEqual(overlappingDuplicate, [{word: "hello", start: 59.8, end: 60.2}]);
  assert.throws(() => appendWhisperChunkWords(
    [{word: "hello", start: 59.8, end: 60.2}],
    [{word: "world", start: 60.1, end: 60.4}],
    60,
  ), /overlapping word timestamps/);
  assert.throws(() => mapWhisperWordsToTimeline([
    {word: "late", start: 0.9, end: 1.1},
  ], 0, 1), /outside the extracted audio chunk/);
});

test("invalid or out-of-duration word indexes cannot create timestamp ranges", () => {
  const words = [{start: 2, end: 2.5}, {start: 3, end: 3.4}];
  assert.equal(resolveWordIndexRange(words, -1, 0, 5), null);
  assert.equal(resolveWordIndexRange(words, 0, 2, 5), null);
  assert.equal(resolveWordIndexRange(words, 1, 0, 5), null);
  assert.equal(resolveWordIndexRange(words, 0, 1, 3.2), null);
  assert.equal(resolveWordIndexRange([{start: 3, end: 3.5}, {start: 2, end: 2.5}], 0, 1, 5), null);
});

test("overlapping and duplicate silence cuts merge before applying", () => {
  assert.deepEqual(
    normalizeCutRanges([
      {start: 2, end: 3},
      {start: 2, end: 3},
      {start: 2.5, end: 4},
      {start: -2, end: 1},
      {start: 8, end: 12},
    ], 10),
    [{start: 0, end: 1}, {start: 2, end: 4}, {start: 8, end: 10}],
  );
  assert.deepEqual(
    mapRangeAfterCuts(0, 10, [{start: 2, end: 4}, {start: 3, end: 5}]),
    [{start: 0, end: 2}, {start: 2, end: 7}],
  );
});

test("source ranges remain inside trimmed clips at 0.5x, 1x, and 2x across clip edges", () => {
  const clips = [
    {start: 0, end: 8, sourceStart: 10, sourceEnd: 14, speed: 0.5},
    {start: 8, end: 10, sourceStart: 30, sourceEnd: 34, speed: 2},
    {start: 10, end: 14, sourceStart: 50, sourceEnd: 54, speed: 1},
  ];
  const fragments = splitTimelineClips(clips, [
    {start: 7.5, end: 8.5},
    {start: 8, end: 8.25},
    {start: 12, end: 13},
  ]);
  assert.deepEqual(fragments, [
    {start: 0, sourceStart: 10, sourceEnd: 13.75, speed: 0.5},
    {start: 8.5, sourceStart: 31, sourceEnd: 34, speed: 2},
    {start: 10, sourceStart: 50, sourceEnd: 52, speed: 1},
    {start: 13, sourceStart: 53, sourceEnd: 54, speed: 1},
  ]);
  for (const fragment of fragments) {
    const original = clips.find((clip) =>
      fragment.sourceStart >= clip.sourceStart && fragment.sourceEnd <= clip.sourceEnd,
    );
    assert.ok(original);
    assert.ok((fragment.sourceEnd - fragment.sourceStart) / fragment.speed > 0);
  }
  assert.deepEqual(getSourcePosition(clips, 2), {sourceTime: 11, speed: 0.5});
  assert.deepEqual(getSourcePosition(clips, 9), {sourceTime: 32, speed: 2});
  assert.deepEqual(getSourcePosition(clips, 12), {sourceTime: 52, speed: 1});
  const reflowed = reflowTimelineClips(fragments.map((fragment, index) => ({...fragment, id: `${index}`})));
  assert.deepEqual(reflowed.map(({start, end}) => [start, end]), [
    [0, 7.5],
    [7.5, 9],
    [9, 11],
    [11, 12],
  ]);
  assert.deepEqual(getSourcePosition(reflowed, 8), {sourceTime: 32, speed: 2});
});

test("chunked audio extraction preserves source trims and 0.5x, 1x, and 2x playback speeds", () => {
  const clips = [
    {start: 0, end: 2, sourceStart: 10, sourceEnd: 11, speed: 0.5},
    {start: 2, end: 3, sourceStart: 20, sourceEnd: 21, speed: 1},
    {start: 3, end: 7, sourceStart: 30, sourceEnd: 38, speed: 2},
  ];
  const parts = getAudioChunkParts(clips, 1, 5);
  assert.deepEqual(parts, [
    {sourceStart: 10.5, sourceEnd: 11, speed: 0.5},
    {sourceStart: 20, sourceEnd: 21, speed: 1},
    {sourceStart: 30, sourceEnd: 34, speed: 2},
  ]);
  const graph = buildAudioChunkFilterGraph(parts, -35);
  assert.match(graph, /atrim=start=10\.5:end=11[^;]*atempo=0\.5/);
  assert.match(graph, /atrim=start=20:end=21[^;]*atempo=1/);
  assert.match(graph, /atrim=start=30:end=34[^;]*atempo=2/);
  assert.match(graph, /silencedetect=noise=-35dB:d=0\.05/);
  assert.throws(() => buildAudioChunkFilterGraph(parts, 0), /threshold/);
});

test("VAD keeps quiet speech and steady background noise instead of cutting them", () => {
  assert.deepEqual(detectSilencesFromRms(Array(150).fill(0.005), 0.02, 0.7), []);
  assert.deepEqual(detectSilencesFromRms(Array(150).fill(0.01), 0.02, 0.7), []);
});

test("VAD cuts long digital silence with boundary padding, not a short natural pause", () => {
  const levels = [
    ...Array(100).fill(0.03),
    ...Array(50).fill(0),
    ...Array(100).fill(0.03),
    ...Array(10).fill(0),
    ...Array(100).fill(0.03),
  ];
  assert.deepEqual(detectSilencesFromRms(levels, 0.02, 0.7), [{start: 2.08, end: 2.92}]);
});

test("intentional long pauses remain review candidates and short pauses are filtered by configuration", () => {
  const detected = parseSilenceDetectionLog(
    "[silencedetect] silence_start: 4.2\n[silencedetect] silence_end: 6.8",
    10,
  );
  assert.deepEqual(detected, [{start: 4.2, end: 6.8}]);
  assert.deepEqual(createSilenceReviewCandidates(detected, 10, 0.7), [{start: 4.2, end: 6.8}]);
  assert.deepEqual(createSilenceReviewCandidates(detected, 10, 3), []);
  assert.deepEqual(
    createSilenceReviewCandidates([{start: 1, end: 1.5}, {start: 3, end: 5}], 10, 0.7),
    [{start: 3, end: 5}],
  );
});

test("silence log parsing bounds candidates to the chunk and closes trailing silence", () => {
  assert.deepEqual(
    parseSilenceDetectionLog("silence_start: -0.3\nsilence_end: 8.5\nsilence_start: 9.2", 10),
    [{start: 0, end: 8.5}, {start: 9.2, end: 10}],
  );
});

test("aborted Auto-Cut work is rejected instead of continuing", () => {
  const controller = new globalThis.AbortController();
  throwIfAborted(controller.signal);
  controller.abort();
  assert.throws(() => throwIfAborted(controller.signal), {name: "AbortError"});
});

test("abort cleanup releases processing resources once and normal cleanup unregisters it", () => {
  const cancelled = new globalThis.AbortController();
  let releases = 0;
  registerAbortCleanup(cancelled.signal, () => { releases += 1; });
  cancelled.abort();
  cancelled.abort();
  assert.equal(releases, 1);

  const completed = new globalThis.AbortController();
  const unregisterCleanup = registerAbortCleanup(completed.signal, () => { releases += 1; });
  unregisterCleanup();
  completed.abort();
  assert.equal(releases, 1);
});

test("malformed Gemini JSON and invalid indexes are rejected by the parser and range mapper", () => {
  assert.throws(() => parseGeminiJson("{", (value) => value));
  assert.throws(() => parseGeminiJson(
    JSON.stringify({startWordIndex: 900, endWordIndex: 901}),
    (value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("startWordIndex" in value) ||
        !("endWordIndex" in value) ||
        !Number.isInteger(value.startWordIndex) ||
        !Number.isInteger(value.endWordIndex) ||
        value.startWordIndex >= 1 ||
        value.endWordIndex >= 1
      ) {
        throw new Error("invalid index response");
      }
      return value;
    },
  ));
  assert.equal(resolveWordIndexRange([{start: 1, end: 1.2}], 900, 901, 10), null);
});

test("Gemini Auto-Cut requests use server-side credentials and structured JSON", async () => {
  globalThis.process.env.GEMINI_API_KEY = "server-only-test-key";
  let capturedUrl = "";
  let capturedInit;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new globalThis.Response(JSON.stringify({
      candidates: [{content: {parts: [{text: '{"findings": []}'}]}}],
    }), {status: 200});
  };
  const schema = {type: "OBJECT", properties: {findings: {type: "ARRAY"}}};
  assert.equal(await generateGeminiJson("indexed transcript", "system", schema), '{"findings": []}');
  assert.equal(capturedUrl.includes("server-only-test-key"), false);
  assert.equal(capturedInit.headers["x-goog-api-key"], "server-only-test-key");
  assert.equal(capturedInit.headers["Content-Type"], "application/json");
  assert.equal(capturedInit.signal instanceof globalThis.AbortSignal, true);
  const request = JSON.parse(capturedInit.body);
  assert.equal(request.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(request.generationConfig.responseSchema, schema);
});

test("Gemini Auto-Cut receives the caller's AbortSignal", async () => {
  globalThis.process.env.GEMINI_API_KEY = "test-key";
  const controller = new globalThis.AbortController();
  let receivedSignal;
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    receivedSignal = init.signal;
    init.signal.addEventListener("abort", () => reject(init.signal.reason), {once: true});
  });
  const pendingRequest = generateGeminiJson("prompt", "system", {}, controller.signal);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  assert.ok(receivedSignal instanceof globalThis.AbortSignal);
  controller.abort();
  await assert.rejects(pendingRequest, {name: "AbortError"});
  assert.equal(receivedSignal.aborted, true);
});

test("Gemini errors preserve explicit quota, timeout, network, and missing-key failures", async (context) => {
  globalThis.process.env.GEMINI_API_KEY = "test-key";

  await context.test("missing API key does not make a request", async () => {
    delete globalThis.process.env.GEMINI_API_KEY;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error("unexpected request");
    };
    await assert.rejects(generateGeminiJson("prompt", "system", {}), /GEMINI_API_KEY is missing/);
    assert.equal(called, false);
  });

  await context.test("quota response is explicit and does not retry another model or provider", async () => {
    globalThis.process.env.GEMINI_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new globalThis.Response(
        JSON.stringify({error: {message: "quota exhausted"}}),
        {status: 429},
      );
    };
    await assert.rejects(generateGeminiJson("prompt", "system", {}), FreeQuotaExhaustedError);
    assert.equal(calls, 1);
  });

  await context.test("network and timeout failures propagate to local fallback", async () => {
    globalThis.process.env.GEMINI_API_KEY = "test-key";
    globalThis.fetch = async () => {
      throw new TypeError("network disconnected");
    };
    await assert.rejects(generateGeminiJson("prompt", "system", {}), /network disconnected/);

    globalThis.fetch = async (_input, init) => {
      assert.ok(init?.signal instanceof globalThis.AbortSignal);
      throw new globalThis.DOMException("request timed out", "TimeoutError");
    };
    await assert.rejects(generateGeminiJson("prompt", "system", {}), /request timed out/);
  });
});
