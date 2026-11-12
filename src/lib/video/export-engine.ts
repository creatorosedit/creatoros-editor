import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

let ffmpegInstance: FFmpeg | null = null;

export async function getFFmpeg(onLog?: (msg: string) => void) {
  if (ffmpegInstance) return ffmpegInstance;

  const ffmpeg = new FFmpeg();
  if (onLog) ffmpeg.on("log", ({ message }) => onLog(message));

  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });

  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

export interface ExportClip {
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  speed?: number;
}

export interface ExportBroll {
  url: string;
  start: number;
  end: number;
  layout: string;
  assetType: string;
}

export interface ExportCaption {
  text: string;
  start: number;
  end: number;
}

export async function renderVideo(
  videoFile: File,
  clips: ExportClip[],
  filters: { brightness: number, contrast: number, saturation: number },
  captions: ExportCaption[],
  brolls: ExportBroll[],
  audioClips: { url: string, start: number, end: number, volume: number, track: string }[],
  onProgress: (p: number) => void
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(console.log);
  const onProgressUpdate = ({ progress }: {progress: number}) => {
    onProgress(Math.round(progress * 100));
  };
  ffmpeg.on("progress", onProgressUpdate);

  const extension = videoFile.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "mp4";
  const inputName = `input.${extension}`;
  const inputDirectory = "/source";
  const inputPath = `${inputDirectory}/${inputName}`;
  const outputName = "output.mp4";
  const temporaryFiles = new Set<string>();

  const directoryCreated = await ffmpeg.createDir(inputDirectory);
  if (!directoryCreated) {
    throw new Error("FFmpeg could not prepare local media storage.");
  }
  let inputMounted = false;
  try {
    const mounted = await ffmpeg.mount(
      FFFSType.WORKERFS,
      { blobs: [{ name: inputName, data: videoFile }] },
      inputDirectory,
    );
    if (!mounted) {
      throw new Error("This browser cannot render the local video without copying it into memory.");
    }
    inputMounted = true;

    // 1. Handle B-Rolls (Load files and build inputs array)
    const args = ["-i", inputPath];
    const validBrolls: any[] = [];

    for (const b of brolls) {
      if (!b || !b.url) continue;

      const ext = b.assetType === 'image' ? 'png' : 'mp4';
      const bName = `broll_${Math.random().toString(36).substring(7)}.${ext}`;

      try {
        const bRes = await fetch(b.url);
        const bBlob = await bRes.blob();
        temporaryFiles.add(bName);
        await ffmpeg.writeFile(bName, new Uint8Array(await bBlob.arrayBuffer()));

        args.push("-i", bName);
        validBrolls.push({ ...b, ffmpegIndex: args.length / 2, bName: bName });
      } catch (err) {
        console.error("Failed to load broll:", b.url, err);
      }
    }

    // 2. Build Filter Complex
    let filterComplex = "";
    let concatInputs = "";

    clips.forEach((clip, index) => {
      filterComplex += `[0:v]trim=start=${clip.sourceStart}:end=${clip.sourceEnd},setpts=PTS-STARTPTS[v${index}];`;
      filterComplex += `[0:a]atrim=start=${clip.sourceStart}:end=${clip.sourceEnd},asetpts=PTS-STARTPTS[a${index}];`;
      concatInputs += `[v${index}][a${index}]`;
    });

    filterComplex += `${concatInputs}concat=n=${clips.length}:v=1:a=1[v_concat][a_concat];`;
    filterComplex += `[v_concat]eq=brightness=${filters.brightness / 100 - 1}:contrast=${filters.contrast / 100}:saturation=${filters.saturation / 100}[v_graded];`;

    let currentVideoMap = "[v_graded]";

    // Apply B-Rolls (Overlays)
    for (let i = 0; i < validBrolls.length; i++) {
      const b = validBrolls[i];
      const scaleFilter = b.layout === 'full' ? "scale=1080:1920" : "scale=iw*0.4:ih*0.4";
      const overlayPos = b.layout === 'full' ? "x=0:y=0" : "x=W-w-20:y=20";

      filterComplex += `[${b.ffmpegIndex}:v]${scaleFilter}[b${i}];`;
      filterComplex += `${currentVideoMap}[b${i}]overlay=${overlayPos}:enable='between(t,${b.start},${b.end})'[v_out${i}];`;
      currentVideoMap = `[v_out${i}]`;
    }

    // Apply Captions
    const srtName = "captions.srt";
    const hasCaptions = captions && captions.length > 0;

    if (hasCaptions) {
      let srtContent = "";
      captions.forEach((c, i) => {
        const formatTime = (sec: number) => {
          const date = new Date(0);
          date.setMilliseconds(sec * 1000);
          return date.toISOString().substr(11, 12).replace('.', ',');
        };
        srtContent += `${i + 1}\n${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.text}\n\n`;
      });
      temporaryFiles.add(srtName);
      await ffmpeg.writeFile(srtName, new TextEncoder().encode(srtContent));
      filterComplex += `${currentVideoMap}subtitles=${srtName}[v_final]`;
    } else {
      filterComplex += `${currentVideoMap}null[v_final]`;
    }


    // 3. Handle Audio Clips (Music & SFX)
    const validAudio: any[] = [];
    for (const a of audioClips) {
      if (!a || !a.url) continue;

      const aName = `audio_${Math.random().toString(36).substring(7)}.mp3`;
      try {
        const aRes = await fetch(a.url);
        const aBlob = await aRes.blob();
        temporaryFiles.add(aName);
        await ffmpeg.writeFile(aName, new Uint8Array(await aBlob.arrayBuffer()));

        args.push("-i", aName);
        validAudio.push({ ...a, ffmpegIndex: (args.length / 2) - 1, aName });
      } catch (err) {
        console.error("Failed to load audio:", a.url, err);
      }
    }

    // Build Audio Mixing Filter
    let audioMixInputs = "[a_concat]";
    let audioMixFilter = "";

    if (validAudio.length > 0) {
      validAudio.forEach((a, i) => {
        const delayMs = Math.max(0, Math.floor(a.start * 1000));
        // Delay the audio to its start time and adjust volume
        audioMixFilter += `[${a.ffmpegIndex}:a]adelay=${delayMs}|${delayMs},volume=${a.volume}[a${i}];`;
        audioMixInputs += `[a${i}]`;
      });
      // Mix all audio tracks together (original voice + music + sfx)
      audioMixFilter += `${audioMixInputs}amix=inputs=${validAudio.length + 1}:duration=first:dropout_transition=0[a_final_mix]`;
    } else {
      audioMixFilter += `[a_concat]anull[a_final_mix]`;
    }

    filterComplex += audioMixFilter + ";";

    // Update the mapping to use the mixed audio
    // (we will do this in the args section below)

    // 4. Execute FFmpeg
    const execArgs = [
      ...args,
      "-filter_complex", filterComplex,
      "-map", "[v_final]",
      "-map", "[a_final_mix]",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-c:a", "aac",
      outputName
    ];

    temporaryFiles.add(outputName);
    await ffmpeg.exec(execArgs);

    const data = await ffmpeg.readFile(outputName);
    const blob = new Blob([data as any], { type: "video/mp4" });
    return blob;
  } finally {
    try {
      const entries = await ffmpeg.listDir("/");
      for (const entry of entries) {
        if (temporaryFiles.has(entry.name)) await ffmpeg.deleteFile(entry.name);
      }
    } finally {
      try {
        if (inputMounted) await ffmpeg.unmount(inputDirectory);
      } finally {
        try {
          await ffmpeg.deleteDir(inputDirectory);
        } finally {
          ffmpeg.off("progress", onProgressUpdate);
        }
      }
    }
  }
}
