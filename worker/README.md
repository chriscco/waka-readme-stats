# Personal coding statistics: Worker + D1

This single-user service collects existing WakaTime clients' heartbeats and keeps
them in your Cloudflare D1 database. It returns coding time, language/editor/project
shares and a private annual SVG heatmap. It retains supplied AI metadata but does
not generate AI reports. An offline importer can preserve historical Insights daily totals.

## Local development

Use Node 22.12+ and npm. Wrangler and its matching Miniflare version are development
dependencies only; the deployed Worker has no runtime dependencies or web framework.

```sh
cd worker
npm ci
npm test
npm run build
```

Tests run the actual Worker and SQL migration in Miniflare's disposable local D1.
The build is a Wrangler dry run and does not deploy. For interactive local use,
create an ignored `worker/.dev.vars` containing `INGEST_KEY="<test UUID>"`, then:

```sh
npx wrangler d1 migrations apply wakatime --local
npm run dev
```

Use `http://localhost:8787/api/v1` as the local API base. To test an installed CLI,
use a temporary `WAKATIME_HOME`, a temporary config and a disposable file, and pass
`--disable-offline --sync-ai-disabled`; do not point a test at your real config or
AI transcript history. Never put production keys in test fixtures.

## Deploy to your Cloudflare account

These commands are operator instructions; local tests do not perform them.

```sh
cd worker
npx wrangler login
npx wrangler d1 create wakatime
```

This checkout is bound to the existing `wakatime` database. For a fresh account, replace `database_id` in `wrangler.jsonc` with the returned ID.
Keep the binding named `DB`. Generate a UUID-shaped secret, for example with
`uuidgen`, save it in your password manager, and supply it at the secret prompt.
Use the same secret for the extra client destination and the README Action.
UUID form is recommended because clients may validate API keys locally.

```sh
npx wrangler d1 migrations apply wakatime --remote
npx wrangler secret put INGEST_KEY
npx wrangler deploy
```

The Worker uses the configured `INGEST_KEY` for both writes and private reads.
Keep Cloudflare request/trace logging disabled for this service: the legacy README
stats client sends its key in a query string. The Worker itself logs neither
credentials nor request bodies and all responses use `Cache-Control: no-store`.

## Keep WakaTime and add the Worker

The plugin and the README Action have separate settings. In your client config,
keep the existing WakaTime destination and add a matching `api_urls` entry:

```ini
[settings]
api_key = <existing WakaTime key>
api_url = https://api.wakatime.com/api/v1

[api_urls]
.* = https://personal-coding-stats.<your-subdomain>.workers.dev/api/v1|<Worker UUID key>
```

