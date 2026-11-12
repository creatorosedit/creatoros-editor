import React, { useState, useRef, useEffect } from "react";
import { ArrowLeft, Send, Bot, Sparkles, Menu, Plus } from "lucide-react";
import type { EditorContext } from "@/lib/editor/editor-context";
import { authenticatedApiFetch } from "@/lib/firebase/api-fetch";

interface Message { role: "user"|"ai", text: string }
interface ChatSession { id: string, title: string, updatedAt: number, messages: Message[] }

interface EditorContextSummary {
  projectId: string | null;
  videoFilename: string | null;
  timelineClipCount: number;
  selectedClipIds: string[];
  selectedRange: EditorContext["selectedRange"];
  synchronizationStatus: EditorContext["synchronizationStatus"];
}

export const AIChatPanel = React.memo(function AIChatPanel({
  onClose,
  onCancelAutoCut,
  selectedClipTime,
  editorContextSummary,
  getEditorContext,
  videoContext
}: {
  onClose: () => void,
  onCancelAutoCut?: () => void,
  selectedClipTime: string | null,
  editorContextSummary: EditorContextSummary,
  getEditorContext: () => EditorContext | null,
  videoContext?: {
    onAnalyzeCuts?: (script: string) => Promise<{
      suggestionCount: number;
      reviewableSilenceCount: number;
      analysisMode: "gemini" | "local";
      warning: string;
    }>;
  }
}) {

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const [input, setInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalyzingCuts, setIsAnalyzingCuts] = useState(false);
  const [waitingForScript, setWaitingForScript] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const cancelledAutoCutRef = useRef(false);

  const handleClose = () => {
    if (isAnalyzingCuts) cancelledAutoCutRef.current = true;
    onCancelAutoCut?.();
    onClose();
  };

  useEffect(() => () => {
    cancelledAutoCutRef.current = true;
    onCancelAutoCut?.();
  }, [onCancelAutoCut]);

  // Load Sessions
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("creatoros_sessions_v2");
      if (saved) {
        const parsed = JSON.parse(saved);
        setSessions(parsed);
        if (parsed.length > 0) setActiveSessionId(parsed[0].id);
      } else {
        createNewSession();
      }
    }
  }, []);

  // Save Sessions (Keeps ONLY latest 5)
  const saveSessions = (newSessions: ChatSession[]) => {
    const sorted = newSessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
    setSessions(sorted);
    localStorage.setItem("creatoros_sessions_v2", JSON.stringify(sorted));
  };

  const createNewSession = () => {
    const newSession: ChatSession = { id: Date.now().toString(), title: "New Chat", updatedAt: Date.now(), messages: [] };
    const newSessions = [newSession, ...sessions];
    saveSessions(newSessions);
    setActiveSessionId(newSession.id);
    setIsSidebarOpen(false);
    setWaitingForScript(false);
  };

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const messages = activeSession?.messages || [];

  const updateMessages = (newMsgs: Message[]) => {
    if (!activeSessionId) return;
    const newSessions = sessions.map(s => {
      if (s.id === activeSessionId) {
        let title = s.title;
        if (title === "New Chat" && newMsgs.length > 0 && newMsgs[0]?.role === "user") {
           title = (newMsgs[0]?.text || "Chat").substring(0, 25) + "...";
        }
        return { ...s, title, messages: newMsgs, updatedAt: Date.now() };
      }
      return s;
    });
    saveSessions(newSessions);
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading || !activeSessionId) return;

    const lowerInput = input.toLowerCase();

    // --- CHAT-DRIVEN AUTO CUT FLOW ---
    if ((lowerInput.includes("cut") || lowerInput.includes("kaat")) && !waitingForScript) {
      const userMsg = input;
      updateMessages([
        ...messages,
        { role: "user", text: userMsg },
        { role: "ai", text: "Zaroor! Main cuts lagane ke liye taiyaar hoon. Par pehle mujhe tumhari **Original Script** chahiye taaki main duplicate aur filler words dhundh sakoon.\n\nKripya apni script niche chat me paste kar do." }
      ] as Message[]);
      setInput("");
      setWaitingForScript(true);
      return;
    }

    if (waitingForScript) {
      const providedScript = input;
      updateMessages([...messages, { role: "user", text: "Script provided." }] as Message[]);
      setInput("");
      setWaitingForScript(false);
      setIsLoading(true);
      setIsAnalyzingCuts(true);
      cancelledAutoCutRef.current = false;

      try {
        if (!videoContext?.onAnalyzeCuts) throw new Error("Import a video before analyzing cuts.");
        const { suggestionCount, reviewableSilenceCount, analysisMode, warning } =
          await videoContext.onAnalyzeCuts(providedScript);
        setIsAnalyzingCuts(false);
        updateMessages([
          ...messages,
          { role: "user", text: "Script provided." },
          {
            role: "ai",
            text: `Timeline transcript ko script se compare kiya (${analysisMode === "gemini" ? "Gemini" : "local"} analysis). ${reviewableSilenceCount} silence candidates aur ${suggestionCount} filler/retake suggestions review ke liye mark kiye hain. Koi silence automatically cut nahi hui.${warning ? ` ${warning}` : ""}`,
          }
        ] as Message[]);
        onClose();
      } catch (error: unknown) {
        if (
          cancelledAutoCutRef.current ||
          (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
        ) return;
        setIsLoading(false);
        setIsAnalyzingCuts(false);
        const message = error instanceof Error ? error.message : "Could not analyze cuts.";
        updateMessages([
          ...messages,
          { role: "user", text: "Script provided." },
          { role: "ai", text: "Error analyzing cuts: " + message }
        ] as Message[]);
      }
      return;
    }

    // --- NORMAL AI CHAT ---
    setIsLoading(true);
    setChatError(null);

    try {
      const res = await authenticatedApiFetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: input,
          context: selectedClipTime ? `Clip ${selectedClipTime}` : "General",
          editorContext: getEditorContext()
        })
      });

      const result: unknown = await res.json();
      if (
        !res.ok ||
        typeof result !== "object" ||
        result === null ||
        !("text" in result) ||
        typeof result.text !== "string"
      ) {
        const message = typeof result === "object" && result !== null &&
          "error" in result && typeof result.error === "string"
          ? result.error
          : `AI chat failed (HTTP ${res.status}).`;
        throw new Error(message);
      }
      updateMessages([
        ...messages,
        { role: "user", text: input },
        { role: "ai", text: result.text },
      ]);
      setInput("");
    } catch (error: unknown) {
      setChatError(error instanceof Error ? error.message : "AI chat failed. Your message is still available to retry.");
      console.error("AI chat failed:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#0f0f11] z-[200] flex flex-col text-white font-sans">

      {/* Sidebar */}
      {isSidebarOpen && (
        <div className="absolute inset-0 bg-black/60 z-[210] backdrop-blur-sm" onClick={() => setIsSidebarOpen(false)}>
          <div className="w-64 h-full bg-[#1a1a1e] p-4 flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <button onClick={createNewSession} className="flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-500 text-white py-2.5 px-4 rounded-xl mb-6 transition font-medium">
              <Plus size={18} /> New Chat
            </button>
            <h3 className="text-xs text-zinc-500 font-semibold mb-3 uppercase tracking-wider">Recent (Max 5)</h3>
            <div className="flex-1 overflow-y-auto space-y-2">
              {sessions.map(s => (
                <button key={s.id} onClick={() => { setActiveSessionId(s.id); setIsSidebarOpen(false); }} className={`w-full text-left p-3 rounded-lg text-sm truncate transition ${activeSessionId === s.id ? "bg-zinc-800 text-teal-400" : "text-zinc-400 hover:bg-zinc-800/50"}`}>
                  {s.title}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-[#0f0f11]/90 backdrop-blur-md border-b border-zinc-800/50">
        <div className="flex items-center gap-1">
          <button onClick={() => setIsSidebarOpen(true)} className="p-2 hover:bg-zinc-800 rounded-full transition"><Menu size={20} /></button>
          <button onClick={handleClose} className="p-2 hover:bg-zinc-800 rounded-full transition"><ArrowLeft size={20} /></button>
        </div>
        <div className="flex flex-col items-center">
          <h2 className="text-sm font-semibold flex items-center gap-1 text-teal-400"><Sparkles size={14} /> AI Director</h2>
          <div className="text-xs text-zinc-500 mt-1 font-medium flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full ${editorContextSummary.synchronizationStatus === "error" ? "bg-red-500" : editorContextSummary.synchronizationStatus === "loading" ? "bg-amber-400" : "bg-green-500"}`}></span>
            {editorContextSummary.synchronizationStatus === "loading"
              ? "Syncing editor context…"
              : editorContextSummary.synchronizationStatus === "error"
                ? "Context sync error"
                : editorContextSummary.videoFilename
                ? `${editorContextSummary.videoFilename} · ${editorContextSummary.timelineClipCount} timeline clips`
                : "No active video"}
          </div>
          {editorContextSummary.videoFilename && (
            <div className="mt-1 text-[10px] text-zinc-600">
              {editorContextSummary.selectedClipIds.length > 0
                ? `Selected clip ${editorContextSummary.selectedClipIds[0]}`
                : "No clip selected"}
              {editorContextSummary.selectedRange && (
                ` · Range ${editorContextSummary.selectedRange.in ?? "—"}–${editorContextSummary.selectedRange.out ?? "—"}s`
              )}
            </div>
          )}
        </div>
        <div className="w-16" />
      </div>

      {/* Chat Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6 pb-24">
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center opacity-80 mt-20 h-full">
            <Bot size={48} className="text-teal-500 mb-4 opacity-50" />
            <h1 className="text-2xl font-bold mb-2">Hi, What's on your mind today?</h1>
            <p className="text-zinc-400 text-sm max-w-[250px]">Ask me to analyze your video or modify specific clips.</p>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] p-4 rounded-2xl text-[15px] leading-relaxed ${msg.role === "user" ? "bg-zinc-800 rounded-tr-sm" : "bg-transparent text-zinc-200"}`}>
                {msg.text}
              </div>
            </div>
          ))
        )}
        {isLoading && (
          <div className="flex justify-start">
            <div className="flex items-center gap-3 text-teal-400 text-sm">
              <span className="animate-pulse flex items-center gap-2"><Bot size={16} /> AI is typing...</span>
              {isAnalyzingCuts && (
                <button
                  type="button"
                  onClick={() => {
                    cancelledAutoCutRef.current = true;
                    onCancelAutoCut?.();
                    setIsAnalyzingCuts(false);
                    setIsLoading(false);
                  }}
                  className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                >
                  Cancel analysis
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-[#0f0f11] border-t border-zinc-800/50 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {chatError && <p role="alert" className="mx-auto mb-2 max-w-3xl text-sm text-amber-300">{chatError}</p>}
        <div className="flex items-end gap-2 bg-[#1a1a1e] rounded-2xl p-2 border border-zinc-700/50 shadow-lg focus-within:border-zinc-500 transition-colors">
          <button className="p-2 text-zinc-400 hover:text-white transition"><span className="text-2xl leading-none font-light">+</span></button>
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setChatError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={waitingForScript ? 5 : 1}
            placeholder={waitingForScript ? "Paste the original script..." : "Type a message..."}
            className="flex-1 resize-none bg-transparent border-none text-[15px] focus:outline-none text-white placeholder-zinc-500 py-2"
          />
          <button onClick={handleSend} disabled={!input.trim() || isLoading} className={`p-2 rounded-full transition ${input.trim() ? "bg-teal-500 text-white" : "bg-zinc-800 text-zinc-500"}`}>
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
});
