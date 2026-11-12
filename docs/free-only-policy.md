# Free-only operating policy

CreatorOS is intended for a private team of 2–5 approved members. The application does not enable billing, upgrade a plan, or switch to a paid provider. A free quota is a limit, not a promise of unlimited operation.

## Provider and service inventory

| Service | Purpose and current status | Cost classification and limits |
|---|---|---|
| Firebase Authentication | Anonymous sign-in only. | Free/Spark-compatible for the intended small team; service limits still apply. If sign-in is unavailable, members cannot use the app. No paid authentication method is configured. |
| Cloud Firestore | Shared `drafts` metadata and `teamMembers` access records. | Spark-compatible when usage stays within the current free quotas. Reads/writes fail when limits are exhausted; the app does not upgrade the project. Videos and editing assets are not stored here. |
| Firebase Storage | Not used. The application has no upload code, and the stale `storage.rules` file was removed. | Avoid: Firebase Storage requires a billing-enabled Blaze plan. Do not enable it for this application. |
| Gemini Developer API | AI chat, translation, alignment, cut analysis, B-roll planning, and Magic Edit planning. The server calls only `gemini-3.8-flash` at `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`. | Free tier is listed for this model, with limited access and quotas that can change. It is not unlimited. HTTP quota/billing errors become `FREE_QUOTA_EXHAUSTED`; there is no provider/model fallback or retry. The project must remain on the free tier and must not be linked to a billing account. The application cannot inspect or guarantee the API key project's billing status, so this is an unresolved operational risk until the operator verifies it. Google's unpaid-service terms allow prompts/responses to be used to improve products and permit human review; the linked terms do not specify a fixed retention period for this use. Do not send sensitive, confidential, or personal information. |
| Groq API / Whisper | Disabled. The previous transcription route used Groq's `whisper-large-v3` model; previous text fallback used `openai/gpt-oss-120b` through Groq. No audio is sent to Groq. | Not approved for this policy; no key is used and no automatic fallback exists. Local FFmpeg silence detection remains available, but cloud transcription is unavailable. |
| OpenRouter | Disabled and removed from the application. The previous model was `zhipu/glm-4.5-air`; its fallback path also included Groq. | Not approved. OpenRouter and its models are not called. |
| Pexels | Disabled. Video, image, and AI stock search return `PROVIDER_DISABLED`. | No key is read and no Pexels request is made. |
| Jamendo and Freesound | Disabled. Music, SFX, and external asset downloads return `PROVIDER_DISABLED`. | Their current API terms and usage costs have not been verified for this private product, so they are not called. |
| FFmpeg WebAssembly | Editing, silence analysis, and rendering run in the browser. The FFmpeg core is loaded from the public `unpkg.com` CDN; media is processed locally. Source videos are mounted through FFmpeg's browser `WORKERFS`, while analysis processes 60-second chunks sequentially. | No CreatorOS API key or billing account is used. CDN availability and terms are external dependencies; the CDN download must not be mistaken for a media upload. Export still needs memory for the rendered output and imported overlay/audio assets. |
| Hosting/deployment | No paid hosting provider or deployment service is configured by this repository. | Hosting and Firebase project billing status are external to the codebase and remain unverified. Use only a deployment that has been independently confirmed to require no billing or card. Do not enable Firebase App Hosting, Cloud Functions, or other Blaze-dependent services. |

No subscription, payment gateway, paid API fallback, or automatic billing-upgrade integration is present. Package dependencies are not configured to enable a paid provider.

## Authentication and shared data

- Enable Firebase Anonymous Authentication and use a Spark project.
- Add approved UIDs to `teamMembers/{uid}` using the procedure in [team-access.md](./team-access.md).
- Every `/api/*` handler verifies a Firebase ID token server-side, requires the token's anonymous sign-in provider, and checks the caller's active `teamMembers` document through Firestore Security Rules.
- The server uses the caller's ID token for the membership lookup; Firebase Admin credentials or service-account secrets are not required.
- Firestore quota exhaustion is an error, not a reason to enable billing. New project creation saves source media in OPFS before writing metadata, and does not delete that local media when a metadata write fails.
- `drafts` metadata is shared. Source video, editing assets, and the complete timeline are not thereby shared.