Do not duplicate `[settings]` or `[api_urls]` sections if they already exist.
Current wakatime-cli sends to the default destination **and** every matching extra
destination. Update an old CLI if it lacks `api_urls` support. This setup retains
your existing WakaTime data and starts a separate local history from installation.
See the upstream [multi-destination configuration](https://github.com/wakatime/wakatime-cli/blob/develop/USAGE.md#api-urls-section).

For the README generator, set `WAKATIME_API_URL` to the Worker base ending in
`/api/v1`, `WAKATIME_API_KEY` to the Worker secret, and opt in to
`SHOW_CODING_HEATMAP: "True"`. Use the repository's
[profile workflow example](../examples/profile-worker.yml); it runs your changed
code. Existing upstream prebuilt Action images will not contain this integration.
The API stays private; the Action downloads the SVG and commits its rendered
365-day totals to the public README assets. The SVG has a transparent background
and adapts its labels and green palette to the viewer’s light/dark color scheme. Only enable this if you want those
daily totals public.

## Import historical Insights totals

The offline importer accepts a saved, up-to-date `insights/days` JSON response in
Asia/Shanghai. It validates every date, category and total before emitting SQL.
Keep both the response and generated SQL outside this repository in a private directory.
Apply migrations and back up D1 before importing:

```sh
node scripts/import-insights.js /private/insights.json 2026-11-05 > /private/import.sql
npx wrangler d1 execute wakatime --remote --file=/private/import.sql
```

The cutoff is exclusive: this example imports through November 4. Never import
an unfinished current date. `historical_summaries` stores the original daily
record and calculation metadata separately from heartbeats. Repeating an import
updates the same dates without duplication. On an imported date the historical
summary takes precedence over local events, including later client backfills.
Other dates continue to use local heartbeat calculations. No raw events are deleted.

Original totals include AI Coding. Historical idle timeout and other source
settings are retained, so they may differ from the local 30-minute estimate.
The Insights days response lacks language/editor/project/OS details: their totals
are explicitly grouped under `History (no details)`, never invented.
These imported totals feed the heatmap, daily, weekly and all-time endpoints.
GitHub commit patterns and repository languages are separate GitHub-derived metrics.
The checked profile imported 364 completed dates, 2025-11-06 through 2026-11-04;
the `all_time` Insights endpoint required an upgrade on that account.

## HTTP contract

All paths below begin with `/api/v1/users/current/` and require authentication:

| Method | Path | Response |
| --- | --- | --- |
| POST | `heartbeats` | `{ "data": { "id": "…" } }`, status 201 |
| POST | `heartbeats.bulk` | `{ "responses": [[body, status], …] }`, status 201 |
| GET | `stats/last_7_days` | WakaTime-shaped `{ "data": … }`, seven completed Shanghai dates |
| GET | `stats/all_time` | Same stats shape, all retained dates including today |
| GET | `status_bar/today` | Today, with `data.grand_total`, `data.range`, categories and shares |
| GET | `statusbar/today` | Alias used by the actual WakaTime CLI |
| GET | `daily` | `{ "timezone": "Asia/Shanghai", "data": [{ "date": "…", … }] }` |
| GET | `heatmap.svg` | Accessible 365-date green SVG ending today |

Authentication accepts `Authorization: Bearer <key>` or HTTP Basic containing
base64 of `<key>` or `<key>:`. Read-only GET requests also accept `?api_key=<key>`
for the existing README stats client. Prefer headers for new clients. Query keys
are never accepted for writes; a supplied invalid Authorization header cannot be
bypassed with a query key.

`daily` defaults to the last 365 dates including today. Optional `start` and `end`
are inclusive ISO dates; the range must contain 1–366 valid dates. Every stats
object includes `timezone`, `total_seconds`, `human_readable_total`, `languages`,
`editors`, `projects`, `operating_systems`, and `categories`. Share entries contain
`name`, `total_seconds`, `percent`, and `text`.

The collector accepts 1–25 events per bulk request, at most 256 KiB per request,
16 KiB per event, 4,096 characters per string and eight metadata nesting levels.
Required fields are nonblank `entity`, `type` (`file`, `app`, `url`, `domain`), and
numeric Unix-seconds `time` from the epoch through five minutes into the future.
Invalid bulk entries receive individual 400 statuses while valid entries commit
together. Database failure returns 503 and acknowledges none of the pending batch.
Exact retries are deduplicated by SHA-256 of canonical event JSON, machine and
effective user agent; JSON property order does not affect the identifier.
Changing event metadata makes a different event, rather than overwriting history.

The normalized dimensions prefer explicit event fields; `user_agent` on an event
overrides the HTTP header. Editor and OS fall back to that agent string, and
machine falls back to URL-decoded `X-Machine-Name`. Missing dimensions become
`Unknown`. Raw event JSON and the effective user agent retain supplied AI tokens,
session IDs, line changes and model information; no absent AI field is invented.
The first application/version token is used as the editor; unfamiliar agent
formats may require a parser update. Give each machine a distinct hostname to
avoid combining unrelated streams. The raw events can contain private paths,
project names and AI metadata; restrict D1/account access accordingly.

## Time calculation and incremental caches

Dates use fixed UTC+08:00 (`Asia/Shanghai`), without historical DST rules.
For each machine, events are ordered by timestamp and then their stable ID.
The client's monitored-app settings and editor plugins determine which events
are sent; the Worker adds no application allowlist or AI-app exclusion.
All reported activity, including background AI app events, is eligible.
Each pair contributes the gap only when it is positive and at most
30 minutes; the interval inherits the earlier event's dimensions. Isolated events,
long idle gaps and time after the final heartbeat contribute no duration. This is
an explicit estimate and need not exactly match WakaTime's proprietary totals.

Intervals are split at local midnight. A sweep of interval boundaries merges
overlapping machines: the most recently started interval wins each segment, with
the lexicographically greatest event ID breaking equal-start ties. Thus durations
and every dimension's shares count a wall-clock instant at most once. A sweep
keeps only active machine intervals; it does not compare every pair of events.

An SQL insert trigger increments the versions of dates touched by `time ± 1800s`
in the same transaction as the heartbeat. This covers adjacent dates when a late
event bridges midnight. Ignored duplicates do not invalidate anything. Reads
rebuild only dirty dates using the time index and a 30-minute margin on either
side, then publish only if the date's version still matches. The final query reads
cache contents and readiness together; concurrent late writes cannot publish an
outdated cache as current.

Each read rebuilds at most 16 dates (at most 34 D1 queries), staying below D1
Free's 50-query request limit. If a backlog or concurrent upload leaves dates
dirty, the response is **503 with `Retry-After: 1`**, not partial or zero stats.
Retry the same endpoint to drain the backlog; the README update deliberately
fails instead of publishing incomplete output, so rerun its workflow afterward.
Normal daily use generally needs one or two dates rebuilt. All-time reads sum
daily summaries rather than rescanning raw history. Very dense individual days
are still subject to Worker memory/CPU and D1 result limits; this version targets
personal coding streams, not organization-wide telemetry. There is no background
job, arbitrary timezone setting, account system, public dashboard or retention job.

## Backups and capacity

Raw events are never automatically deleted. Export before changing storage or
migrations, and store backups privately:

```sh
npx wrangler d1 export wakatime --remote --output=../coding-stats-backup.sql
```

Do not commit that backup. D1 Free currently limits each database to **500 MB**;
also monitor daily row reads/writes and Worker limits in your account. Upgrade or
plan an explicit archival migration before capacity is reached. A full database
cannot durably accept new events, so clients will need to retry. See the official
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[export documentation](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

Local tests cover authentication, validation, transactional failures, deduplication,
idle gaps, midnight/late events, multi-machine and equal-start overlap attribution,
AI retention, production cache races, cache backlog, compatibility responses and
SVG structure. An installed WakaTime CLI was also checked against two isolated
local Workers: both destinations received events, today returned the expected
duration, and the SVG contained 365 dates. Cloudflare login, remote migration,
deployment, live delivery and production quota/CPU behavior require separate
account-level verification.

## Private Gitea history snapshot

Migration `0003.sql` adds an independent snapshot table. Authenticated
`PUT /api/v1/users/current/gitea/commits` accepts a nonempty JSON object mapping
commit SHA to UTC `YYYY-MM-DDTHH:MM:SSZ` timestamp, up to 1 MiB. It validates the
whole object before a single atomic replacement. `GET` returns `{data, updated_at}`;
missing snapshots return 404. Both routes use the existing Worker key. They never
read or write coding heartbeats, daily summaries, or imported WakaTime history.

Run `scripts/sync-gitea.py` from the project root to collect and replace this snapshot.
See the root README for manual sync and profile configuration. No Gitea token is
stored in D1 or sent to the Worker, and no local scheduler is installed.

## Client connects locally but heartbeats never arrive

If `~/.wakatime/wakatime.log` reports connection timeouts to the Worker while
requests through your proxy succeed, configure the proxy explicitly in WakaTime.
An editor-launched CLI may not inherit your terminal's proxy environment.
For this machine's local proxy:

```sh
~/.wakatime/wakatime-cli --config-write proxy=http://127.0.0.1:7897
~/.wakatime/wakatime-cli --offline-count
~/.wakatime/wakatime-cli --sync-offline-activity 0 --sync-ai-disabled
```

This retains the existing WakaTime destination and `[api_urls]` dual delivery.
The sync command resends queued real heartbeats without creating a test heartbeat.
Keep the configured proxy running; otherwise uploads queue offline again. Verify
actual receipt using D1's `heartbeats` count and latest `time`, not the imported
historical summaries or Gitea snapshot.


## Seven-day raw heartbeat retention

A daily Cron Trigger at 02:00 Asia/Shanghai (18:00 UTC) archives dates older than
seven completed local days. It retains today, the preceding seven dates, and a
30-minute boundary margin for midnight calculations. Daily totals and all supplied
language/editor/project/OS/category shares remain in `historical_summaries`.
Imported Insights rows keep their original totals and provenance.

Archiving checks that each cache version is current. Archive inserts and raw
heartbeat deletion share one transaction; records are removed only when both
potentially affected dates have archived summaries. A failed or raced calculation
keeps raw data for a later run. Each run deletes at most 5,000 heartbeats, so a large
backlog drains over multiple days. Summary rebuilding still handles up to 16 dirty
dates per request/run.

Archived dates are frozen. Late heartbeats may be received but cannot revise those
summaries. Changing calculation rules after raw data has expired cannot reconstruct
old activity. Retained raw data preserves supplied AI fields; daily archives keep
only the existing aggregate dimensions, not individual AI metadata.

## Free-tier sizing (2026-11-06)

Observed 1,774 heartbeats for November 6 at the time of sampling. Budgeting
2,000–3,000/day, normal ingestion needs at most roughly 2,000–3,000 Worker requests
without batching, plus the README fetches and client status calls. Retries are extra.
The 30-minute idle threshold is an aggregation rule, not an upload schedule.

Including heartbeat rows, indexes, summary invalidation and eventual deletion,
allow roughly 10,000–25,000 D1 row writes/day. The cached daily README workflow
should stay well below 100,000 row reads/day at this scale. These are estimates,
not account-wide billing measurements. The public README serves the generated SVG
from GitHub, so profile visits do not query this Worker.

Measured raw fields average about 0.7 KB/heartbeat, before indexes/page overhead.
Allowing roughly 1–1.5 KB/heartbeat, the retention window should occupy around
20–40 MB plus growing daily summaries. No automatic deletion of daily summaries.

Current official limits: [Workers Free](https://developers.cloudflare.com/workers/platform/limits/)
100,000 requests/day and 10 ms CPU/invocation;
[D1 Free pricing](https://developers.cloudflare.com/d1/platform/pricing/)
5 million rows read/day and 100,000 rows written/day;
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) 500 MB/database
and 5 GB/account. Limits are shared with other workloads on the account where
applicable. CPU headroom is not a throughput guarantee and needs production metrics
if activity grows substantially. Routine data volume fits Free with retention.
