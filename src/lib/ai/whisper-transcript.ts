export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeWhisperResponseShape(response: unknown): string {
  if (!isRecord(response)) return `type=${response === null ? "null" : typeof response}`;
  const fields = Object.entries(response).map(([key, value]) => {
    const type = Array.isArray(value) ? `array(${value.length})` : value === null ? "null" : typeof value;
    return `${key}:${type}`;
  });
  const words = response.words;
  const firstWord = Array.isArray(words) ? words[0] : undefined;
  const firstWordShape = isRecord(firstWord)
    ? `; firstWord={${Object.entries(firstWord).map(([key, value]) =>
      `${key}:${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`,
    ).join(",")}}`
    : "";
  return `{${fields.join(",")}}${firstWordShape}`;
}

export function parseWhisperResponse(response: unknown): {
  transcriptText: string;
  transcriptWords: WhisperWord[];
} {
  if (!isRecord(response)) {
    throw new Error("Whisper returned an invalid response instead of a JSON object.");
  }
  if (typeof response.text !== "string" || !response.text.trim()) {
    throw new Error("Whisper returned an empty transcript.");
  }

  const words = response.words;
  if (!Array.isArray(words) || words.length === 0) {
    if (Array.isArray(response.segments) && response.segments.length > 0) {
      throw new Error(
        "Whisper returned segment-level timestamps but no word-level timestamps; Auto-Cut requires word timestamps.",
      );
    }
    throw new Error("Whisper returned transcript text but no word-level timestamps.");
  }

  const duration = response.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Whisper returned word timestamps without a valid audio duration.");
  }

  const transcriptWords: WhisperWord[] = [];
  for (const [index, value] of words.entries()) {
    if (
      !isRecord(value) ||
      typeof value.word !== "string" ||
      !value.word.trim() ||
      typeof value.start !== "number" ||
      !Number.isFinite(value.start) ||
      typeof value.end !== "number" ||
      !Number.isFinite(value.end) ||
      value.start < 0 ||
      value.end <= value.start ||
      value.end > duration
    ) {
      throw new Error(`Whisper returned an invalid word timestamp at index ${index}.`);
    }
    const previous = transcriptWords[index - 1];
    if (previous && value.start < previous.start) {
      throw new Error(`Whisper returned out-of-order word timestamps at index ${index}.`);
    }
    transcriptWords.push({
      word: value.word,
      start: value.start,
      end: value.end,
    });
  }

  return {transcriptText: response.text, transcriptWords};
}

export function mapWhisperWordsToTimeline(
  words: WhisperWord[],
  chunkOffset: number,
  chunkDuration: number,
): WhisperWord[] {
  if (!Number.isFinite(chunkOffset) || chunkOffset < 0) {
    throw new Error("Audio chunk has an invalid timeline offset.");
  }
  if (!Number.isFinite(chunkDuration) || chunkDuration <= 0) {
    throw new Error("Audio chunk has an invalid duration.");
  }
  if (words.some((word) =>
    !Number.isFinite(word.start) ||
    !Number.isFinite(word.end) ||
    word.start < 0 ||
    word.end <= word.start ||
    word.end > chunkDuration,
  )) {
    throw new Error("Whisper returned timestamps outside the extracted audio chunk.");
  }
  return words.map((word) => ({
    ...word,
    start: word.start + chunkOffset,
    end: word.end + chunkOffset,
  }));
}

export function appendWhisperChunkWords(
  previousWords: WhisperWord[],
  chunkWords: WhisperWord[],
  chunkBoundary: number,
): WhisperWord[] {
  const merged = [...previousWords];
  const previousChunkLastWord = merged[merged.length - 1];
  for (const word of chunkWords) {
    const sameWord = previousChunkLastWord?.word.trim().toLowerCase() ===
      word.word.trim().toLowerCase();
    const duplicateAtBoundary = previousChunkLastWord &&
      sameWord &&
      Math.abs(previousChunkLastWord.start - word.start) <= 0.05 &&
      Math.abs(previousChunkLastWord.end - word.end) <= 0.05 &&
      Math.abs(word.start - chunkBoundary) <= 0.25;
    if (duplicateAtBoundary) continue;

    if (
      previousChunkLastWord &&
      word.start < previousChunkLastWord.end &&
      previousChunkLastWord.end > chunkBoundary - 0.25 &&
      word.start < chunkBoundary + 0.25
    ) {
      throw new Error("Whisper returned overlapping word timestamps at an audio chunk boundary.");
    }
    merged.push(word);
  }
  return merged;
}
