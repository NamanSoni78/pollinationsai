"""_fetch_bytes caps remote media at the platform's documented per-file limits.

The cap plumbing (content-length pre-check + streamed-byte check) exists but
only fires when ``max_bytes`` is passed. ``transcribe``, ``transform_audio``
and ``edit_image`` fetch unbounded remote bodies into the single shared
container today — an attacker-steered URL (or an endless stream) OOM-kills the
public floret model before any billing happens. These tests pin the default
cap and the per-caller wiring, mirroring test_fetch_retry.py's harness.
"""

from __future__ import annotations

import httpx
import pytest

from floret.tools import gen, media

MiB = 1024 * 1024


class _Chunks(httpx.AsyncByteStream):
    """A response body made of fixed chunks, with no content-length."""

    def __init__(self, chunks: list[bytes]):
        self._chunks = list(chunks)

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk


def _client(handler) -> httpx.AsyncClient:
    async def h(request: httpx.Request) -> httpx.Response:
        return await handler(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(h))


async def test_default_cap_rejects_lying_content_length(monkeypatch):
    """A server that *says* it will send 512 MiB is refused before buffering."""

    async def handler(request):
        return httpx.Response(
            200,
            headers={"content-length": str(512 * MiB)},
            stream=_Chunks([b"x" * 1024]),
        )

    fake = _client(handler)
    monkeypatch.setattr(gen, "_http_client", lambda: fake)
    with pytest.raises(ValueError, match="exceeds"):
        await gen._fetch_bytes("https://x/big.bin", attempts=1)
    await fake.aclose()


async def test_default_cap_enforces_streamed_bytes(monkeypatch):
    """No content-length header: the streamed check still bounds the buffer."""

    async def handler(request):
        return httpx.Response(200, stream=_Chunks([b"x" * (20 * MiB)] * 3))

    fake = _client(handler)
    monkeypatch.setattr(gen, "_http_client", lambda: fake)
    with pytest.raises(ValueError, match="exceeds"):
        await gen._fetch_bytes("https://x/big.bin", attempts=1)
    await fake.aclose()


async def test_explicit_cap_still_honoured(monkeypatch):
    """media.py passes its own (larger) cap — explicit caps keep working."""

    async def handler(request):
        return httpx.Response(
            200,
            headers={"content-length": str(60 * MiB)},
            stream=_Chunks([b"x" * 1024]),
        )

    fake = _client(handler)
    monkeypatch.setattr(gen, "_http_client", lambda: fake)
    data = await gen._fetch_bytes(
        "https://x/img.jpg", attempts=1, max_bytes=100 * MiB
    )
    assert data == b"x" * 1024
    await fake.aclose()


async def test_edit_image_caps_each_source(monkeypatch):
    """edit_image refuses an oversized source before any generation spend."""
    posts: list[str] = []

    async def handler(request):
        if request.method == "POST":
            posts.append(request.url.path)
            if request.url.path.endswith("/images/edits"):
                return httpx.Response(200, json={"data": [{"b64_json": "eHg="}]})
            return httpx.Response(200, json={"url": "https://m.example/u"})
        return httpx.Response(
            200,
            headers={"content-length": str(25 * MiB)},
            stream=_Chunks([b"x" * 1024]),
        )

    fake = _client(handler)
    monkeypatch.setattr(gen, "_http_client", lambda: fake)
    monkeypatch.setattr(media, "_http_client", lambda: fake)
    with pytest.raises(ValueError, match="exceeds"):
        await gen.edit_image("brighten it", "https://x/src.jpg")
    assert posts == []  # never reached the generation API
    await fake.aclose()


async def test_transcribe_caps_source(monkeypatch):
    """transcribe refuses an oversized source before the transcription POST."""
    posts: list[str] = []

    async def handler(request):
        if request.method == "POST":
            posts.append(request.url.path)
            return httpx.Response(200, json={"text": "ok"})
        return httpx.Response(
            200,
            headers={"content-length": str(200 * MiB)},
            stream=_Chunks([b"x" * 1024]),
        )

    fake = _client(handler)
    monkeypatch.setattr(gen, "_http_client", lambda: fake)
    with pytest.raises(ValueError, match="exceeds"):
        await gen.transcribe("https://x/big.mp3")
    assert posts == []
    await fake.aclose()
