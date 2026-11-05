import os
import sys
import tempfile
import unittest
from contextlib import chdir
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("INPUT_GH_TOKEN", "test-github-token")
os.environ.setdefault("INPUT_WAKATIME_API_KEY", "test-worker-key")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sources"))

import httpx  # noqa: E402
import main  # noqa: E402
from git import Repo  # noqa: E402
from manager_debug import init_debug_manager  # noqa: E402
from manager_download import DownloadManager as DM  # noqa: E402
from manager_environment import EnvironmentManager as EM  # noqa: E402
from manager_file import FileManager as FM  # noqa: E402
from manager_github import GitHubManager as GHM  # noqa: E402

SVG = '<svg xmlns="http://www.w3.org/2000/svg"><title>Coding activity</title></svg>'
init_debug_manager()


class HeatmapDownloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_stats_failure_does_not_expose_query_key_or_response_body(self):
        response = httpx.Response(
            401,
            request=httpx.Request("GET", f"https://worker.example/api/v1/users/current/stats/all_time?api_key={EM.WAKATIME_API_KEY}"),
            json={"error": EM.WAKATIME_API_KEY},
        )
        with patch.object(DM, "_REMOTE_RESOURCES_CACHE", {"waka_all": response}):
            with self.assertRaises(Exception) as raised:
                await DM.get_remote_json("waka_all")
        self.assertNotIn(EM.WAKATIME_API_KEY, str(raised.exception))
        self.assertIn("401", str(raised.exception))

    async def fetch(self, handler):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with patch.object(DM, "_client", client), patch.object(EM, "MOCK_WAKATIME", False):
                with patch.object(EM, "WAKATIME_API_URL", "https://worker.example/api/v1/"):
                    return await DM.get_coding_heatmap()

    async def test_download_uses_header_auth_without_secret_in_url(self):
        def handler(request):
            self.assertEqual(str(request.url), "https://worker.example/api/v1/users/current/heatmap.svg")
            self.assertEqual(request.headers["authorization"], f"Bearer {EM.WAKATIME_API_KEY}")
            return httpx.Response(200, text=SVG, headers={"content-type": "image/svg+xml"})

        self.assertEqual(await self.fetch(handler), SVG)

    async def test_http_failure_does_not_include_remote_body_or_secret(self):
        with self.assertRaisesRegex(RuntimeError, "HTTP 503") as raised:
            await self.fetch(lambda request: httpx.Response(503, text=EM.WAKATIME_API_KEY))
        self.assertNotIn(EM.WAKATIME_API_KEY, str(raised.exception))

    async def test_rejects_html_instead_of_svg(self):
        with self.assertRaisesRegex(RuntimeError, "SVG"):
            await self.fetch(lambda request: httpx.Response(200, text="<html>login</html>"))

    async def test_mock_preview_does_not_request_network(self):
        mock_dir = Path(__file__).resolve().parents[1] / "sources" / "mock_data"
        with patch.object(EM, "MOCK_WAKATIME", True), patch.object(EM, "MOCK_DATA_DIR", str(mock_dir)):
            with patch.object(DM._client, "get", new_callable=AsyncMock) as get:
                self.assertIn("<svg", await DM.get_coding_heatmap())
                get.assert_not_awaited()


class HeatmapReadmeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        flags = {name: False for name in vars(EM) if name.startswith("SHOW_")}
        self.flags = patch.multiple(EM, **flags)
        self.flags.start()
        self.addCleanup(self.flags.stop)
        for target, name, value in (
            (main, "collect_user_repositories", AsyncMock(return_value=[])),
            (main, "get_waka_time_stats", AsyncMock(return_value="weekly stats\n")),
            (FM, "ASSETS_DIR", self.temp.name),
            (EM, "DEBUG_RUN", True),
        ):
            p = patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)

    async def test_disabled_leaves_existing_output_unchanged(self):
        with patch.object(DM, "get_coding_heatmap", new_callable=AsyncMock) as get:
            self.assertEqual(await main.get_stats(), "weekly stats\n")
            get.assert_not_awaited()

    async def test_enabled_saves_svg_and_uses_svg_debug_mime(self):
        with patch.object(EM, "SHOW_CODING_HEATMAP", True), patch.object(DM, "get_coding_heatmap", AsyncMock(return_value=SVG)):
            result = await main.get_stats()
        self.assertEqual((Path(self.temp.name) / "coding-heatmap.svg").read_text(), SVG)
        self.assertIn("data:image/svg+xml;base64,", result)
        self.assertLess(result.index("Coding Activity"), result.index("weekly stats"))

    async def test_fetch_failure_keeps_previous_image(self):
        image = Path(self.temp.name) / "coding-heatmap.svg"
        image.write_text(SVG)
        with patch.object(EM, "SHOW_CODING_HEATMAP", True), patch.object(DM, "get_coding_heatmap", AsyncMock(side_effect=RuntimeError("HTTP 503"))):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                await main.get_stats()
        self.assertEqual(image.read_text(), SVG)

    async def test_production_stages_svg_and_readme_with_public_image_link(self):
        with chdir(self.temp.name), Repo.init("profile") as repo:
            readme = Path("profile/README.md")
            readme.write_text("Intro\n<!--START_SECTION:waka-->\nold stats\n<!--END_SECTION:waka-->\n")
            remote = SimpleNamespace(default_branch="main", get_readme=lambda: SimpleNamespace(path="README.md"))
            with patch.multiple(GHM, REPO=repo, REMOTE=remote, _REMOTE_NAME="example/example", create=True):
                with patch.multiple(EM, DEBUG_RUN=False, SHOW_CODING_HEATMAP=True), patch.object(FM, "ASSETS_DIR", "assets"):
                    with patch.object(DM, "get_coding_heatmap", AsyncMock(return_value=SVG)):
                        stats = await main.get_stats()
                        GHM.update_readme(stats)
            self.assertEqual(Path("profile/assets/coding-heatmap.svg").read_text(), SVG)
            self.assertIn("https://raw.githubusercontent.com/example/example/main/assets/coding-heatmap.svg", readme.read_text())
            self.assertIn("Intro", readme.read_text())
            self.assertIn(("assets/coding-heatmap.svg", 0), repo.index.entries)
            self.assertIn(("README.md", 0), repo.index.entries)

    def test_png_debug_chart_remains_png(self):
        image = Path(self.temp.name) / "test.png"
        image.write_bytes(b"png fixture")
        self.assertIn("data:image/png;base64,", GHM.update_chart("Test", str(image)))

    def test_public_chart_url_changes_with_content_but_is_stable_when_unchanged(self):
        with chdir(self.temp.name), Repo.init("profile") as repo:
            Path("assets").mkdir()
            image = Path("assets/coding-heatmap.svg")
            image.write_text(SVG)
            remote = SimpleNamespace(default_branch="main")
            with patch.multiple(GHM, REPO=repo, REMOTE=remote, _REMOTE_NAME="example/example", create=True), patch.object(EM, "DEBUG_RUN", False):
                first = GHM.update_chart("Coding Activity", str(image))
                self.assertIn(f"?v={sha256(image.read_bytes()).hexdigest()[:12]}", first)
                self.assertEqual(first, GHM.update_chart("Coding Activity", str(image)))
                image.write_text(SVG.replace("Coding activity", "Updated activity"))
                updated = GHM.update_chart("Coding Activity", str(image))
                self.assertNotEqual(first, updated)
                self.assertEqual(Path("profile/assets/coding-heatmap.svg").read_bytes(), image.read_bytes())


if __name__ == "__main__":
    unittest.main()
