"""Destination policy for polli's server-side URL fetching (web_scrape tools)."""

import asyncio
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

from src.integrations import web_scraper


class DestinationPolicyUnitTests(unittest.TestCase):
    def test_blocks_internal_destinations(self):
        blocked = [
            "http://127.0.0.1:55288/api",
            "http://localhost/admin",
            "http://api.localhost/",
            "http://service.local/",
            "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
            "http://10.0.0.1/",
            "http://192.168.1.1/",
            "http://172.17.0.1/",
            "http://100.64.0.1/",
            "http://[::1]:8080/",
            "http://[fe80::1]/",
            # WHATWG-normalized obfuscated loopback literals
            "http://0x7f.0.0.1/",
            "http://2130706433/",
            # cloud metadata by name
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://metadata.goog/",
            # non-http schemes (file:// etc.)
            "file:///etc/passwd",
            "ftp://example.com/file",
            "gopher://127.0.0.1:70/",
        ]
        for url in blocked:
            with self.subTest(url=url):
                reason = web_scraper.blocked_destination_reason(url)
                self.assertIsNotNone(reason)
                self.assertTrue(reason)

    def test_allows_public_destinations(self):
        allowed = [
            "https://example.com/docs",
            "https://cdn.discordapp.com/attachments/1/2/file.json",
            "http://93.184.216.34/",  # public literal IP
            "https://github.com/pollinations/pollinations",
            "https://x.com/user/status/123",
            "http://example.com:8080/path?query=1",
        ]
        for url in allowed:
            with self.subTest(url=url):
                self.assertIsNone(web_scraper.blocked_destination_reason(url))


class _RecordingResponse:
    status = 200

    async def text(self):
        return '{"secret": "metadata-credentials"}'

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class _RecordingSession:
    fetched: list[str] = []

    def get(self, url, timeout=None):
        _RecordingSession.fetched.append(url)
        return _RecordingResponse()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class DestinationPolicyIntegrationTests(unittest.TestCase):
    def setUp(self):
        _RecordingSession.fetched = []

    def test_fetch_file_refuses_internal_urls_before_any_client(self):
        fake_aiohttp = types.SimpleNamespace(
            ClientSession=_RecordingSession,
            ClientTimeout=lambda total=None: total,
        )
        with patch.dict(sys.modules, {"aiohttp": fake_aiohttp}):
            result = asyncio.run(
                web_scraper.web_scrape_handler(
                    action="fetch_file",
                    file_url="http://169.254.169.254/latest/meta-data/iam/security-credentials/",
                    file_type="json",
                )
            )
        self.assertFalse(result.get("success"))
        self.assertIn("not allowed", result["error"])
        self.assertEqual(_RecordingSession.fetched, [])

    def test_fetch_file_still_fetches_public_files(self):
        fake_aiohttp = types.SimpleNamespace(
            ClientSession=_RecordingSession,
            ClientTimeout=lambda total=None: total,
        )
        with patch.dict(sys.modules, {"aiohttp": fake_aiohttp}):
            result = asyncio.run(
                web_scraper.web_scrape_handler(
                    action="fetch_file",
                    file_url="https://cdn.discordapp.com/attachments/1/2/data.json",
                    file_type="json",
                )
            )
        self.assertTrue(result.get("success"))
        self.assertEqual(
            _RecordingSession.fetched,
            ["https://cdn.discordapp.com/attachments/1/2/data.json"],
        )

    def test_scrape_url_refuses_internal_urls_before_any_fetcher(self):
        recorded: list[str] = []

        async def recording_fetcher(url, *args, **kwargs):
            recorded.append(url)
            return None

        with (
            patch.object(web_scraper, "_try_x_api", recording_fetcher),
            patch.object(web_scraper, "_try_rnet", recording_fetcher),
            patch.object(web_scraper, "_try_scrapling", recording_fetcher),
            patch.object(web_scraper, "_try_jina", recording_fetcher),
            patch.object(web_scraper, "_scrape_with_crawl4ai", recording_fetcher),
        ):
            result = asyncio.run(web_scraper.scrape_url("http://127.0.0.1:55288/api/keys"))
        self.assertFalse(result["success"])
        self.assertIn("not allowed", result["error"])
        self.assertEqual(recorded, [])

    def test_scrape_multiple_marks_blocked_urls_as_failures(self):
        with (
            patch.object(web_scraper, "_try_x_api", AsyncMock(return_value=None)),
            patch.object(web_scraper, "_try_rnet", AsyncMock(return_value=None)),
            patch.object(web_scraper, "_try_scrapling", AsyncMock(return_value=None)),
            patch.object(web_scraper, "_try_jina", AsyncMock(return_value=None)),
            patch.object(
                web_scraper,
                "_scrape_with_crawl4ai",
                AsyncMock(return_value={"success": False, "error": "unreachable"}),
            ),
        ):
            output = asyncio.run(web_scraper.scrape_multiple(["https://example.com/ok", "http://10.0.0.1/internal"]))
        self.assertFalse(output["success"])
        by_url = {item.get("url"): item for item in output["results"]}
        self.assertIn("not allowed", by_url["http://10.0.0.1/internal"]["error"])
        self.assertNotIn("not allowed", str(by_url.get("https://example.com/ok")))


if __name__ == "__main__":
    unittest.main()
