"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { collection, deleteDoc, doc, getDocs, query, setDoc, where } from "firebase/firestore";
import {
  AlertCircle,
  ChevronRight,
  CircleUserRound,
  Clapperboard,
  Clock3,
  Film,
  FileJson,
  LoaderCircle,
  Play,
  Plus,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { db } from "@/lib/firebase/client";
import { getGuestId } from "@/lib/guest";
import { deleteVideoFromOPFS, getVideoFromOPFS, saveVideoToOPFS } from "@/lib/video/opfs";

const ASPECT_RATIOS = ["9:16", "16:9", "1:1", "4:5"] as const;
type AspectRatio = (typeof ASPECT_RATIOS)[number];
type Draft = {
  id: string;
  topic: string;
  brandName: string;
  status: string;
  createdAt: number;
  aspectRatio: AspectRatio;
};

function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === "string" && ASPECT_RATIOS.some((ratio) => ratio === value);
}

async function createVideoThumbnail(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Thumbnail generation timed out.")), 12_000);
      video.addEventListener("loadeddata", () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
      video.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("Could not read the project video thumbnail."));
      }, { once: true });
      video.load();
    });
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    if (!context || !video.videoWidth || !video.videoHeight) throw new Error("Could not create a project thumbnail.");
    context.fillStyle = "#151a1a";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const cropWidth = canvas.width / scale;
    const cropHeight = canvas.height / scale;
    context.drawImage(
      video,
      (video.videoWidth - cropWidth) / 2,
      (video.videoHeight - cropHeight) / 2,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas.toDataURL("image/jpeg", 0.72);
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export default function Dashboard() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [guestId, setGuestId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [selectedRatio, setSelectedRatio] = useState<AspectRatio>("9:16");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showRatioModal, setShowRatioModal] = useState(false);
  const [showActionModal, setShowActionModal] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchDrafts = useCallback(async (ownerId: string) => {
    setLoadError(null);
    setLoading(true);
    try {
      const draftsQuery = query(collection(db, "drafts"), where("createdBy", "==", ownerId));
      const snapshot = await getDocs(draftsQuery);
      const fetched = snapshot.docs.map((entry) => {
        const data = entry.data();
        return {
          id: typeof data.id === "string" ? data.id : entry.id,
          topic: typeof data.topic === "string" ? data.topic : "Untitled Video",
          brandName: typeof data.brandName === "string" ? data.brandName : "CreatorOS Edit",
          status: typeof data.status === "string" ? data.status : "in_progress",
          createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
          aspectRatio: isAspectRatio(data.aspectRatio) ? data.aspectRatio : "9:16",
        } satisfies Draft;
      }).sort((first, second) => second.createdAt - first.createdAt);
      setDrafts(fetched);
      setLoading(false);

      const previewEntries = await Promise.all(fetched.map(async (draft) => {
        try {
          const file = await getVideoFromOPFS(draft.id);
          return file ? [draft.id, await createVideoThumbnail(file)] as const : null;
        } catch (error: unknown) {
          console.error(`Could not load thumbnail for project ${draft.id}:`, error);
          return null;
        }
      }));
      setThumbnails(Object.fromEntries(previewEntries.filter((entry): entry is readonly [string, string] => entry !== null)));
    } catch (error: unknown) {
      console.error("Could not load recent projects:", error);
      setLoadError(error instanceof Error ? error.message : "Could not load recent projects.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    try {
      setGuestId(getGuestId());
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : "Could not open your local workspace.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (guestId) void fetchDrafts(guestId);
  }, [fetchDrafts, guestId]);

  const createProject = async (file: File, aspectRatio: AspectRatio) => {
    setUploadError(null);
    setIsCreating(true);
    const draftId = crypto.randomUUID();
    try {
      const ownerId = guestId || getGuestId();
      if (!await saveVideoToOPFS(draftId, file)) throw new Error("Could not save this video to local storage.");
      const topic = file.name.replace(/\.[^.]+$/, "") || "Untitled Video";
      try {
        await setDoc(doc(db, "drafts", draftId), {
          id: draftId,
          brandName: "CreatorOS Edit",
          topic,
          createdBy: ownerId,
          createdAt: Date.now(),
          status: "in_progress",
          aspectRatio,
        });
      } catch (error: unknown) {
        await deleteVideoFromOPFS(draftId);
        throw error;
      }
      router.push(`/studio?draftId=${encodeURIComponent(draftId)}&format=${encodeURIComponent(aspectRatio)}&topic=${encodeURIComponent(topic)}`);
    } catch (error: unknown) {
      console.error("Could not create a project from this video:", error);
      setUploadError(error instanceof Error ? error.message : "Could not create this project.");
      setIsCreating(false);
    }
  };

  const createBlankProject = async () => {
    setIsCreating(true);
    setUploadError(null);
    const draftId = crypto.randomUUID();
    try {
      const ownerId = guestId || getGuestId();
      const topic = "Untitled Video";
      await setDoc(doc(db, "drafts", draftId), {
        id: draftId,
        brandName: "CreatorOS Edit",
        topic,
        createdBy: ownerId,
        createdAt: Date.now(),
        status: "in_progress",
        aspectRatio: selectedRatio,
      });
      router.push(`/studio?draftId=${encodeURIComponent(draftId)}&format=${encodeURIComponent(selectedRatio)}&topic=${encodeURIComponent(topic)}`);
    } catch (error: unknown) {
      console.error("Could not create a blank project:", error);
      setUploadError(error instanceof Error ? error.message : "Could not create a blank project.");
      setIsCreating(false);
    }
  };

  const deleteProject = async (draft: Draft) => {
    if (!window.confirm(`Delete "${draft.topic}"?`)) return;
    setDeletingId(draft.id);
    setUploadError(null);
    try {
      await deleteDoc(doc(db, "drafts", draft.id));
      await deleteVideoFromOPFS(draft.id);
      setDrafts((existing) => existing.filter((item) => item.id !== draft.id));
      setThumbnails((existing) => {
        const next = { ...existing };
        delete next[draft.id];
        return next;
      });
    } catch (error: unknown) {
      console.error("Could not delete the project:", error);
      setUploadError(error instanceof Error ? error.message : "Could not delete this project.");
    } finally {
      setDeletingId(null);
    }
  };

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSelectedFile(file);
    setShowActionModal(true);
  };

  const chooseAspectRatio = (ratio: AspectRatio) => {
    setSelectedRatio(ratio);
    setShowRatioModal(false);
    setUploadError(null);
    fileInputRef.current?.click();
  };

  const editSelectedVideo = () => {
    if (!selectedFile) return;
    setShowActionModal(false);
    void createProject(selectedFile, selectedRatio);
  };

  const openProject = (draft: Draft) => {
    router.push(`/studio?draftId=${encodeURIComponent(draft.id)}&format=${encodeURIComponent(draft.aspectRatio)}&topic=${encodeURIComponent(draft.topic)}`);
  };

  return (
    <main className="min-h-[100dvh] bg-[#0a0a0a] text-white">
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-white/[0.06] bg-[#0a0a0a]/95 px-5 backdrop-blur sm:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#4ECDC4] text-[#0a0a0a] shadow-[0_0_28px_rgba(78,205,196,0.25)]">
            <Clapperboard size={21} />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight">CreatorOS Edit</h1>
            <p className="text-[10px] text-gray-500">Your creative workspace</p>
          </div>
        </div>
        <div aria-label="Profile" title="Local workspace profile" className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-[#151818] text-gray-300">
          <CircleUserRound size={20} />
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-5 pb-16 pt-8 sm:px-8 sm:pt-12">
        <section>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.22em] text-[#4ECDC4]">Make something great</p>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Ready to create?</h2>
          <p className="mt-2 max-w-lg text-sm leading-6 text-gray-400">Start with a video and make every cut count.</p>
          <button
            type="button"
            onClick={() => setShowRatioModal(true)}
            disabled={isCreating}
            className="group relative mt-7 flex min-h-44 w-full flex-col items-center justify-center overflow-hidden rounded-3xl border border-dashed border-[#4ECDC4]/50 bg-gradient-to-br from-[#4ECDC4]/[0.12] via-[#111717] to-[#0d1212] px-6 text-center shadow-[0_0_60px_rgba(78,205,196,0.08)] transition hover:border-[#4ECDC4] hover:shadow-[0_0_70px_rgba(78,205,196,0.18)] disabled:opacity-50 sm:min-h-52"
          >
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(78,205,196,0.1),transparent_60%)] opacity-70 transition group-hover:opacity-100" />
            <span className="relative mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#4ECDC4] text-black shadow-[0_0_34px_rgba(78,205,196,0.38)]">
              {isCreating ? <LoaderCircle size={26} className="animate-spin" /> : <Upload size={26} />}
            </span>
            <span className="relative text-lg font-bold">{isCreating ? "Preparing your video…" : "Upload Media"}</span>
            <span className="relative mt-1 text-xs text-gray-400">Choose a video to start editing</span>
          </button>
          {uploadError && (
            <p role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-200">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />{uploadError}
            </p>
          )}
        </section>

        <section className="mt-12">
          <div className="mb-5 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold">Recent Projects</h2>
              <p className="mt-1 text-xs text-gray-500">{drafts.length} {drafts.length === 1 ? "project" : "projects"}</p>
            </div>
            <div className="flex items-center gap-3">
              <button type="button" onClick={createBlankProject} disabled={isCreating} className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-[#4ECDC4] disabled:opacity-50">
                <Plus size={13} /> Blank
              </button>
              <button type="button" onClick={() => router.push("/import")} className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-[#4ECDC4]">
                <FileJson size={13} /> Import
              </button>
              <Film size={19} className="text-[#4ECDC4]" />
            </div>
          </div>
          {loadError && (
            <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-200 sm:flex-row sm:items-center sm:justify-between">
              <span>Could not load recent projects: {loadError}</span>
              {guestId && <button type="button" onClick={() => void fetchDrafts(guestId)} className="rounded-lg border border-red-300/30 px-3 py-1.5 text-xs font-semibold hover:bg-red-500/10">Retry</button>}
            </div>
          )}
          {loading ? (
            <div className="flex min-h-40 items-center justify-center rounded-2xl border border-white/[0.06] bg-[#101313]">
              <LoaderCircle size={24} className="animate-spin text-[#4ECDC4]" />
            </div>
          ) : drafts.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-2xl border border-white/[0.06] bg-[#101313] px-6 text-center">
              <div className="mb-3 rounded-2xl bg-white/[0.04] p-3 text-gray-500"><Video size={22} /></div>
              <h3 className="text-sm font-semibold">Your projects will show up here</h3>
              <p className="mt-1 text-xs text-gray-500">Upload your first video to get started.</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {drafts.map((draft) => (
                <article key={draft.id} className="group flex min-w-0 items-center gap-3 rounded-2xl border border-white/[0.06] bg-[#111414] p-3 transition hover:border-[#4ECDC4]/40 hover:bg-[#141a1a]">
                  <button type="button" onClick={() => openProject(draft)} className="flex min-w-0 flex-1 items-center gap-4 text-left">
                    <span className="relative h-[76px] w-[112px] shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-[#1c2929] to-[#111]">
                      {thumbnails[draft.id] && <Image src={thumbnails[draft.id]!} alt="" fill sizes="112px" unoptimized className="object-cover" />}
                      <span className="absolute inset-0 flex items-center justify-center bg-black/10 text-white/90 transition group-hover:bg-black/25">
                        <Play size={19} fill="currentColor" />
                      </span>
                      <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold text-white">{draft.aspectRatio}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{draft.topic}</span>
                    <span className="mt-1 block truncate text-xs text-gray-500">{draft.brandName}</span>
                    <span className="mt-2 flex items-center gap-1 text-[10px] text-gray-600">
                      <Clock3 size={11} /> {draft.createdAt ? new Date(draft.createdAt).toLocaleDateString() : "Recent"}
                    </span>
                    </span>
                    <ChevronRight size={17} className="shrink-0 text-gray-600 transition group-hover:translate-x-0.5 group-hover:text-[#4ECDC4]" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteProject(draft)}
                    disabled={deletingId === draft.id}
                    aria-label={`Delete ${draft.topic}`}
                    className="rounded-lg p-2 text-gray-600 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                  >
                    {deletingId === draft.id ? <LoaderCircle size={16} className="animate-spin" /> : <Trash2 size={16} />}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleFileSelected} />

      {showRatioModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-5" onClick={() => setShowRatioModal(false)}>
          <section role="dialog" aria-modal="true" aria-labelledby="ratio-modal-title" onClick={(event) => event.stopPropagation()} className="w-full max-w-lg rounded-t-3xl border border-white/10 bg-[#111515] p-5 shadow-2xl sm:rounded-3xl sm:p-7">
            <header className="mb-6 flex items-start justify-between">
              <div>
                <h2 id="ratio-modal-title" className="text-lg font-bold">Select Aspect Ratio</h2>
                <p className="mt-1 text-xs text-gray-500">Choose a format for your new project.</p>
              </div>
              <button type="button" onClick={() => setShowRatioModal(false)} aria-label="Close aspect ratio selection" className="rounded-full p-2 text-gray-400 hover:bg-white/10"><X size={18} /></button>
            </header>
            <div className="grid grid-cols-2 gap-3">
              {ASPECT_RATIOS.map((ratio) => (
                <button
                  type="button"
                  key={ratio}
                  onClick={() => chooseAspectRatio(ratio)}
                  className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-[#0a0e0e] py-4 transition hover:border-[#4ECDC4] hover:bg-[#4ECDC4]/[0.06]"
                >
                  <span
                    style={{
                      aspectRatio: ratio.replace(":", " / "),
                      width: ratio === "16:9" ? "64px" : ratio === "1:1" ? "44px" : "40px",
                      height: ratio === "16:9" ? "36px" : ratio === "1:1" ? "44px" : ratio === "4:5" ? "50px" : "56px",
                    }}
                    className="block rounded border-2 border-[#4ECDC4] bg-[#4ECDC4]/10"
                  >
                    <span className="block h-full w-full" />
                  </span>
                  <span className="text-sm font-bold">{ratio}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {showActionModal && selectedFile && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-5" onClick={() => setShowActionModal(false)}>
          <section role="dialog" aria-modal="true" aria-labelledby="action-modal-title" onClick={(event) => event.stopPropagation()} className="w-full max-w-lg rounded-t-3xl border border-white/10 bg-[#111515] p-5 shadow-2xl sm:rounded-3xl sm:p-7">
            <header className="mb-6 flex items-start justify-between">
              <div>
                <h2 id="action-modal-title" className="text-lg font-bold">Video Selected</h2>
                <p className="mt-1 max-w-[75vw] truncate text-xs text-gray-400">{selectedFile.name}</p>
              </div>
              <button type="button" onClick={() => setShowActionModal(false)} aria-label="Close video actions" className="rounded-full p-2 text-gray-400 hover:bg-white/10"><X size={18} /></button>
            </header>
            <div className="mb-5 flex items-center justify-between rounded-xl border border-white/[0.06] bg-[#0a0e0e] px-4 py-3 text-xs">
              <span className="text-gray-500">Project format</span><span className="font-semibold text-[#4ECDC4]">{selectedRatio}</span>
            </div>
            <button type="button" onClick={editSelectedVideo} disabled={isCreating} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#4ECDC4] px-4 py-4 text-sm font-bold text-black shadow-[0_0_30px_rgba(78,205,196,0.16)] disabled:opacity-50">
              {isCreating ? <LoaderCircle size={17} className="animate-spin" /> : <Clapperboard size={17} />}
              Edit Now
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
