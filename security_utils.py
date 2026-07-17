from __future__ import annotations

import ipaddress
import json
import os
import socket
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import requests

PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
ALLOWED_IMAGE_CONTENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
}


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
    if os.name != "nt":
        try:
            path.chmod(PRIVATE_DIR_MODE)
        except OSError:
            pass


def restrict_file_permissions(path: Path) -> None:
    if os.name != "nt" and path.exists():
        try:
            path.chmod(PRIVATE_FILE_MODE)
        except OSError:
            pass


def atomic_write_bytes(path: Path, data: bytes, mode: int = PRIVATE_FILE_MODE) -> None:
    ensure_private_dir(path.parent)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        if os.name != "nt":
            os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        restrict_file_permissions(path)
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        finally:
            raise


def atomic_write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    atomic_write_bytes(path, text.encode(encoding))


def atomic_write_json(path: Path, value: Any, *, indent: int | None = None) -> None:
    payload = json.dumps(value, ensure_ascii=False, indent=indent)
    atomic_write_text(path, payload)


def _resolved_public_addresses(hostname: str, port: int = 443) -> list[ipaddress._BaseAddress]:
    try:
        infos = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("Cover host could not be resolved") from exc

    addresses: list[ipaddress._BaseAddress] = []
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global:
            raise ValueError("Cover URL resolves to a non-public address")
        addresses.append(address)

    if not addresses:
        raise ValueError("Cover host did not resolve")
    return addresses


def validate_public_https_url(url: str) -> str:
    if not isinstance(url, str) or len(url) > 2048:
        raise ValueError("Invalid cover URL")

    parsed = urlparse(url)
    if parsed.scheme.lower() != "https":
        raise ValueError("Cover URL must use HTTPS")
    if not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Invalid cover URL authority")
    if parsed.port not in (None, 443):
        raise ValueError("Cover URL must use port 443")

    # This DNS check blocks loopback, private, link-local, multicast, reserved,
    # and otherwise non-public destinations. Each redirect is checked again.
    _resolved_public_addresses(parsed.hostname, parsed.port or 443)
    return url


def download_public_image(
    url: str,
    *,
    max_bytes: int,
    timeout: tuple[int, int] = (5, 20),
    max_redirects: int = 3,
) -> tuple[bytes, str, str]:
    """Download a bounded public HTTPS raster image.

    Returns ``(body, content_type, final_url)``. Redirect destinations are
    validated individually to prevent SSRF through a public redirector.
    """

    current_url = validate_public_https_url(url)
    headers = {
        "User-Agent": "Litero/1.0 (+local Readwise client)",
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1",
    }

    with requests.Session() as session:
        session.trust_env = False
        for redirect_count in range(max_redirects + 1):
            with session.get(
                current_url,
                headers=headers,
                stream=True,
                allow_redirects=False,
                timeout=timeout,
            ) as response:
                if response.is_redirect or response.is_permanent_redirect:
                    if redirect_count >= max_redirects:
                        raise ValueError("Too many cover redirects")
                    location = response.headers.get("Location")
                    if not location:
                        raise ValueError("Cover redirect omitted a destination")
                    current_url = validate_public_https_url(urljoin(current_url, location))
                    continue

                response.raise_for_status()
                content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
                    raise ValueError("Unsupported cover image type")

                content_length = response.headers.get("Content-Length")
                if content_length:
                    try:
                        declared_size = int(content_length)
                    except (TypeError, ValueError) as exc:
                        raise ValueError("Invalid cover Content-Length") from exc
                    if declared_size < 0 or declared_size > max_bytes:
                        raise ValueError("Cover image exceeds size limit")

                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError("Cover image exceeds size limit")
                    chunks.append(chunk)

                body = b"".join(chunks)
                if not body:
                    raise ValueError("Empty cover response")
                return body, content_type, current_url

    raise ValueError("Unable to download cover")
