# Handoff: make the admin AI chat persistent, with a browsable history

Hand this whole file to the next agent. It is written to stand alone — it assumes no
access to the conversation that produced it.

---

## The job

`/admin/chat` (the campaign-manager AI assistant) forgets everything on reload. Make
conversations persist, and give the screen a **ChatGPT-style history**: a list of past
chats you can reopen, rename, and delete, plus a "New chat" action.

That's the whole scope. Don't extend the assistant's capabilities, don't touch the tool
loop, don't add sharing or team-visible chats.

---

## Read before you start

- **`CLAUDE.md`** in the repo root. It is the authority on this codebase and it is long
  for a reason. It is **gitignored** — update it as part of your work anyway, and don't
  be confused when it never shows in `git status`.
- Its **"Demo affordances"** bullet covers the AI-chat prompt/client contract you must
  not break.
- `canvassing-app-spec.md` § 0 for built-vs-planned.

---

## Current state (verified, not assumed)

- **`src/views/AdminChatView.vue`** holds the entire conversation in a local
  `messages = ref<ChatMessage[]>([...])`, seeded with a greeting at `id: 0`, plus a
  per-visit `nextId` counter. Nothing is written anywhere. Reload loses the lot.
- **`netlify/functions/chat.ts` needs no changes.** It is stateless across turns: the
  client sends the FULL history on every send (`wireMessages` in `send()`), and the
  only server-held state is the `{ continue, state }` blob that lets one turn span
  several Netlify invocations. **Persistence is entirely client-side reads and writes.**
- The Anthropic key comes from `admin_settings.anthropic_api_key`, per owner, loaded
  once in `onMounted`. Leave that alone, and never store a key on a chat row.
- A stored assistant message needs three things, and only the first is obvious:
  - `text` — but note it is the text **after** `extractFollowups()` has stripped the
    trailing ` ```followups ` block. See the trap below.
  - `activity: string[]` — the tool-trace chips ("Searched database", "Geocoded: …").
    Part of the answer; keep it.
  - `suggestions: string[]` — the three tap-to-send follow-ups.
- Infographic and turf-plan cards are **re-derived from the text at render time**
  (`splitSegments` in `src/lib/infographic.ts`), so storing the raw text is enough —
  don't try to serialize the card specs.
- **`editMessage()`** is a rewind: it pulls a user message back into the input and drops
  it *and everything after it*, so the next send branches the conversation. Whatever you
  build has to mirror that server-side (delete the tail), or an edited chat will reload
  with the abandoned branch still in it.

### The one real trap

`extractFollowups()` **removes** the followups block from the text it returns. So:

- If you store the stripped text, the suggestions are gone unless you store them too.
- If you store the raw text and strip on load, the suggestions come back for free but
  every consumer of the stored text has to remember to strip.

**Decision: store the stripped `text` and store `suggestions` as its own jsonb column.**
It keeps every read path simple, and the suggestions are only rendered under the newest
reply anyway (`activeSuggestions`).

---

## Decisions already made — implement these, don't re-litigate

1. **Two new tables: `ai_chats` and `ai_chat_messages`.** The `ai_` prefix is not
   decoration: `chats`, `chat_messages`, `chat_members` and `chat_reads` already exist
   and belong to the **user-to-user** chat feature. Do not touch those.
2. **Owner-only RLS, both tables.** A manager's conversation with the assistant is
   theirs. No org read, no manager override, no `is_admin()` bypass.
3. **`revoke all on ai_chats, ai_chat_messages from service_role;` — LOAD-BEARING.**
   `ai_readonly_query()` runs as service_role, so *every new private table is readable
   by the assistant itself* until it is revoked. `member_phones` and `member_locations`
   both carry this revoke for the same reason. Skip it and the assistant can read every
   manager's chat history on request. Verify the revoke landed after you apply the
   migration; don't assume it.
4. **The history picker is a `BottomSheet`**, not a sidebar —
   `src/components/ui/BottomSheet.vue` is the app's one modal idiom. Desktop renders the
   phone app in a fixed 430px column (see the phone-frame bullet in CLAUDE.md), so there
   is nowhere for a ChatGPT sidebar to go, and adding one would fight the frame.
5. **Titles come from the first user message**, trimmed to something that fits one line.
   No extra AI call to name a chat: it costs a request against the admin's own key.
   Renaming by hand should be possible.
6. **Write as the turn lands.** Insert the user message immediately on send; insert the
   assistant message once the reply resolves — **after** the continuation loop finishes,
   not once per hop. A dropped connection should cost at most the answer, never the
   question.
7. **Opening an old chat must not call the API.** Read rows, render, stop.
8. **The seeded greeting (`id: 0`) is UI, not a message.** Never write it to the DB.
   `activeSuggestions` keys the starter list off `last.id === 0`, so keep that shape or
   fix it deliberately.

## Yours to decide — make the call, then say what you chose and why

- Whether "New chat" creates a row immediately or lazily on first send. (Lazily avoids
  a graveyard of empty chats; immediately is simpler.)
- Ordering and paging of the list, and whether it shows a snippet or just a title.
- Whether deleting is one tap with an undo, or two taps. Precedent in this app: the
  knock-edit sheet uses **two taps to delete, no dialog**, because a confirm dialog is
  hard to dismiss one-handed.

---

## Migrations — how they actually get applied here

- Write `supabase/migrations/2026MMDDHHMMSS_ai_chat_history.sql` (match the existing
  naming exactly).
- **Pushing to GitHub does NOT apply migrations.** There is no Supabase↔GitHub
  integration on this project. Apply it yourself via the Management API:
  `POST https://api.supabase.com/v1/projects/whrliwbdxjdcksbvwkrc/database/query`,
  bearer `SUPABASE_ACCESS_TOKEN` from the gitignored `KEYS-AND-ACCESS.md`.
