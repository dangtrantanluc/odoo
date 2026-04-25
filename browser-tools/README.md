# browser-tools — OpenClaw plugin

Playwright-driven browser automation for chat platforms when bot APIs
fall short. Currently targets **Gapo Work**; add Slack/Zalo/Telegram
adapters by mirroring [src/gapo-actions.ts](src/gapo-actions.ts).

## Why this exists

Gapo Work bot tokens **cannot initiate DMs** — they can only reply in
threads where a user already messaged the bot. For PM Agent flows like
`send_follow_up`, this means many users would never receive a ping.

`browser-tools` plugs that gap. When [bb-pm-tools] tries to send a
follow-up and `channel_identity` has no thread for the user, it falls
back to this plugin, which logs into Gapo as a real account and sends
the DM through the UI.

## Architecture

```
bb-pm-tools/send_follow_up
        │ (1) read channel_identity
        │
        ├── thread present  ──► gapo-work /send (bot API, fast)
        │
        └── no thread       ──► browser-tools /send-dm (Playwright, slower)
                                       │
                                       └── upsert channel_identity
                                            for next time
```

## Setup

```sh
cd browser-tools
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
# Edit .env: set BROWSER_TOOLS_TOKEN to a fresh hex32 (must match
#   bb-pm-tools/.env BROWSER_TOOLS_TOKEN)

# One-time interactive login
pnpm auth
# → opens Chromium, you log in to Gapo manually (incl. 2FA), press
#   ENTER in the terminal to save cookies + localStorage.

# Build + reload into OpenClaw
pnpm build
openclaw plugins install --link --dangerously-force-unsafe-install $PWD
openclaw gateway stop && sleep 2 && openclaw gateway start
```

## Routes

All routes (except `/health`) require `X-Plugin-Token` matching `BROWSER_TOOLS_TOKEN`.

| Method | Path | Body | Use |
|---|---|---|---|
| GET | `/health` | — | Liveness, reports whether storage state exists |
| POST | `/find-user` | `{query}` | Top 10 user matches via Gapo search |
| POST | `/send-dm` | `{externalId, text}` | Send DM, returns Gapo messageId |
| POST | `/read-thread` | `{externalId, sinceMessageId?}` | Scrape recent messages |
| POST | `/user-status` | `{externalId}` | online / offline / unknown |

## Selectors

`gapo-actions.ts` has a `SEL` block — placeholders pending real DOM
inspection. Run `pnpm auth`, navigate to each surface (search, DM,
thread), open DevTools, and update the selector strings. Errors thrown
on miss are tagged with the stage so debugging is fast.

## Limits

- DM cap: `BROWSER_MAX_DMS_PER_HOUR=30` (in-memory ring). Adjust per
  your Gapo account's tolerance — too many DMs trip Gapo's anti-spam.
- Single Chromium per process. The plugin is single-process by design;
  scaling means running multiple OpenClaw gateways with separate
  storage states.

## Risks

- **TOS:** browser automation may violate Gapo's ToS. Read before
  going live.
- **Selector rot:** Gapo redesigns will break selectors. Add a
  monitor: `/health` could be extended to dry-run a search.
- **Captcha:** if Gapo flags the account, all calls fail. Today the
  plugin surfaces the raw error; consider an `account-locked` audit
  signal so PM gets paged.

## Not implemented yet (deferred)

- Auto-renewal of expired sessions (currently you re-run `pnpm auth`).
- Screenshot-on-error → MinIO upload (audit trail for "did we really
  send to the right user?").
- Gapo selectors for group chat / channel posting (DMs only today).
