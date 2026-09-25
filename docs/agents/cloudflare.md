# Cloudflare config

- Config lives in `wrangler.jsonc` (JSONC, so comments are allowed). Bindings: `AI`, `TRIP_ROOM`, `ITINERARY_WORKFLOW`.
- After you change bindings, run `npm run cf-typegen` so the `Env` types stay in sync.
- For Durable Object class changes, add a new entry to `migrations` (for example `v2`). Never edit the existing `v1` tag.
- `VOTE_REMINDER_AFTER` and `VOTE_CLOSE_AFTER` are Workflow duration strings. Shorten them (for example `"1 minute"`) to test the reminder path, and don't commit the short values.
- Secrets go in `.dev.vars` locally, which is gitignored. Never put them in `vars`.
