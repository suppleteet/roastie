Fetch, display, and distill user feedback from Vercel Blob storage.

## When to invoke

- User asks to check feedback, read feedback, see what users said
- User asks to distill or process feedback into comedy guidelines
- As part of `/wrapup` (Step 4c — Comedy Feedback Distillation)

## Steps

### 1 — Fetch feedback from Vercel Blob

```bash
curl -s http://localhost:3000/api/list-feedback?limit=50 2>/dev/null || \
curl -s https://roastie-suppleteets-projects.vercel.app/api/list-feedback?limit=50
```

This returns `{ entries: [{ url, pathname, uploadedAt, size }], total }`.

For each entry, fetch the full JSON:

```bash
curl -s <entry.url>
```

Each feedback entry contains:
- `type`: "post-session" | "critique" | "joke-rating"
- `text`: the user's feedback
- `persona`: which puppet was active
- `lastJokeText`: the joke that triggered a critique (if applicable)
- `sessionLog`: full transcript + timing log (if post-session)
- `createdAt`: ISO timestamp

### 2 — Display summary

Format as a table:

```
| # | Date       | Type         | Persona | Feedback                          |
|---|------------|--------------|---------|-----------------------------------|
| 1 | 2026-04-06 | post-session | kvetch  | "The questions need work..."      |
| 2 | 2026-04-06 | critique     | kvetch  | "Too harsh" (joke: "Your face...") |
```

### 3 — Distill into comedy guidelines (when asked, or during wrapup)

Read `src/lib/comedyGuidelines.ts`. Analyze the accumulated feedback and update:

- Extract GENERAL PRINCIPLES, not specific jokes
- If feedback mentions a specific persona, add to `PERSONA_COMEDY_GUIDELINES[personaId]`
- If it's about the overall experience, add to `GLOBAL_COMEDY_GUIDELINES`
- Merge with existing guidelines, don't replace
- Max 15 global + 5 per persona
- After distilling, note which entries were processed (by date range)

### 4 — Cleanup (optional)

Vercel Blob entries persist indefinitely. Old processed feedback can be deleted via:

```typescript
import { del } from "@vercel/blob";
await del(blobUrl);
```

Only delete after confirming guidelines have been updated.

## Environment

- **Local dev**: `http://localhost:3000/api/list-feedback`
- **Production**: `https://roastie-suppleteets-projects.vercel.app/api/list-feedback`
- Requires `BLOB_READ_WRITE_TOKEN` env var (set in Vercel dashboard → Storage → Blob Store)
