# Gitea commit counts

Approved scope: add the authenticated user's Gitea commit history only to the
README commit time-of-day and weekday distributions. Keep other metrics sourced
as before. Use commit timestamps in Asia/Shanghai, matching existing GitHub stats.

- Add an optional HTTPS Gitea API URL and token (local fallback: `gitea`).
- Enumerate accessible nonempty repositories and all current branches with pagination.
  Pin branch tips; exclude default-branch ancestry from extra branch walks and skip
  already-seen tips. Request no diff stats, verification or changed-file details.
- Include only the authenticated author ID or verified author email. Deduplicate
  commit SHA across Gitea branches/repos and exclude SHAs already counted by GitHub.
- Keep dates in memory. Publish only combined counters, never repository names,
  commit messages, files, emails or credentials. API errors fail the update.
- Reuse httpx, existing progress bars and date bucketing. Add collector and integration
  tests for pagination, identity, deduplication, offsets, failures and disabled mode.
- Verify against live Gitea, configure the profile's secret and API variable, pin
  the generator revision, run the profile workflow and verify both counter totals.

## Internal-network follow-up

Gitea resolves only on the user's network. User chose one initial import and manual
sync thereafter. Store only SHA/date pairs in an authenticated D1 snapshot; add an
atomic validated PUT and GET under the existing Worker auth. Reuse it during daily
README updates so counts persist without reaching Gitea. Provide a manual Python
sync command using `gitea` and the existing local Worker key; no local scheduling.
Test snapshot auth, validation, replacement and isolation from coding statistics,
plus Python snapshot selection and existing GitHub SHA deduplication. Import the
already collected 1,166 commits, publish and verify the actual profile run.
