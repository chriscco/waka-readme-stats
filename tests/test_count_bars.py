import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree

os.environ.setdefault("INPUT_GH_TOKEN", "test-token")
os.environ.setdefault("INPUT_WAKATIME_API_KEY", "test-key")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sources"))

from graphics_list_formatter import make_list, make_commit_day_time_list, make_language_per_repo_list  # noqa: E402
from manager_environment import EnvironmentManager as EM  # noqa: E402
from manager_file import FileManager as FM  # noqa: E402


class CountBarTests(unittest.IsolatedAsyncioTestCase):
    def test_counts_use_next_milestone_and_hide_percentages(self):
        with patch.multiple(EM, BAR_STYLE="text", SYMBOL_VERSION=1):
            for maximum, limit in [(0, 1), (26, 30), (680, 700), (1269, 2000), (2000, 3000)]:
                with self.subTest(maximum=maximum):
                    values = [maximum, maximum // 2]
                    output = make_list(names=["A", "B"], texts=[f"{n} commits" for n in values], counts=values, sort=False)
                    self.assertNotIn("%", output)
                    for line, n in zip(output.splitlines(), values):
                        self.assertIn(f"{n} commits", line)
                        self.assertEqual(line.count("█"), round(n / limit * 25))
                        self.assertEqual(line.count("█") + line.count("░"), 25)
            self.assertEqual(make_list(names=[], texts=[], counts=[]), "")

    def test_svg_count_width_and_existing_percentage_mode(self):
        with patch.object(EM, "BAR_STYLE", "svg"):
            output = make_list(names=["A", "B"], texts=["2000 commits", "1000 commits"], counts=[2000, 1000])
            self.assertNotIn("%", output)
            svg = ElementTree.fromstring(output)
            rects = svg.findall("{http://www.w3.org/2000/svg}rect")
            self.assertEqual([r.get("width") for r in rects], ["360", "240", "360", "120"])
            normal = make_list(names=["Python"], texts=["2 hrs"], percents=[25])
            self.assertIn("25.00%", normal)
        with patch.multiple(EM, BAR_STYLE="text", SYMBOL_VERSION=1):
            normal = make_list(names=["Python"], texts=["2 hrs"], percents=[25])
            self.assertIn("25.00 %", normal)
            self.assertEqual(normal.count("█"), 6)

    async def test_commit_time_and_weekday_groups_have_independent_scales(self):
        translations = {"I am Most Productive on": "Most productive: %s"}
        dates = {"repo": {"main": {"a": "2026-11-02T01:00:00Z", "b": "2026-11-02T01:01:00Z"}}}
        with patch.multiple(EM, BAR_STYLE="text", SYMBOL_VERSION=1, SHOW_COMMIT=True, SHOW_DAYS_OF_WEEK=True):
            with patch.object(FM, "t", side_effect=lambda text: translations.get(text, text)):
                output = await make_commit_day_time_list("Asia/Shanghai", [{"name": "repo"}], dates, ["2026-11-02T11:00:00Z", "2026-11-02T11:01:00Z"])
        self.assertNotIn("%", output)
        lines = output.splitlines()
        self.assertEqual(next(line for line in lines if "Morning" in line).count("█"), 17)
        self.assertEqual(next(line for line in lines if line.startswith("Monday")).count("█"), 20)
        self.assertIn("Most productive: Monday", output)

    def test_repo_language_counts_use_count_scale(self):
        repos = [{"name": str(i), "primaryLanguage": {"name": "Python" if i < 3 else "Rust"}} for i in range(5)]
        with patch.multiple(EM, BAR_STYLE="text", SYMBOL_VERSION=1, IGNORED_REPOS=[]):
            with patch.object(FM, "t", return_value="Languages: %s"):
                output = make_language_per_repo_list(repos)
        self.assertNotIn("%", output)
        line = next(line for line in output.splitlines() if line.startswith("Python"))
        self.assertIn("3 repos", line)
        self.assertEqual(line.count("█"), 19)


if __name__ == "__main__":
    unittest.main()
