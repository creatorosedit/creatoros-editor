import React from "react";
import { X } from "lucide-react";

export function BrollInspector({
  broll, onUpdate, onClose
}: {
  broll: any, onUpdate: (updates: any) => void, onClose: () => void
}) {
  if (!broll) return null;

  const handleChange = (field: string, value: number) => {
    onUpdate({ [field]: value });
  };

  return (
    <div className="absolute right-4 top-32 w-72 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl z-[110] p-4 text-white">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-sm text-teal-400">Manual B-Roll Edit</h3>
        <button onClick={onClose} className="p-1 hover:bg-zinc-800 rounded transition"><X size={16} /></button>
      </div>

      <div className="space-y-4 text-xs">
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-zinc-400 block mb-1">Start (s)</label>
            <input type="number" step="0.1" value={broll.start} onChange={e => handleChange('start', Number(e.target.value))} className="w-full bg-zinc-800 p-1.5 rounded border border-zinc-700" />
          </div>
          <div className="flex-1">
            <label className="text-zinc-400 block mb-1">End (s)</label>
            <input type="number" step="0.1" value={broll.end} onChange={e => handleChange('end', Number(e.target.value))} className="w-full bg-zinc-800 p-1.5 rounded border border-zinc-700" />
          </div>
        </div>

        <div>
          <label className="text-zinc-400 block mb-1">Scale ({broll.transform?.scale?.toFixed(2) || 1})</label>
          <input type="range" min="0.1" max="2" step="0.05" value={broll.transform?.scale || 1} onChange={e => onUpdate({ transform: { ...broll.transform, scale: Number(e.target.value) } })} className="w-full accent-teal-500" />
        </div>

        <div>
          <label className="text-zinc-400 block mb-1">Opacity ({Math.round((broll.transform?.opacity || 1) * 100)}%)</label>
          <input type="range" min="0" max="1" step="0.1" value={broll.transform?.opacity || 1} onChange={e => onUpdate({ transform: { ...broll.transform, opacity: Number(e.target.value) } })} className="w-full accent-teal-500" />
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-zinc-400 block mb-1">X Pos</label>
            <input type="number" step="0.1" value={broll.transform?.x || 0} onChange={e => onUpdate({ transform: { ...broll.transform, x: Number(e.target.value) } })} className="w-full bg-zinc-800 p-1.5 rounded border border-zinc-700" />
          </div>
          <div className="flex-1">
            <label className="text-zinc-400 block mb-1">Y Pos</label>
            <input type="number" step="0.1" value={broll.transform?.y || 0} onChange={e => onUpdate({ transform: { ...broll.transform, y: Number(e.target.value) } })} className="w-full bg-zinc-800 p-1.5 rounded border border-zinc-700" />
          </div>
        </div>
      </div>
    </div>
  );
}
