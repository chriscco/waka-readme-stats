"""Manually refresh the private Gitea commit snapshot used by the profile workflow."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sources"))
from gitea_commits import get_gitea_commit_dates, validate_commit_dates  # noqa: E402


async def sync(args):
    url = urlsplit(args.worker_api)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Worker API must be an HTTPS URL without credentials, query or fragment")
    key = args.key_file.expanduser().read_text().strip()
    if not key:
        raise ValueError("Worker key file is empty")
    if args.snapshot:
        commits = json.loads(args.snapshot.expanduser().read_text())
    else:
        print("Scanning Gitea history; this can take several minutes...", flush=True)
        commits = await get_gitea_commit_dates(args.gitea_url, os.environ.get("gitea", ""))
    validate_commit_dates(commits)
    body = json.dumps(commits, separators=(",", ":")).encode()
    if len(body) > 1048576:
        raise ValueError("Snapshot exceeds the Worker's 1 MiB limit")
    async with httpx.AsyncClient(timeout=60, follow_redirects=False, trust_env=False, proxy=os.getenv("https_proxy") or os.getenv("HTTPS_PROXY")) as client:
        try:
            response = await client.put(
                args.worker_api.rstrip("/") + "/users/current/gitea/commits",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                content=body,
            )
        except httpx.RequestError:
            raise RuntimeError("Worker upload failed; rerunning the sync is safe") from None
        if response.status_code != 200:
            raise RuntimeError(f"Worker upload failed: HTTP {response.status_code}")
        if response.json().get("count") != len(commits):
            raise RuntimeError("Worker did not acknowledge the expected commit count")
    print(f"Saved {len(commits)} unique commits to the private Worker snapshot.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gitea-url", required=True)
    parser.add_argument("--worker-api", required=True, help="Worker URL ending in /api/v1/")
    parser.add_argument("--key-file", type=Path, default=Path.home() / ".config/personal-coding-stats/ingest-key")
    parser.add_argument("--snapshot", type=Path, help="Import an already collected SHA-to-UTC-date JSON file instead of contacting Gitea")
    try:
        asyncio.run(sync(parser.parse_args()))
    except (ValueError, OSError, RuntimeError) as error:
        raise SystemExit(str(error)) from None
