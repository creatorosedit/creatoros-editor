import React from "react";

export function CaptionOverlay({
  text, style = "classic", timelineTime, start, end
}: {
  text: string, style?: string, timelineTime: number, start: number, end: number
}) {
  if (!text) return null;

  // Calculate Active Word for Karaoke
  const words = text.split(" ");
  let activeIndex = -1;
  if (start !== undefined && end !== undefined && timelineTime >= start && timelineTime <= end) {
    const progress = (timelineTime - start) / (end - start);
    activeIndex = Math.min(Math.floor(progress * words.length), words.length - 1);
  }

  const baseClass = "absolute bottom-[15%] left-0 w-full text-center px-4 pointer-events-none z-[90] flex justify-center flex-wrap gap-x-2 gap-y-1";

  let containerStyle: any = {};
  let wordStyle: any = {};
  let activeStyle: any = {};
  let className = "";

  switch (style) {
    case "karaoke":
      className = "text-3xl font-black font-sans uppercase";
      wordStyle = { color: "white", textShadow: "2px 2px 0 #000" };
      activeStyle = { color: "#4ECDC4", textShadow: "2px 2px 0 #000", transform: "scale(1.1)" };
      break;
    case "emphasis":
      className = "text-2xl font-bold font-serif";
      wordStyle = { color: "#ddd" };
      activeStyle = { color: "white", fontSize: "1.5em", textShadow: "0px 0px 10px rgba(255,255,255,0.5)" };
      break;
    case "impact":
      className = "text-4xl font-black font-mono uppercase italic";
      containerStyle = { WebkitTextStroke: "1px black", textShadow: "3px 3px 0 #000" };
      wordStyle = { color: "white" };
      activeStyle = { color: "#FF6B6B" };
      break;
    case "classic":
    default:
      // Fallback to simple box
      return (
        <div className="absolute bottom-[15%] left-0 w-full text-center px-4 pointer-events-none z-[90] flex justify-center">
          <span className="bg-black/80 text-white px-4 py-2 rounded-lg text-xl font-bold border border-white/10">{text}</span>
        </div>
      );
  }

  return (
    <div className={baseClass} style={containerStyle}>
      {words.map((w, i) => (
        <span
          key={i}
          className={`${className} transition-all duration-100`}
          style={i === activeIndex ? { ...wordStyle, ...activeStyle } : wordStyle}
        >
          {w}
        </span>
      ))}
    </div>
  );
}
