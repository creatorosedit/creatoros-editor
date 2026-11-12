import React from "react";
import { X } from "lucide-react";

export function EffectsPanel({
  onClose, brightness, setBrightness, contrast, setContrast, saturation, setSaturation
}: {
  onClose: () => void, brightness: number, setBrightness: (v: number) => void,
  contrast: number, setContrast: (v: number) => void,
  saturation: number, setSaturation: (v: number) => void
}) {
  return (
    <div className="absolute right-4 top-20 w-72 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl z-[100] p-5 text-white">
      <div className="flex justify-between items-center mb-5">
        <h3 className="font-semibold text-base">Color & Effects</h3>
        <button onClick={onClose} className="p-1.5 hover:bg-zinc-800 rounded-md transition"><X size={16} /></button>
      </div>
      <div className="space-y-5">
        <div>
          <label className="text-xs text-zinc-400 block mb-1">Brightness ({brightness}%)</label>
          <input type="range" min="50" max="150" value={brightness} onChange={e => setBrightness(Number(e.target.value))} className="w-full accent-teal-500" />
        </div>
        <div>
          <label className="text-xs text-zinc-400 block mb-1">Contrast ({contrast}%)</label>
          <input type="range" min="50" max="150" value={contrast} onChange={e => setContrast(Number(e.target.value))} className="w-full accent-teal-500" />
        </div>
        <div>
          <label className="text-xs text-zinc-400 block mb-1">Saturation ({saturation}%)</label>
          <input type="range" min="0" max="200" value={saturation} onChange={e => setSaturation(Number(e.target.value))} className="w-full accent-teal-500" />
        </div>
        <button onClick={() => { setBrightness(100); setContrast(100); setSaturation(100); }} className="w-full mt-2 bg-zinc-800 hover:bg-zinc-700 py-2 rounded text-xs transition">Reset to Normal</button>
      </div>
    </div>
  );
}
