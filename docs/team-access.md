# Private team access

## Initial administrator bootstrap

1. Enable **Anonymous** sign-in in Firebase Authentication.
2. The first person opens the app and copies the Firebase UID shown on the Access Pending screen.
3. In the trusted Firebase Console, create `teamMembers/{UID}` with `role: "admin"`, `active: true`, and `createdAt` set using the server timestamp field-value option.
4. Each later team member signs in and shares their pending-screen UID. Add `teamMembers/{UID}` in the Console with `role: "member"`, `active: true`, and a server timestamp in `createdAt`.
5. To suspend a member, set `active` to `false` in the trusted Console. Clients cannot create, edit, or delete membership records.

Do not designate an administrator based on signup order or client-provided data. Do not share Firebase ID tokens; the UID is a public identifier, not a credential.

## Shared drafts and legacy data

The app's existing Firestore project collection is `drafts`. Approved members query the entire collection; `createdBy` is retained as historical metadata and is not an authorization check. Existing documents are not rewritten or migrated. New drafts record the Firebase UID in `createdBy`.

Draft metadata is shared, but source videos and editing assets are stored in browser OPFS and are not uploaded. Another member/device can see a draft while lacking its source video. The editor does not currently persist its complete timeline as shared Firestore data. Firestore metadata must not be described as shared media.

Every `/api/*` handler verifies the Firebase ID token, requires Anonymous Authentication, and checks active team membership server-side. The API uses the caller's ID token to read their membership document, so no Firebase Admin service-account key is needed. A missing project ID fails closed. These checks do not replace the Firestore Security Rules.

## Rules test plan

Run the Firestore rules with the Firebase Emulator Suite and `@firebase/rules-unit-testing` before deployment:

- Unauthenticated requests cannot read or mutate `drafts`.
- Authenticated users with no membership, inactive membership, or an unsupported role cannot access drafts.
- An active admin and active member can list, get, create, update, and delete shared drafts regardless of their `createdBy` value.
- Draft creates require the current draft fields and a matching document ID; updates cannot change existing `id`, `createdBy`, or `createdAt`.
- A user can read only their own membership document while pending; active admins can list membership documents.
- No client can create, update, or delete a membership document, including its own role or active flag.
- Legacy drafts with browser-generated `createdBy` values remain readable, and tests verify rules do not rewrite stored documents.

Firebase Storage is deliberately not used. Do not create a bucket, configure Storage uploads, or deploy Storage rules. No Firebase Console setting or rules deployment is performed by the application.
