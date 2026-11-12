# CreatorOS Editor

CreatorOS is a local-first video editor for a private team. Video and editing assets remain in browser OPFS; project metadata is shared through Firebase Firestore. Shared metadata does not include source media or a complete shared timeline.

## Free-only integrations

- Firebase Anonymous Authentication and Firestore are intended to run on Spark free quotas. Quota exhaustion stops shared operations; the application does not upgrade billing.
- AI requests use only the server-allowlisted Gemini Developer API model. Gemini's free tier is limited, and quotas or availability may change. There is no paid-provider fallback.
- Groq transcription, OpenRouter, Pexels, Jamendo, Freesound, and external asset downloads are disabled.
- Rendering and editing use browser-side FFmpeg. Source media is not uploaded automatically.

See [docs/free-only-policy.md](./docs/free-only-policy.md) for setup requirements, limitations, and unresolved account/deployment costs. Do not link Firebase or Gemini projects to billing for this application.