## AI quota and data behavior

The server-side model allowlist contains only `gemini-3.8-flash`. Clients cannot select the model or provider. OpenRouter, Groq, Pexels, Jamendo, and Freesound are not fallback providers. A Gemini quota/billing restriction returns `FREE_QUOTA_EXHAUSTED` and stops the request. The current edit remains in the browser; it is not replaced by a paid fallback.

Free Gemini usage is limited and model availability, quotas, and terms can change. The code cannot prevent costs if an operator supplies a key associated with a billing-enabled Google project. Before enabling `GEMINI_API_KEY`, verify in Google AI Studio/Google Cloud that the project uses the free tier and is not linked to billing. Never enable billing just to recover quota. If the free tier is unavailable, AI features must remain disabled.

## Environment variable names

Configure values outside source control. This document intentionally lists names only.

- Firebase client configuration: `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`.
- Gemini server API key (optional; required only for AI features): `GEMINI_API_KEY`.
- `PEXELS_API_KEY`, `JAMENDO_CLIENT_ID`, `FREESOUND_API_KEY`, `OPENROUTER_API_KEY`, and `GROQ_API_KEY_EDIT` are not used; do not configure them.

## Spark setup and safe exhaustion

1. Use Firebase Authentication Anonymous sign-in and Cloud Firestore on the Spark plan.
2. Do not add a billing account, enable Blaze, or configure Storage, App Hosting, Cloud Functions, or other billable services.
3. Keep Firestore rules restricted to active `admin`/`member` records. Do not deploy rules or change Console settings automatically; review and deploy them manually.
4. Monitor current Firebase free quotas in the Firebase Console and official pricing documentation. Quotas can change and the code does not perform a paid-plan upgrade.
5. If Firestore reaches a free quota, shared project metadata operations stop and show an error. Local OPFS media remains on the device.
6. If Gemini's free quota is exhausted, that AI operation stops with `FREE_QUOTA_EXHAUSTED`. No other provider is attempted.

## Sharing source media without cloud storage

There is no verified existing free cloud service for sharing source videos. Available approaches, none implemented here:

| Option | Limitations | Security and setup |
|---|---|---|
| Manual project/media export and import | Requires an export/import feature that packages media from each device's OPFS; current Firestore drafts alone do not include media or the full timeline. Moves files manually and may require large local disk space. | Keep export files encrypted and share only with approved members using a trusted channel. Validate manifests and media before importing. No cloud hosting or API is required. |
| Local network or self-hosted file share | Requires an always-on computer/NAS, local network access, storage, backups, and administration. Access outside the LAN needs a secure VPN or equivalent; Internet exposure is not recommended. | Configure individual accounts, least privilege, encrypted transport, and backups. Hardware, electricity, and maintenance are not necessarily cost-free. No paid hosted service is required if kept on the private network. |
| Existing free cloud infrastructure | None is configured or verified for source-media sharing. Consumer free plans may change, require a card, impose transfer limits, or upgrade to paid usage. | Do not use unless the specific service and account are independently verified to meet this policy; do not treat a free trial as free infrastructure. |

## Remaining risks and non-guarantees

- The repository cannot verify Firebase/Gemini account billing status, API key ownership, deployment hosting, or current provider quotas.
- Gemini's free tier is conditional and its free-tier data-use terms allow product improvement. Avoid sensitive source material and transcripts.
- Firestore Spark quotas and Anonymous Auth availability can change; quota exhaustion stops shared operations.
- Public CDN availability/terms and the chosen deployment host are outside this code's control.
- CreatorOS does not promise unlimited free AI, hosting, storage, or processing. Zero-cost operation is not guaranteed until operators verify the external account and deployment settings.

Official references: [Firebase pricing](https://firebase.google.com/pricing), [Firebase Spark plan](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans), [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini API model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [Gemini API terms](https://ai.google.dev/gemini-api/terms).
