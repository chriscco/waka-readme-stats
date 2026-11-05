import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

os.environ.setdefault("INPUT_GH_TOKEN", "test-github-token")
os.environ.setdefault("INPUT_WAKATIME_API_KEY", "test-worker-key")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sources"))

from gitea_commits import get_gitea_commit_dates  # noqa: E402
import main  # noqa: E402
import graphics_list_formatter as formatter  # noqa: E402
from manager_environment import EnvironmentManager as EM  # noqa: E402
from manager_file import FileManager as FM  # noqa: E402
from manager_debug import init_debug_manager  # noqa: E402

init_debug_manager()


def commit(sha, author_id=45, email="other@example.test", date="2026-11-02T01:30:00+08:00"):
    return {"sha": sha * 40, "author": {"id": author_id} if author_id else None, "commit": {"author": {"email": email}, "committer": {"date": date}}}


class GiteaCommitTests(unittest.IsolatedAsyncioTestCase):
    async def collect(self, handler, url="https://gitea.example.test"):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url=url + "/api/v1/", headers={"Authorization": "token secret"})
        try:
            with patch("gitea_commits.httpx.AsyncClient", return_value=client):
                return await get_gitea_commit_dates(url, "secret")
        finally:
            await client.aclose()

    async def test_all_pages_and_branches_match_identity_and_deduplicate(self):
        calls = []

        def handler(request):
            self.assertEqual(request.headers["Authorization"], "token secret")
            path = request.url.path.removeprefix("/api/v1/")
            page = int(request.url.params.get("page", 1))
            calls.append((path, dict(request.url.params)))
            if path == "user":
                return httpx.Response(200, json={"id": 45, "login": "me"})
            if path == "user/emails":
                return httpx.Response(200, json=[{"email": "mine@example.test", "verified": True}, {"email": "unverified@example.test", "verified": False}])
            if path == "user/repos":
                rows = [{"id": page, "owner": {"login": "org"}, "name": f"repo{page}", "empty": False, "default_branch": "main"}] if page <= 2 else []
                return httpx.Response(200, json=rows)
            if path.endswith("/branches"):
                rows = (
                    [
                        {"name": "main", "commit": {"id": "a" * 40}},
                        {"name": "merged", "commit": {"id": "b" * 40}},
                        {"name": "feature", "commit": {"id": "d" * 40}},
                    ]
                    if page == 1
                    else []
                )
                return httpx.Response(200, json=rows)
            if path.endswith("/commits"):
                self.assertEqual(request.url.params["stat"], "false")
                self.assertEqual(request.url.params["files"], "false")
                if request.url.params["sha"] == "a" * 40:
                    rows = {1: [commit("a"), commit("b", 46)], 2: [commit("c", None, "mine@example.test")]}.get(page, [])
                else:
                    self.assertEqual(request.url.params["not"], "a" * 40)
                    rows = [commit("d"), commit("a"), commit("e", None, "unverified@example.test")] if page == 1 else []
                return httpx.Response(200, json=rows)
            raise AssertionError(path)

        result = await self.collect(handler)
        self.assertEqual(result, {letter * 40: "2026-11-01T17:30:00Z" for letter in "acd"})
        self.assertFalse(any(params.get("sha") == "b" * 40 for _, params in calls))
        self.assertTrue(any(path == "repos/org/repo2/commits" for path, _ in calls))

    async def test_api_failure_is_redacted_and_never_returns_partial_data(self):
        with self.assertRaisesRegex(RuntimeError, "HTTP 403") as raised:
            await self.collect(lambda request: httpx.Response(403, text="secret private repo"))
        self.assertNotIn("secret", str(raised.exception))
        self.assertNotIn("private repo", str(raised.exception))

    async def test_insecure_url_is_rejected_before_authentication(self):
        with self.assertRaises(ValueError):
            await get_gitea_commit_dates("http://gitea.example.test", "secret")

    async def test_worker_snapshot_uses_header_auth_and_validates_before_returning(self):
        from gitea_commits import get_gitea_snapshot

        data = {"a" * 40: "2026-11-01T17:30:00Z"}

        def handler(request):
            self.assertEqual(str(request.url), "https://stats.test/api/v1/users/current/gitea/commits")
            self.assertEqual(request.headers["Authorization"], "Bearer secret")
            return httpx.Response(200, json={"data": data})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("gitea_commits.httpx.AsyncClient", return_value=client):
            self.assertEqual(await get_gitea_snapshot("https://stats.test/api/v1/", "secret"), data)
        from gitea_commits import validate_commit_dates

        for bad in ({}, [], {"a" * 40: "2026-02-30T00:00:00Z"}, {"secret": "private message"}):
            with self.assertRaisesRegex(ValueError, "Invalid Gitea snapshot"):
                validate_commit_dates(bad)

    async def test_manual_import_uploads_only_validated_snapshot_and_checks_acknowledgement(self):
        import runpy
        import tempfile
        from types import SimpleNamespace

        sync = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/sync-gitea.py"))["sync"]
        data = {"a" * 40: "2026-11-01T17:30:00Z"}

        def handler(request):
            self.assertEqual(request.method, "PUT")
            self.assertEqual(request.headers["Authorization"], "Bearer worker-secret")
            import json

            self.assertEqual(json.loads(request.content), data)
            return httpx.Response(200, json={"count": 1})

        with tempfile.TemporaryDirectory() as directory:
            key, snapshot = Path(directory) / "key", Path(directory) / "snapshot.json"
            key.write_text("worker-secret")
            import json

            snapshot.write_text(json.dumps(data))
            args = SimpleNamespace(worker_api="https://stats.test/api/v1/", key_file=key, snapshot=snapshot)
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            with patch("httpx.AsyncClient", return_value=client):
                await sync(args)
            snapshot.write_text("{}")
            with patch("httpx.AsyncClient") as client_factory:
                with self.assertRaisesRegex(ValueError, "Invalid Gitea snapshot"):
                    await sync(args)
                client_factory.assert_not_called()


class GiteaIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_gitea_only_supplements_distribution_and_excludes_github_shas(self):
        flags = {name: False for name in vars(EM) if name.startswith("SHOW_")}
        flags.update(GITEA_USE_SNAPSHOT=False, SHOW_COMMIT=True, SHOW_DAYS_OF_WEEK=True, GITEA_API_URL="https://gitea.example.test", GITEA_API_TOKEN="secret")
        repos = [{"name": "existing"}]
        github = {"existing": {"main": {"a" * 40: "2026-11-01T17:30:00Z"}}}
        extra = {"a" * 40: "2026-11-01T17:30:00Z", "b" * 40: "2026-11-01T23:30:00Z"}
        with patch.multiple(EM, **flags), patch.object(main.DM, "get_remote_json", AsyncMock(return_value={"data": {"timezone": "Asia/Shanghai"}})):
            with patch.object(main, "get_gitea_commit_dates", AsyncMock(return_value=extra)) as collect:
                with patch.object(main, "make_commit_day_time_list", AsyncMock(return_value="combined")) as render:
                    self.assertIn("combined", await main.get_waka_time_stats(repos, github))
                    render.assert_awaited_once_with("Asia/Shanghai", repos, github, ["2026-11-01T23:30:00Z"])
                    self.assertEqual(repos, [{"name": "existing"}])
                    collect.assert_awaited_once()
                    collect.reset_mock()
                    with patch.object(EM, "GITEA_API_URL", ""):
                        await main.get_waka_time_stats(repos, github)
                    collect.assert_not_awaited()
                    with patch.object(EM, "GITEA_USE_SNAPSHOT", True), patch.object(main, "get_gitea_snapshot", AsyncMock(return_value=extra)) as snapshot:
                        await main.get_waka_time_stats(repos, github)
                        snapshot.assert_awaited_once_with(EM.WAKATIME_API_URL, EM.WAKATIME_API_KEY)
                        collect.assert_not_awaited()
                        self.assertEqual(render.call_args.args[-1], ["2026-11-01T23:30:00Z"])

    async def test_combined_dates_use_existing_timezone_and_buckets(self):
        commits = {"existing": {"main": {"a": "2026-11-01T17:30:00Z"}}}
        with patch.multiple(EM, SHOW_COMMIT=True, SHOW_DAYS_OF_WEEK=True), patch.object(FM, "t", side_effect=lambda value: value):
            with patch.object(formatter, "make_list", return_value="bars") as bars:
                # Translation normally supplies the weekday title placeholder.
                with patch.object(FM, "t", side_effect=lambda value: "%s" if value == "I am Most Productive on" else value):
                    await formatter.make_commit_day_time_list("Asia/Shanghai", [{"name": "existing"}], commits, ["2026-11-01T23:30:00Z"])
                self.assertEqual(bars.call_args_list[0].kwargs["texts"], ["1 commits", "0 commits", "0 commits", "1 commits"])
                self.assertEqual(bars.call_args_list[1].kwargs["texts"], ["2 commits"] + ["0 commits"] * 6)


if __name__ == "__main__":
    unittest.main()
