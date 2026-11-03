import { NextRequest, NextResponse } from "next/server";
import { createTextCompletion } from "@/lib/ai/openrouter";
import { z } from "zod";

export const runtime = "nodejs";

const TranscriptWordSchema = z.object({
  word: z.string().min(1),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
}).refine((word) => word.end >= word.start);

const SilenceSegmentSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
}).refine((segment) => segment.end > segment.start);

const RequestSchema = z.object({
  script: z.string().trim().min(1).max(50_000),
  transcriptText: z.string().min(1).max(250_000),
  transcriptWords: z.array(TranscriptWordSchema).min(1).max(100_000),
  silenceSegments: z.array(SilenceSegmentSchema).max(100_000).optional().default([]),
  scriptLines: z.array(z.string().trim().min(1)).min(1).max(2_000).optional(),
});

const CleanScriptRequestSchema = z.object({
  action: z.literal("clean-script"),
  script: z.string().trim().min(1).max(50_000),
});

interface WordRange {
  startIndex: number;
  endIndex: number;
}

interface AnnotatedWordRange extends WordRange {
  isSuggestedCut: boolean;
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
}

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

async function cleanScriptWithAI(script: string): Promise<string[]> {
  const fallback = () => splitLongScriptLines(splitScriptByPunctuation(script));
  const prompt = "Split the script into natural spoken lines. Split at every sentence ending (., ?, !) AND at natural pause points where the speaker would take a breath. Each line should be a single complete thought. Return ONLY a JSON object with a 'lines' array of strings. Keep lines short (5-12 words). You MUST return a valid JSON object with a non-empty lines array. If the script is short, return it as a single line.";
  const validate = (content: string) => {
    const result: unknown = JSON.parse(content.trim());
    if (
      typeof result !== "object" ||
      result === null ||
      !("lines" in result) ||
      !Array.isArray(result.lines) ||
      !result.lines.every((line) => typeof line === "string")
    ) {
      throw new Error("AI returned an invalid script-lines array.");
    }
    if (splitLongScriptLines(result.lines.map((line) => line.trim()).filter(Boolean)).length === 0) {
      throw new Error("AI returned no script lines.");
    }
  };

  try {
    const content = await createTextCompletion(
      [{ role: "user", content: `${prompt}\n\nScript:\n${script}` }],
      { temperature: 0, json: true },
      validate,
    );
    const result: unknown = JSON.parse(content.trim());
    if (typeof result !== "object" || result === null || !("lines" in result) ||
      !Array.isArray(result.lines) || !result.lines.every((line) => typeof line === "string")) {
      throw new Error("AI returned an invalid script-lines array.");
    }
    return splitLongScriptLines(result.lines.map((line) => line.trim()).filter(Boolean));
  } catch (error: unknown) {
    console.warn("AI script preprocessing failed; using punctuation-based splitting.", error);
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

function parsePhrases(response: string): string[] {
  const parsed: unknown = JSON.parse(response.trim());
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("phrasesToCut" in parsed) ||
    !Array.isArray(parsed.phrasesToCut) ||
    !parsed.phrasesToCut.every((phrase) => typeof phrase === "string")
  ) {
    throw new Error("AI returned invalid retake phrases.");
  }
  return parsed.phrasesToCut;
}

function matchPhrasesToWords(phrases: string[], words: z.infer<typeof TranscriptWordSchema>[]): WordRange[] {
  const normalizedWords = words.map((word) => normalizeWord(word.word));
  const ranges: WordRange[] = [];
  const usedWords = new Set<number>();
  const matchedPhrases = new Set<string>();

  for (const phrase of phrases) {
    const phraseWords = phrase.split(/\s+/u).map(normalizeWord).filter(Boolean);
    if (phraseWords.length === 0) continue;
    const phraseKey = phraseWords.join(" ");
    if (matchedPhrases.has(phraseKey)) continue;

    for (let startIndex = 0; startIndex <= normalizedWords.length - phraseWords.length; startIndex += 1) {
      if (phraseWords.some((_, phraseIndex) => usedWords.has(startIndex + phraseIndex))) continue;
      const matches = phraseWords.every((word, phraseIndex) =>
        normalizedWords[startIndex + phraseIndex] === word,
      );
      if (!matches) continue;
      const endIndex = startIndex + phraseWords.length - 1;
      ranges.push({ startIndex, endIndex });
      matchedPhrases.add(phraseKey);
      for (let index = startIndex; index <= endIndex; index += 1) usedWords.add(index);
      break;
    }
  }
  return ranges.sort((first, second) => first.startIndex - second.startIndex);
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

export async function POST(request: NextRequest) {
  try {
    const payload: unknown = await request.json();
    const cleanRequest = CleanScriptRequestSchema.safeParse(payload);
    if (cleanRequest.success) {
      return NextResponse.json({ scriptLines: await cleanScriptWithAI(cleanRequest.data.script) });
    }

    const parsedRequest = RequestSchema.safeParse(payload);
    if (!parsedRequest.success) {
      return NextResponse.json({ error: "A script and timestamped transcript are required." }, { status: 400 });
    }

    const { script, transcriptText, transcriptWords, silenceSegments, scriptLines } = parsedRequest.data;

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
        silenceCuts: silenceSegments,
        scriptLines,
      });
    }

    const prompt = `Compare the spoken transcript with the intended script. Identify only spoken retakes/repeated attempts that should be removed, keeping the take that best matches the script. Return a JSON object with a "phrasesToCut" array. Each entry must be an exact, contiguous phrase copied word-for-word from the transcript, including enough words to uniquely identify the unwanted take. Do not return script text that was not spoken. If there are no retakes, return {"phrasesToCut": []}.\n\nScript:\n${script}\n\nTranscript:\n${transcriptText}`;
    const systemPrompt = `Identify spoken retakes, including false starts (aborted sentences). If the speaker says a few words, stops, and immediately restarts the sentence, treat the initial short aborted words as a retake. Always mark the earlier take as the retake and keep the later take. Return only the requested JSON object.`;

    const content = await createTextCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      { temperature: 0, json: true },
      (response) => { parsePhrases(response); },
    );
    const phrasesToCut = parsePhrases(content);

    const modelRetakeRanges = matchPhrasesToWords(phrasesToCut, transcriptWords);
    const annotatedRanges: AnnotatedWordRange[] = modelRetakeRanges.map((range) => ({
      ...range,
      isSuggestedCut: true,
    }));
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
      silenceCuts: silenceSegments,
      scriptLines: splitScriptByPunctuation(script),
    });
  } catch (error: unknown) {
    console.error("Transcript alignment failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
