import { NextRequest, NextResponse } from "next/server";
import { generateGeminiJson, parseGeminiJson } from "@/lib/ai/gemini";
import { freeQuotaResponse, isFreeQuotaExhaustedError } from "@/lib/ai/provider-policy";
import { resolveWordIndexRange, throwIfAborted } from "@/lib/video/auto-cut";
import { authorizeTeamRequest, readJsonBody } from "@/lib/api/team-api-auth";
import { z } from "zod";

export const runtime = "nodejs";

const TranscriptWordSchema = z.object({
  word: z.string().min(1),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
}).refine((word) => word.end > word.start);

const SilenceSegmentSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
}).refine((segment) => segment.end > segment.start);

const RequestSchema = z.object({
  script: z.string().trim().min(1).max(50_000),
  transcriptWords: z.array(TranscriptWordSchema).min(1).max(100_000),
  silenceSegments: z.array(SilenceSegmentSchema).max(100_000).optional().default([]),
  scriptLines: z.array(z.string().trim().min(1)).min(1).max(2_000).optional(),
  timelineDuration: z.number().finite().positive().optional(),
}).strict();

const CleanScriptRequestSchema = z.object({
  action: z.literal("clean-script"),
  script: z.string().trim().min(1).max(50_000),
}).strict();

const CleanScriptResponseSchema = z.object({
  lines: z.array(z.string().trim().min(1)).min(1).max(2_000),
}).strict();

const CleanScriptGeminiSchema = {
  type: "OBJECT",
  properties: {
    lines: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["lines"],
} as const;

interface WordRange {
  startIndex: number;
  endIndex: number;
}

interface AnnotatedWordRange extends WordRange {
  isSuggestedCut: boolean;
  explanation?: string;
  bestTake?: WordRange;
}

interface ScriptMatch extends WordRange {
  lineIndex: number;
  score: number;
}

interface TranscriptSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  isSuggestedCut: boolean;
  reason: "silence" | "retake" | null;
  explanation?: string;
  bestTakeText?: string;
}

const GeminiFindingSchema = z.object({
  startWordIndex: z.number().int().nonnegative(),
  endWordIndex: z.number().int().nonnegative(),
  category: z.enum(["filler", "false_start", "repeated_take", "retake"]),
  confidence: z.number().min(0).max(1),
  explanation: z.string().trim().min(1).max(240),
  bestTakeStartWordIndex: z.number().int(),
  bestTakeEndWordIndex: z.number().int(),
}).strict();

const GeminiFindingsSchema = z.object({
  findings: z.array(GeminiFindingSchema).max(100),
}).strict();

const GeminiFindingsResponseSchema = {
  type: "OBJECT",
  properties: {
    findings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          startWordIndex: { type: "INTEGER" },
          endWordIndex: { type: "INTEGER" },
          category: { type: "STRING", enum: ["filler", "false_start", "repeated_take", "retake"] },
          confidence: { type: "NUMBER" },
          explanation: { type: "STRING" },
          bestTakeStartWordIndex: { type: "INTEGER" },
          bestTakeEndWordIndex: { type: "INTEGER" },
        },
        required: [
          "startWordIndex",
          "endWordIndex",
          "category",
          "confidence",
          "explanation",
          "bestTakeStartWordIndex",
          "bestTakeEndWordIndex",
        ],
      },
    },
  },
  required: ["findings"],
} as const;

const GEMINI_CHUNK_WORDS = 320;
const GEMINI_CHUNK_OVERLAP = 32;
const GEMINI_MAX_WORDS = 1_280;

