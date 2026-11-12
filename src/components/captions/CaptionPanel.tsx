import React, { useState, useRef } from "react";
import { X, Loader2, Upload } from "lucide-react";

export function CaptionPanel({
  onClose, onGenerate, style, setStyle, wordsPerLine, setWordsPerLine, onImportSRT
}: {
  onClose: () => void, onGenerate: (lang: string) => Promise<void>, style: string, setStyle: (s: string) => void, wordsPerLine: number, setWordsPerLine: (n: number) => void, onImportSRT: (file: File) => void
}) {
  const lang = "hinglish";
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleGenerate = async () => {
    setLoading(true);
    await onGenerate(lang);
    setLoading(false);
  };

  return (
    <div className="absolute right-4 top-20 w-80 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl z-[100] p-5 text-white">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-base flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-teal-500 animate-pulse"></span>
          Pro Captions
        </h3>
        <button onClick={onClose} className="p-1.5 hover:bg-zinc-800 rounded-md transition"><X size={16} /></button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="text-xs text-zinc-400 font-medium mb-1 block">Words Per Line</label>
          <div className="flex gap-2 bg-zinc-800 p-1 rounded-lg">
            {[1, 2, 4].map(n => (
              <button key={n} onClick={() => setWordsPerLine(n)} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition ${wordsPerLine === n ? 'bg-teal-600 text-white' : 'text-zinc-400 hover:text-white'}`}>
                {n} Word{n > 1 ? 's' : ''}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-zinc-400 font-medium mb-1 block">Style / Font</label>
          <select value={style} onChange={(e) => setStyle(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-2.5 text-sm outline-none focus:border-teal-500 transition">
            <option value="classic">Classic Box</option>
            <option value="karaoke">Karaoke Highlight (Teal)</option>
            <option value="emphasis">Emphasis (Big Active Word)</option>
            <option value="impact">Impact (Mono/Italic)</option>
          </select>
        </div>

        <div className="pt-2 border-t border-zinc-800">
          <button onClick={() => fileInputRef.current?.click()} className="w-full bg-zinc-800 hover:bg-zinc-700 text-teal-400 border border-teal-500/30 py-2.5 rounded-lg text-sm font-medium flex justify-center items-center gap-2 transition">
            <Upload size={16} /> Import .SRT
          </button>
          <input type="file" accept=".srt,.vtt" ref={fileInputRef} className="hidden" onChange={(e) => {
            if (e.target.files && e.target.files[0]) {
              onImportSRT(e.target.files[0]);
            }
          }} />
        </div>

        <div className="pt-2 border-t border-zinc-800">
          <button onClick={handleGenerate} disabled={loading} className="w-full bg-teal-600 hover:bg-teal-500 text-white py-2.5 rounded-lg text-sm font-medium flex justify-center items-center gap-2 transition">
            {loading ? <Loader2 className="animate-spin" size={18} /> : "Generate with AI"}
          </button>
        </div>
      </div>
    </div>
  );
}
