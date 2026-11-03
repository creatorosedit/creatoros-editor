# Editor.app

## Magic Edit and asset search

Magic Edit creates a reviewable Zoom, B-roll, SFX, and Music plan from the current script/transcript and video duration. Search results can be attached to plan items and are saved in the browser's Origin Private File System (OPFS).

Asset search uses these optional server-side environment variables:

- `PEXELS_API_KEY` for video, image, and AI-tab search
- `JAMENDO_CLIENT_ID` for music search
- `FREESOUND_API_KEY` for sound-effect search

When a provider key is not configured, its search tab returns sample results for UI testing. Plan generation uses `OPENROUTER_API_KEY` and falls back to `GROQ_API_KEY_EDIT`.