function normalizeWord(word: string): string {
  return word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function splitScriptByPunctuation(script: string): string[] {
  return script
    .split(/\r\n?|\n/u)
    .flatMap((rawLine) => rawLine.match(/[^.!?]+[.!?]?/gu) ?? [])
    .flatMap((sentence) => {
      const trimmedSentence = sentence.trim();
      const wordCount = trimmedSentence.split(/\s+/u).filter(Boolean).length;
      return wordCount > 15 ? trimmedSentence.split(/,\s+/u) : [trimmedSentence];
    })
    .map((line) => line.trim())
    .filter(Boolean);
}

function splitLongScriptLines(lines: string[], maxWords = 12): string[] {
  return lines.flatMap((line) => {
    const words = line.trim().split(/\s+/u).filter(Boolean);
    const shortLines: string[] = [];
    for (let index = 0; index < words.length; index += maxWords) {
      shortLines.push(words.slice(index, index + maxWords).join(" "));
    }
    return shortLines;
  });
}

async function cleanScriptWithAI(script: string, signal: AbortSignal): Promise<string[]> {
  const fallback = () => splitLongScriptLines(splitScriptByPunctuation(script));
  try {
    throwIfAborted(signal);
    const content = await generateGeminiJson(
      `Split this script into natural spoken lines at sentence endings and likely breath pauses. Keep each line to roughly 5-12 words.\n\nScript:\n${script.slice(0, 12_000)}`,
      "Return concise lines in the requested JSON schema. Preserve the script's original language and meaning.",
      CleanScriptGeminiSchema,
      signal,
    );
    throwIfAborted(signal);
    const result = parseGeminiJson(content, (value) => CleanScriptResponseSchema.parse(value));
    return splitLongScriptLines(result.lines);
  } catch (error: unknown) {
    throwIfAborted(signal);
    if (isFreeQuotaExhaustedError(error)) throw error;
    console.warn("Gemini script preprocessing failed; using punctuation-based splitting.", error);
    return fallback();
  }
}

function editDistance(first: string[], second: string[]): number {
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex];
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      const firstWord = first[firstIndex - 1] ?? "";
      const secondWord = second[secondIndex - 1] ?? "";
      const substitutionCost = firstWord === secondWord
        ? 0
        : wordSimilarity(firstWord, secondWord) >= 0.75
          ? 0.25
          : 1;
      current[secondIndex] = Math.min(
        (previous[secondIndex] ?? 0) + 1,
        (current[secondIndex - 1] ?? 0) + 1,
        (previous[secondIndex - 1] ?? 0) + substitutionCost,
      );
    }
    previous = current;
  }
  return previous[second.length] ?? first.length;
}

