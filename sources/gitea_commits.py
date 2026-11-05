import asyncio
from datetime import datetime, timezone
from re import fullmatch
from urllib.parse import quote, urlsplit

import httpx


async def get_gitea_commit_dates(base_url: str, token: str) -> dict[str, str]:
    """Collect only this user's commit IDs and UTC committer dates; retain no repository details."""
    url = urlsplit(base_url)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Gitea requires an HTTPS base URL without credentials, query or fragment")
    if not token:
        raise ValueError("Missing Gitea API token")

    async with httpx.AsyncClient(
        base_url=base_url.rstrip("/") + "/api/v1/", headers={"Authorization": f"token {token}"}, timeout=30, follow_redirects=False
    ) as client:

        async def get(path, params=None):
            for attempt in range(3):
                try:
                    response = await client.get(path, params=params)
                except httpx.RequestError:
                    if attempt == 2:
                        raise RuntimeError("Gitea network request failed") from None
                else:
                    if response.status_code == 200:
                        try:
                            return response, response.json()
                        except ValueError:
                            raise RuntimeError("Gitea returned invalid JSON") from None
                    if response.status_code not in (429, 500, 502, 503, 504) or attempt == 2:
                        raise RuntimeError(f"Gitea request failed: HTTP {response.status_code}")
                await asyncio.sleep(2**attempt)

        async def pages(path, **params):
            page, seen_pages = 1, set()
            while True:
                response, rows = await get(path, {**params, "page": page, "limit": 50})
                if not isinstance(rows, list):
                    raise RuntimeError("Gitea returned an invalid list")
                if not rows:
                    return
                marker = str(rows[0])
                if marker in seen_pages:
                    raise RuntimeError("Gitea pagination repeated a page")
                seen_pages.add(marker)
                for row in rows:
                    yield row
                if response.headers.get("X-HasMore", "").lower() == "false":
                    return
                page += 1

        _, user = await get("user")
        user_id = user["id"]
        _, email_rows = await get("user/emails")
        emails = {row["email"].casefold() for row in email_rows if row.get("verified")}
        repos = [repo async for repo in pages("user/repos")]
        commits, semaphore = {}, asyncio.Semaphore(4)

        async def collect(repo):
            if repo.get("empty") or (repo.get("units") and not any(unit.get("type") == "repo.code" for unit in repo["units"])):
                return
            async with semaphore:
                path = f"repos/{quote(repo['owner']['login'], safe='')}/{quote(repo['name'], safe='')}"
                branches = [branch async for branch in pages(path + "/branches")]
                branches.sort(key=lambda branch: branch["name"] != repo["default_branch"])
                seen, base_tip = set(), None
                for branch in branches:
                    tip = branch["commit"]["id"]
                    if not fullmatch(r"(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})", tip):
                        raise RuntimeError("Gitea returned an invalid branch commit ID")
                    if tip in seen:
                        continue
                    params = {"sha": tip, "stat": "false", "verification": "false", "files": "false"}
                    if base_tip:
                        params["not"] = base_tip
                    async for item in pages(path + "/commits", **params):
                        sha = item["sha"]
                        if not fullmatch(r"(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})", sha):
                            raise RuntimeError("Gitea returned an invalid commit ID")
                        if sha in seen:
                            continue
                        seen.add(sha)
                        author = item.get("author") or {}
                        email = item["commit"]["author"].get("email", "").casefold()
                        if author.get("id") != user_id and email not in emails:
                            continue
                        try:
                            date = datetime.fromisoformat(item["commit"]["committer"]["date"].replace("Z", "+00:00"))
                            if date.tzinfo is None:
                                raise ValueError()
                            commits[sha] = date.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                        except (KeyError, TypeError, ValueError):
                            raise RuntimeError("Gitea returned an invalid commit timestamp") from None
                    if base_tip is None:
                        base_tip = tip

        await asyncio.gather(*(collect(repo) for repo in repos))
        return commits