- **Read the token inside a script. Never paste a real key value into command text** —
  it ends up in the transcript.
- Afterwards, verify against the live DB: `pg_policies` for the RLS you think you wrote,
  and a check that the service_role revoke is in place.

---

## House rules that will bite you if you skip them

- **No explanatory sub-copy anywhere in the UI.** A control's label plus what it does
  when tapped IS the documentation. Standing user rule, swept through the whole app.
  State and errors are fine and wanted: "No saved chats yet.", "Couldn't rename."
- **No side-to-side scrolling on any screen.** Enforced in `src/style.css` with
  `overflow-x: clip` at three levels. Deliberate inner scrollers are fine; the page
  sliding is not.
- **Help is a walkthrough, and it must stay in sync.** Any new control worth explaining
  needs BOTH a `data-help="<key>"` anchor on the element AND a matching section under
  `'/admin/chat'` in `src/lib/helpContent.ts`. The two sides are cross-checkable — they
  were 89 anchors / 89 targets before this work; keep them balanced. Copy register is
  dry manual: fragments over sentences, no second person where a label will do, no
  teaching what the screen already shows.
- **`npm run type-check` and `npm run build` must both pass.** There is no eslint config
  in this project; those two are the gate.
- **Look at your work before handing it over.** `npm run dev`, then check `/admin/chat` —
  it has no map, so nothing bills and nothing is blocked. (Login credentials are in
  `KEYS-AND-ACCESS.md`. If you won't enter them, say so plainly instead of implying you
  verified something you didn't.) Maps, geolocation and phone-feel work go to the user.
- **PostgREST caps every response at 1000 rows** no matter what `.limit()` says. Any
  "load the whole set" query goes through `fetchAllRows()` in `src/lib/supabase.ts`. A
  chat list should just limit sensibly instead.
- **supabase-js builders are lazy.** `void supabase.from(...)` never sends the request;
  it only executes when awaited or `.then()`-ed.

---

## Commit and push — required, and already authorized

The standing rule on this project is **ask before every deploy**, because GitHub and
Netlify are linked and a `git push` triggers a metered build. **For this work the user
has already said yes.** Do not ask again; do not finish without pushing.

`main` currently carries **6 commits that have never been pushed**, from the session
before yours:

```
a2ec2c5  Six tabs, one line
8cbe835  The assistant searched the database; that's all anyone needs
b049947  Retire the help that described the old shapes
8fa26e4  Don't move a map somebody is already reading
6968b83  Say how long is left, and leave the leaderboard to the leaders
7ca4322  A street is a name until you tap it
```

Commit your own work on top, then **push ONCE** so every bit of it goes out in a single
build — each push is a separate metered build, and credits have run out before from many
small pushes in one session.

Afterwards, spot-check the deploy:

```bash
netlify api listSiteDeploys --data "{\"site_id\":\"$(node -p "require('./.netlify/state.json').siteId")\"}"
```

A skipped build reports state `error` with "Skipped due to account credit usage
exceeded" — if you see that, say so rather than reporting success.

Finally: **delete this file** once the work is pushed. It's a handoff note, not
documentation. The lasting record goes in `CLAUDE.md`.