function wordSimilarity(first: string, second: string): number {
  if (first === second) return 1;
  const maxLength = Math.max(first.length, second.length);
  if (maxLength === 0) return 1;
  const firstChars = Array.from(first);
  const secondChars = Array.from(second);
  let previous = Array.from({ length: secondChars.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= firstChars.length; firstIndex += 1) {
    const current = [firstIndex];
    for (let secondIndex = 1; secondIndex <= secondChars.length; secondIndex += 1) {
      current[secondIndex] = Math.min(
        (previous[secondIndex] ?? 0) + 1,
        (current[secondIndex - 1] ?? 0) + 1,
        (previous[secondIndex - 1] ?? 0) +
          (firstChars[firstIndex - 1] === secondChars[secondIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - (previous[secondChars.length] ?? maxLength) / maxLength;
}

function findScriptLineMatches(
  scriptLines: string[],
  words: z.infer<typeof TranscriptWordSchema>[],
): ScriptMatch[] {
  const normalizedWords = words.map((word) => normalizeWord(word.word));
  const lineWords = scriptLines.map((line) => line.split(/\s+/u).map(normalizeWord).filter(Boolean));
  const primaryMatches: ScriptMatch[] = [];
  let searchStartIndex = 0;

  const findBestAtStart = (wordsToMatch: string[], startIndex: number, lineIndex: number): ScriptMatch | null => {
    let best: ScriptMatch | null = null;
    const minLength = Math.max(1, wordsToMatch.length - 2);
    const maxLength = Math.min(normalizedWords.length - startIndex, wordsToMatch.length + 2);
    for (let length = minLength; length <= maxLength; length += 1) {
      const transcriptSlice = normalizedWords.slice(startIndex, startIndex + length);
      if (transcriptSlice.some((word) => !word)) continue;
      const score = 1 - editDistance(wordsToMatch, transcriptSlice) / Math.max(wordsToMatch.length, length);
      if (
        !best ||
        score > best.score ||
        (score === best.score &&
          Math.abs(length - wordsToMatch.length) <
            Math.abs(best.endIndex - best.startIndex + 1 - wordsToMatch.length))
      ) {
        best = { startIndex, endIndex: startIndex + length - 1, lineIndex, score };
      }
    }
    return best;
  };

  scriptLines.forEach((_, lineIndex) => {
    const wordsToMatch = lineWords[lineIndex] ?? [];
    if (wordsToMatch.length === 0) return;

    const lastStartIndex = Math.min(normalizedWords.length - 1, searchStartIndex + 500);
    let best: ScriptMatch | null = null;
    for (let startIndex = searchStartIndex; startIndex <= lastStartIndex; startIndex += 1) {
      const candidate = findBestAtStart(wordsToMatch, startIndex, lineIndex);
      if (
        candidate &&
        (!best || candidate.score > best.score ||
          (candidate.score === best.score && candidate.startIndex < best.startIndex))
      ) {
        best = candidate;
      }
    }
    if (!best || best.score < 0.68) return;

    primaryMatches.push(best);
    searchStartIndex = best.endIndex + 1;
  });

  const matches = [...primaryMatches];
  for (let lineIndex = 0; lineIndex < lineWords.length; lineIndex += 1) {
    const wordsToMatch = lineWords[lineIndex] ?? [];
    if (wordsToMatch.length === 0) continue;

    const candidates: ScriptMatch[] = [];
    for (let startIndex = 0; startIndex < normalizedWords.length; startIndex += 1) {
      const candidate = findBestAtStart(wordsToMatch, startIndex, lineIndex);
      if (
        candidate &&
        candidate.score >= 0.68 &&
        !primaryMatches.some((primary) =>
          primary.lineIndex !== lineIndex && rangesOverlap(primary, candidate),
        )
      ) {
        candidates.push(candidate);
      }
    }

    const selected: ScriptMatch[] = [];
    for (const candidate of candidates.sort((first, second) =>
      second.score - first.score || first.startIndex - second.startIndex,
    )) {
      if (selected.some((match) => rangesOverlap(match, candidate))) continue;
      selected.push(candidate);
    }
    for (const candidate of selected) {
      if (!matches.some((match) => match.lineIndex === lineIndex && rangesOverlap(match, candidate))) {
        matches.push(candidate);
      }
    }
  }

  return matches.sort((first, second) => first.startIndex - second.startIndex);
}

function findAnchoredFalseStarts(
  scriptLines: string[],
  matches: ScriptMatch[],
  words: z.infer<typeof TranscriptWordSchema>[],
): WordRange[] {
  const normalizedWords = words.map((word) => normalizeWord(word.word));
  const falseStarts: WordRange[] = [];
  for (const match of matches) {
    const lineWords = scriptLines[match.lineIndex]?.split(/\s+/u).map(normalizeWord).filter(Boolean) ?? [];
    for (let prefixLength = Math.min(5, lineWords.length - 1); prefixLength >= 2; prefixLength -= 1) {
      const prefix = lineWords.slice(0, prefixLength);
      const prefixStart = match.startIndex - prefixLength;
      const prefixEnd = match.startIndex - 1;
      const lastPrefixWord = words[prefixEnd];
      const firstMatchedWord = words[match.startIndex];
      if (
        prefixStart < 0 ||
        !lastPrefixWord ||
        !firstMatchedWord ||
        !matchesAt(normalizedWords, prefix, prefixStart) ||
        firstMatchedWord.start - lastPrefixWord.end > 1 ||
        matches.some((existing) => existing !== match && rangesOverlap(existing, { startIndex: prefixStart, endIndex: prefixEnd }))
      ) {
        continue;
      }
      falseStarts.push({ startIndex: prefixStart, endIndex: prefixEnd });
      break;
    }
  }
  return falseStarts;
}

function findImmediateScriptRepetitions(
  scriptLines: string[],
  words: z.infer<typeof TranscriptWordSchema>[],
): AnnotatedWordRange[] {
  const normalizedWords = words.map((word) => normalizeWord(word.word));
  const normalizedScriptWords = scriptLines
    .flatMap((line) => line.split(/\s+/u))
    .map(normalizeWord)
    .filter(Boolean);
  const repetitions: AnnotatedWordRange[] = [];

  for (let startIndex = 0; startIndex < normalizedWords.length;) {
    const maxLength = Math.min(5, Math.floor((normalizedWords.length - startIndex) / 2));
    let repeatedLength = 0;
    let repeatCount = 0;

    for (let length = maxLength; length >= 3; length -= 1) {
      const sequence = normalizedWords.slice(startIndex, startIndex + length);
      if (sequence.some((word) => !word) || countSequence(normalizedScriptWords, sequence) !== 1) continue;

      let count = 1;
      while (matchesAt(normalizedWords, sequence, startIndex + count * length)) {
        const previousWord = words[startIndex + count * length - 1];
        const nextWord = words[startIndex + count * length];
        if (!previousWord || !nextWord || nextWord.start - previousWord.end > 0.2) break;
        count += 1;
      }
      if (count < 2) continue;
      repeatedLength = length;
      repeatCount = count;
      break;
    }

    if (repeatedLength === 0) {
      startIndex += 1;
      continue;
    }

    for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
      repetitions.push({
        startIndex: startIndex + repeatIndex * repeatedLength,
        endIndex: startIndex + (repeatIndex + 1) * repeatedLength - 1,
        isSuggestedCut: repeatIndex < repeatCount - 1,
      });
    }
    startIndex += repeatedLength * repeatCount;
  }

  return repetitions;
}

function matchesAt(words: string[], phrase: string[], startIndex: number): boolean {
  return phrase.every((word, offset) => words[startIndex + offset] === word);
}

function findScriptFalseStarts(
  script: string,
  words: z.infer<typeof TranscriptWordSchema>[],
): Array<{ retake: WordRange; keep: WordRange }> {
  const normalizedWords = words.map((word) => normalizeWord(word.word));
  const sentences = script.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [script];
  const falseStarts: Array<{ retake: WordRange; keep: WordRange }> = [];

  for (const sentence of sentences) {
    const sentenceWords = sentence.split(/\s+/u).map(normalizeWord).filter(Boolean);
    if (sentenceWords.length < 2) continue;

    for (let sentenceStart = 1; sentenceStart <= normalizedWords.length - sentenceWords.length; sentenceStart += 1) {
      if (!matchesAt(normalizedWords, sentenceWords, sentenceStart)) continue;

      for (let prefixLength = Math.min(5, sentenceWords.length); prefixLength >= 2; prefixLength -= 1) {
        const prefix = sentenceWords.slice(0, prefixLength);
        const prefixStart = sentenceStart - prefixLength;
        const prefixEnd = sentenceStart - 1;
        const firstPrefixWord = words[prefixStart];
        const lastPrefixWord = words[prefixEnd];
        const sentenceWord = words[sentenceStart];
        if (
          prefixStart < 0 ||
          !firstPrefixWord ||
          !lastPrefixWord ||
          !sentenceWord ||
          !matchesAt(normalizedWords, prefix, prefixStart) ||
          sentenceWord.start - lastPrefixWord.end > 1
        ) {
          continue;
        }

        falseStarts.push({
          retake: { startIndex: prefixStart, endIndex: prefixEnd },
          keep: { startIndex: sentenceStart, endIndex: sentenceStart + sentenceWords.length - 1 },
        });
        break;
      }
    }
  }

  return falseStarts;
}

function countSequence(words: string[], sequence: string[]): number {
  let count = 0;
  for (let startIndex = 0; startIndex <= words.length - sequence.length; startIndex += 1) {
    if (matchesAt(words, sequence, startIndex)) count += 1;
  }
  return count;
}

function findScriptAwareRepetitions(
  script: string,
  words: z.infer<typeof TranscriptWordSchema>[],
): Array<{ retake: WordRange; keep: WordRange }> {
  const normalizedWords = words.map((word) => normalizeWord(word.word));
  const normalizedScriptWords = script.split(/\s+/u).map(normalizeWord).filter(Boolean);
  const repetitions: Array<{ retake: WordRange; keep: WordRange }> = [];

  for (let startIndex = 0; startIndex < normalizedWords.length;) {
    const maxLength = Math.min(5, Math.floor((normalizedWords.length - startIndex) / 2));
    let matchedLength = 0;

    for (let length = maxLength; length >= 1; length -= 1) {
      const sequence = normalizedWords.slice(startIndex, startIndex + length);
      if (
        sequence.some((word) => !word) ||
        countSequence(normalizedScriptWords, sequence) !== 1 ||
        !matchesAt(normalizedWords, sequence, startIndex + length)
      ) {
        continue;
      }
      const firstOccurrenceEnd = words[startIndex + length - 1];
      const secondOccurrenceStart = words[startIndex + length];
      if (
        !firstOccurrenceEnd ||
        !secondOccurrenceStart ||
        secondOccurrenceStart.start - firstOccurrenceEnd.end > 0.2
      ) {
        continue;
      }

      repetitions.push({
        retake: { startIndex, endIndex: startIndex + length - 1 },
        keep: { startIndex: startIndex + length, endIndex: startIndex + 2 * length - 1 },
      });
      matchedLength = length;
      break;
    }

    startIndex += matchedLength > 0 ? matchedLength * 2 : 1;
  }

  return repetitions;
}

function getScriptPhraseMatch(
  phrase: string[],
  scriptWords: string[],
): { score: number; range: WordRange } | null {
  let bestScore = 0;
  let bestStart = -1;
  let bestEnd = -1;
  let ambiguousBestMatch = false;
  const minLength = Math.max(1, phrase.length - 1);
  const maxLength = Math.min(scriptWords.length, phrase.length + 1);

  for (let startIndex = 0; startIndex < scriptWords.length; startIndex += 1) {
    for (let length = minLength; length <= maxLength; length += 1) {
      const scriptPhrase = scriptWords.slice(startIndex, startIndex + length);
      if (scriptPhrase.length !== length) continue;
      const score = 1 - editDistance(phrase, scriptPhrase) / Math.max(phrase.length, length);
      if (score > bestScore + 1e-9) {
        bestScore = score;
        bestStart = startIndex;
        bestEnd = startIndex + length - 1;
        ambiguousBestMatch = false;
      } else if (Math.abs(score - bestScore) <= 1e-9 && score > 0) {
        const candidateRange = { startIndex, endIndex: startIndex + length - 1 };
        if (!rangesOverlap({ startIndex: bestStart, endIndex: bestEnd }, candidateRange)) {
          ambiguousBestMatch = true;
        }
      }
    }
  }

  if (ambiguousBestMatch || bestStart < 0) return null;
  return { score: bestScore, range: { startIndex: bestStart, endIndex: bestEnd } };
}

function findFuzzyScriptRepetitions(
  script: string,
  words: z.infer<typeof TranscriptWordSchema>[],
): Array<{ retake: WordRange; keep: WordRange }> {
  const normalizedWords = words.map((word) => normalizeWord(word.word));
  const scriptWords = script.split(/\s+/u).map(normalizeWord).filter(Boolean);
  const repetitions: Array<{ retake: WordRange; keep: WordRange }> = [];
  const occupiedRanges: WordRange[] = [];
  const scriptMatchCache = new Map<string, { score: number; range: WordRange } | null>();
  const getCachedScriptMatch = (phrase: string[]) => {
    const key = phrase.join(" ");
    if (!scriptMatchCache.has(key)) {
      scriptMatchCache.set(key, getScriptPhraseMatch(phrase, scriptWords));
    }
    return scriptMatchCache.get(key) ?? null;
  };

  for (let startIndex = 0; startIndex < normalizedWords.length; startIndex += 1) {
    let repetition: { retake: WordRange; keep: WordRange } | null = null;
    let nextStartIndex = startIndex;
    const maxLength = Math.min(5, Math.floor((normalizedWords.length - startIndex) / 2));

    for (let length = maxLength; length >= 3 && !repetition; length -= 1) {
      const firstPhrase = normalizedWords.slice(startIndex, startIndex + length);
      if (firstPhrase.some((word) => !word)) continue;

      const maxSecondStart = Math.min(startIndex + length + 2, normalizedWords.length - length);
      for (let secondStart = startIndex + length; secondStart <= maxSecondStart; secondStart += 1) {
        const secondPhrase = normalizedWords.slice(secondStart, secondStart + length);
        if (secondPhrase.some((word) => !word)) continue;

        const phraseScore = 1 - editDistance(firstPhrase, secondPhrase) / length;
        if (phraseScore < 0.8 || phraseScore >= 1) continue;

        const firstRange = { startIndex, endIndex: startIndex + length - 1 };
        const secondRange = { startIndex: secondStart, endIndex: secondStart + length - 1 };
        if (
          occupiedRanges.some((range) =>
            rangesOverlap(range, firstRange) || rangesOverlap(range, secondRange),
          )
        ) {
          continue;
        }

        const firstScriptMatch = getCachedScriptMatch(firstPhrase);
        const secondScriptMatch = getCachedScriptMatch(secondPhrase);
        if (
          !firstScriptMatch ||
          firstScriptMatch.score < 0.8 ||
          !secondScriptMatch ||
          secondScriptMatch.score < 0.8 ||
          !rangesOverlap(firstScriptMatch.range, secondScriptMatch.range)
        ) {
          continue;
        }

        repetition = firstScriptMatch.score > secondScriptMatch.score + 1e-9
          ? { retake: secondRange, keep: firstRange }
          : { retake: firstRange, keep: secondRange };
        nextStartIndex = secondStart + length - 1;
        break;
      }
    }

    if (!repetition) continue;
    repetitions.push(repetition);
    occupiedRanges.push(repetition.retake, repetition.keep);
    startIndex = nextStartIndex;
  }

  return repetitions;
}

function rangesOverlap(first: WordRange, second: WordRange): boolean {
  return first.startIndex <= second.endIndex && second.startIndex <= first.endIndex;
}

function createTranscriptSegments(
  words: z.infer<typeof TranscriptWordSchema>[],
  ranges: AnnotatedWordRange[],
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const rangesByStart = new Map(ranges.map((range) => [range.startIndex, range]));
  let segmentIndex = 0;
  let index = 0;

  while (index < words.length) {
    const annotatedRange = rangesByStart.get(index);
    if (annotatedRange) {
      const rangeWords = words.slice(annotatedRange.startIndex, annotatedRange.endIndex + 1);
      const firstWord = rangeWords[0];
      const lastWord = rangeWords[rangeWords.length - 1];
      if (firstWord && lastWord) {
        segments.push({
          id: `segment-${segmentIndex}`,
          text: rangeWords.map((word) => word.word).join(" "),
          start: firstWord.start,
          end: lastWord.end,
          isSuggestedCut: annotatedRange.isSuggestedCut,
          reason: annotatedRange.isSuggestedCut ? "retake" : null,
          explanation: annotatedRange.explanation,
          bestTakeText: annotatedRange.bestTake
            ? words.slice(annotatedRange.bestTake.startIndex, annotatedRange.bestTake.endIndex + 1)
              .map((word) => word.word)
              .join(" ")
            : undefined,
        });
        segmentIndex += 1;
      }
      index = annotatedRange.endIndex + 1;
      continue;
    }

    const lineStart = index;
    index += 1;
    while (index < words.length && !rangesByStart.has(index)) {
      const previousWord = words[index - 1];
      const nextWord = words[index];
      if (!previousWord || !nextWord) break;
      const hasPause = nextWord.start - previousWord.end > 0.2;
      const hasPunctuation = /[.!?]["'’)\]]*$/u.test(previousWord.word);
      if (hasPause || hasPunctuation) break;
      index += 1;
    }

    const lineWords = words.slice(lineStart, index);
    const firstWord = lineWords[0];
    const lastWord = lineWords[lineWords.length - 1];
    if (firstWord && lastWord) {
      segments.push({
        id: `segment-${segmentIndex}`,
        text: lineWords.map((word) => word.word).join(" "),
        start: firstWord.start,
        end: lastWord.end,
        isSuggestedCut: false,
        reason: null,
      });
      segmentIndex += 1;
    }
  }

  return segments.sort((first, second) => first.start - second.start || first.end - second.end);
}

function getRelevantScriptContext(script: string, transcriptWords: string[]): string {
  if (script.length <= 1_500) return script;
  const transcriptTokens = new Set(transcriptWords.map(normalizeWord).filter((word) => word.length > 2));
  const lines = splitScriptByPunctuation(script);
  const rankedLines = lines.map((line, index) => {
    const tokens = line.split(/\s+/u).map(normalizeWord).filter((word) => word.length > 2);
    return {
      index,
      line,
      score: tokens.reduce((score, token) => score + Number(transcriptTokens.has(token)), 0),
    };
  });
  const selected = rankedLines
    .filter((line) => line.score > 0)
    .sort((first, second) => second.score - first.score || first.index - second.index)
    .slice(0, 12)
    .sort((first, second) => first.index - second.index)
    .map(({line}) => line)
    .join("\n");
  return (selected || script).slice(0, 1_500);
}

async function findGeminiCutSuggestions(
  script: string,
  transcriptWords: z.infer<typeof TranscriptWordSchema>[],
  timelineDuration: number,
  signal: AbortSignal,
): Promise<{ ranges: AnnotatedWordRange[]; processedWords: number }> {
  const processedWords = Math.min(transcriptWords.length, GEMINI_MAX_WORDS);
  const wordsToAnalyze = transcriptWords.slice(0, processedWords);
  const findings: AnnotatedWordRange[] = [];

  for (let chunkStart = 0; chunkStart < wordsToAnalyze.length;) {
    throwIfAborted(signal);
    const chunkEnd = Math.min(wordsToAnalyze.length, chunkStart + GEMINI_CHUNK_WORDS);
    const chunk = wordsToAnalyze.slice(chunkStart, chunkEnd);
    const scriptContext = getRelevantScriptContext(script, chunk.map(({word}) => word));
    const prompt = [
      "Review this timestamped transcript excerpt against the script. Understand Hindi, Hinglish, and English.",
      "Find only clearly removable fillers, aborted false starts, repeated sentences, or inferior retakes.",
      "Never invent words or timestamps. Return global word indexes from the supplied transcript only.",
      "Use supplied word times only to avoid spanning long or natural pauses; do not return timestamps.",
      "For repeated takes, mark the inferior spoken attempt and reference the best take's word indexes.",
      "For no best take, set both bestTake indexes to -1. Prefer no suggestion when uncertain.",
      "Keep each finding short. Explain why in one concise sentence. Do not cut meaningful pauses, complete sentences, or incomplete speech without clear evidence.",
      `Script context:\n${scriptContext || "(No close script phrase; use the full script intent.)"}`,
      `Indexed timestamped transcript words:\n${chunk.map((word, offset) =>
        `${chunkStart + offset}: ${word.word} [${word.start.toFixed(2)}-${word.end.toFixed(2)}s]`,
      ).join("\n")}`,
    ].join("\n\n");
    const responseText = await generateGeminiJson(
      prompt,
      "You are a cautious multilingual video editor. Suggest reviewable cuts, not automatic deletions.",
      GeminiFindingsResponseSchema,
      signal,
    );
    throwIfAborted(signal);
    const validated = parseGeminiJson(
      responseText,
      (value) => GeminiFindingsSchema.parse(value),
    );

    for (const finding of validated.findings) {
      const {startWordIndex, endWordIndex} = finding;
      if (
        finding.confidence < 0.65 ||
        startWordIndex < chunkStart ||
        endWordIndex < startWordIndex ||
        endWordIndex >= chunkEnd ||
        endWordIndex - startWordIndex > 60
      ) {
        continue;
      }
      if (finding.category === "filler" && endWordIndex - startWordIndex > 4) continue;

      const timeRange = resolveWordIndexRange(
        transcriptWords,
        startWordIndex,
        endWordIndex,
        timelineDuration,
      );
      if (!timeRange) continue;

      const hasBestTake = finding.bestTakeStartWordIndex >= 0 && finding.bestTakeEndWordIndex >= 0;
      const bestTakeRange = hasBestTake
        ? resolveWordIndexRange(
            transcriptWords,
            finding.bestTakeStartWordIndex,
            finding.bestTakeEndWordIndex,
            timelineDuration,
          )
        : null;
      if (
        (finding.bestTakeStartWordIndex < 0) !== (finding.bestTakeEndWordIndex < 0) ||
        (finding.bestTakeStartWordIndex < 0 && finding.bestTakeStartWordIndex !== -1) ||
        (finding.bestTakeEndWordIndex < 0 && finding.bestTakeEndWordIndex !== -1) ||
        (hasBestTake &&
          (finding.bestTakeStartWordIndex < chunkStart ||
            finding.bestTakeEndWordIndex < finding.bestTakeStartWordIndex ||
            finding.bestTakeEndWordIndex >= chunkEnd ||
            rangesOverlap(
              {startIndex: startWordIndex, endIndex: endWordIndex},
              {startIndex: finding.bestTakeStartWordIndex, endIndex: finding.bestTakeEndWordIndex},
            ))) ||
        (hasBestTake && !bestTakeRange)
      ) {
        continue;
      }

      findings.push({
        startIndex: startWordIndex,
        endIndex: endWordIndex,
        isSuggestedCut: true,
        explanation: finding.explanation,
        bestTake: bestTakeRange
          ? {
              startIndex: finding.bestTakeStartWordIndex,
              endIndex: finding.bestTakeEndWordIndex,
            }
          : undefined,
      });
    }

    if (chunkEnd === wordsToAnalyze.length) break;
    chunkStart = chunkEnd - GEMINI_CHUNK_OVERLAP;
  }

  const deduplicated: AnnotatedWordRange[] = [];
  for (const finding of findings.sort((first, second) => first.startIndex - second.startIndex)) {
    if (deduplicated.some((existing) => rangesOverlap(existing, finding))) continue;
    deduplicated.push(finding);
  }
  return {ranges: deduplicated, processedWords};
}

function normalizeSilenceSegments(
  segments: Array<{start: number; end: number}>,
  duration: number,
): Array<{start: number; end: number}> {
  const sorted = segments
    .map(({start, end}) => ({
      start: Math.max(0, Math.min(duration, start)),
      end: Math.max(0, Math.min(duration, end)),
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((first, second) => first.start - second.start);
  const merged: Array<{start: number; end: number}> = [];
  for (const segment of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && segment.start <= previous.end) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeTeamRequest(request);
  if (!authorization.ok) return authorization.response;

  try {
    const body = await readJsonBody(request, 8 * 1024 * 1024);
    if (!body.ok) return body.response;
    const payload = body.body;
    const cleanRequest = CleanScriptRequestSchema.safeParse(payload);
    if (cleanRequest.success) {
      return NextResponse.json({ scriptLines: await cleanScriptWithAI(cleanRequest.data.script, request.signal) });
    }

    const parsedRequest = RequestSchema.safeParse(payload);
    if (!parsedRequest.success) {
      return NextResponse.json({ error: "A script and timestamped transcript are required." }, { status: 400 });
    }

    const { script, transcriptWords, silenceSegments, scriptLines } = parsedRequest.data;
    const timelineDuration = parsedRequest.data.timelineDuration ??
      transcriptWords[transcriptWords.length - 1]?.end ?? 0;
    if (
      timelineDuration <= 0 ||
      transcriptWords.some((word, index) =>
        word.end > timelineDuration ||
        (index > 0 && word.start < (transcriptWords[index - 1]?.start ?? 0)),
      )
    ) {
      return NextResponse.json({ error: "Transcript timestamps are outside the timeline." }, { status: 400 });
    }
    const normalizedSilenceCuts = normalizeSilenceSegments(silenceSegments, timelineDuration);
    const fallbackScriptLines = scriptLines ?? splitScriptByPunctuation(script);

    let geminiWarning: string | null = null;
    try {
      const {ranges: geminiRanges, processedWords} = await findGeminiCutSuggestions(
        script,
        transcriptWords,
        timelineDuration,
        request.signal,
      );
      const annotatedRanges = [...geminiRanges];
      const localPairs = [
        ...findScriptFalseStarts(script, transcriptWords),
        ...findScriptAwareRepetitions(script, transcriptWords),
        ...findFuzzyScriptRepetitions(script, transcriptWords),
      ];
      for (const pair of localPairs) {
        const pairRanges = [
          {...pair.retake, isSuggestedCut: true},
          {...pair.keep, isSuggestedCut: false},
        ];
        if (pairRanges.some((range) => annotatedRanges.some((existing) => rangesOverlap(range, existing)))) {
          continue;
        }
        annotatedRanges.push(...pairRanges);
      }
      annotatedRanges.sort((first, second) => first.startIndex - second.startIndex);
      return NextResponse.json({
        segments: createTranscriptSegments(transcriptWords, annotatedRanges),
        silenceCuts: normalizedSilenceCuts,
        scriptLines: fallbackScriptLines,
        analysisMode: "gemini",
        ...(processedWords < transcriptWords.length
          ? {warning: `Gemini reviewed the first ${processedWords} transcript words; local checks covered the full transcript.`}
          : {}),
      });
    } catch (error: unknown) {
      throwIfAborted(request.signal);
      if (isFreeQuotaExhaustedError(error)) throw error;
      geminiWarning = error instanceof Error ? error.message : "Gemini analysis is unavailable.";
      console.warn("Gemini cut analysis unavailable; using local checks.", error);
    }

    if (scriptLines) {
      const lineMatches = findScriptLineMatches(scriptLines, transcriptWords);
      const repetitionRanges = findImmediateScriptRepetitions(scriptLines, transcriptWords);
      for (const pair of findFuzzyScriptRepetitions(script, transcriptWords)) {
        const pairRanges = [
          { ...pair.retake, isSuggestedCut: true },
          { ...pair.keep, isSuggestedCut: false },
        ];
        if (pairRanges.some((range) => repetitionRanges.some((existing) => rangesOverlap(range, existing)))) {
          continue;
        }
        repetitionRanges.push(...pairRanges);
      }
      const matchesByLine = new Map<number, ScriptMatch[]>();
      for (const match of lineMatches) {
        if (repetitionRanges.some((range) => rangesOverlap(range, match))) continue;
        const lineMatchesForLine = matchesByLine.get(match.lineIndex) ?? [];
        lineMatchesForLine.push(match);
        matchesByLine.set(match.lineIndex, lineMatchesForLine);
      }

      const matchedRanges: AnnotatedWordRange[] = [...repetitionRanges];
      for (const lineMatchesForLine of matchesByLine.values()) {
        lineMatchesForLine.forEach((match, index) => {
          if (matchedRanges.some((existing) => rangesOverlap(existing, match))) return;
          matchedRanges.push({
            ...match,
            isSuggestedCut: index < lineMatchesForLine.length - 1,
          });
        });
      }

      const falseStartRanges = findAnchoredFalseStarts(scriptLines, lineMatches, transcriptWords);
      for (const range of falseStartRanges) {
        if (matchedRanges.some((existing) => rangesOverlap(existing, range))) continue;
        matchedRanges.push({ ...range, isSuggestedCut: true });
      }
      matchedRanges.sort((first, second) => first.startIndex - second.startIndex);

      return NextResponse.json({
        segments: createTranscriptSegments(transcriptWords, matchedRanges),
        silenceCuts: normalizedSilenceCuts,
        scriptLines,
        analysisMode: "local",
        warning: `Gemini analysis was unavailable; local retake checks were used. ${geminiWarning}`,
      });
    }

    const annotatedRanges: AnnotatedWordRange[] = [];
    const additionalRanges = [
      ...findScriptFalseStarts(script, transcriptWords),
      ...findScriptAwareRepetitions(script, transcriptWords),
      ...findFuzzyScriptRepetitions(script, transcriptWords),
    ];

    for (const pair of additionalRanges) {
      const pairRanges = [
        { ...pair.retake, isSuggestedCut: true },
        { ...pair.keep, isSuggestedCut: false },
      ];
      if (pairRanges.some((range) => annotatedRanges.some((existing) => rangesOverlap(range, existing)))) {
        continue;
      }
      annotatedRanges.push(...pairRanges);
    }

    annotatedRanges.sort((first, second) => first.startIndex - second.startIndex);
    return NextResponse.json({
      segments: createTranscriptSegments(transcriptWords, annotatedRanges),
      silenceCuts: normalizedSilenceCuts,
      scriptLines: fallbackScriptLines,
      analysisMode: "local",
      warning: `Gemini analysis was unavailable; local retake checks were used. ${geminiWarning}`,
    });
  } catch (error: unknown) {
    if (request.signal.aborted) {
      return NextResponse.json({error: "Transcript analysis was cancelled."}, {status: 499});
    }
    const quotaResponse = freeQuotaResponse(error);
    if (quotaResponse) return quotaResponse;
    console.error("Transcript alignment failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
