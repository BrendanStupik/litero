#!/usr/bin/env python3

import os
import re
import sys
import time
import csv
import json
import hashlib
import hmac
import ipaddress
import mimetypes
import secrets as secrets_module
import sqlite3
import subprocess
import threading
import requests
import unicodedata
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from flask import Flask, request, jsonify, send_file, send_from_directory, abort, make_response

from security_utils import (
    atomic_write_bytes,
    atomic_write_json,
    atomic_write_text,
    download_public_image,
    ensure_private_dir,
    restrict_file_permissions,
)

# =============================================================================
# 1. CONFIGURATION & SETUP
# =============================================================================

BASE_DIR = Path(__file__).resolve().parent

def get_app_data_dir():
    home = Path.home()
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "Litero"
    elif sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Litero"
    else:
        return Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share")) / "Litero"

def get_config_dir():
    home = Path.home()
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "Litero"
    elif sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Litero"
    else:
        return Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "Litero"

APP_DIR = get_app_data_dir()
CONFIG_DIR = get_config_dir()

ensure_private_dir(APP_DIR)
ensure_private_dir(CONFIG_DIR)
COVERS_DIR = APP_DIR / "covers"
ensure_private_dir(COVERS_DIR)

# File Path Constants
ONTOLOGY_CSV_PATH = CONFIG_DIR / "readwise_tags.csv"
TAXONOMY_CONFIG_PATH = CONFIG_DIR / "taxonomy.json"
SRS_DB_FILE = APP_DIR / "srs_review.db"
BOOK_CACHE_FILE = APP_DIR / "readwise_book_cache.json"
LOCAL_JSON_CACHE = APP_DIR / "readwise_cache.json"
SYNC_TRACKER_FILE = APP_DIR / "readwise_sync_state.txt"
WIKI_CACHE_FILE = APP_DIR / "wiki_cache.json"

BOOK_CACHE_VERSION = 2
BOOK_CACHE_LOCK = threading.RLock()
DATA_LOCK = threading.RLock()
WIKI_CACHE_LOCK = threading.RLock()
COVER_LOCKS = {}
COVER_LOCKS_GUARD = threading.Lock()
CSRF_COOKIE_NAME = "litero_csrf"
CSRF_TOKEN = secrets_module.token_urlsafe(32)
MAX_COVER_BYTES = 20 * 1024 * 1024
MAX_TEXT_LENGTH = 100_000
MAX_TAG_LENGTH = 200
MAX_QUERY_LENGTH = 1_000
MAX_TAXONOMY_ITEMS = 200
READWISE_TIMEOUT = (5, 60)

SENSITIVE_FILES = (
    CONFIG_DIR / "secrets.json",
    ONTOLOGY_CSV_PATH,
    TAXONOMY_CONFIG_PATH,
    SRS_DB_FILE,
    BOOK_CACHE_FILE,
    LOCAL_JSON_CACHE,
    SYNC_TRACKER_FILE,
    WIKI_CACHE_FILE,
)
for sensitive_path in SENSITIVE_FILES:
    restrict_file_permissions(sensitive_path)

def load_secrets():
    # 1. check environment variables
    if os.environ.get("READWISE_API_KEY"):
        return {
            "READWISE_API_KEY": os.environ.get("READWISE_API_KEY"),
            "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", ""),
            "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY", ""),
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", "")
        }

    # 2. check config secrets.json
    secrets_path = CONFIG_DIR / "secrets.json"

    if secrets_path.exists():
        try:
            with open(secrets_path, "r") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading secrets: {e}")

    print(f"\n[Warning] secrets.json not found, and readwise environment variables not set. Run setup.py or export environment variables.")
    return {}

SECRETS = load_secrets()
API_TOKEN = SECRETS.get("READWISE_API_KEY", "")

# Start Flask
app = Flask(__name__, static_folder=None)
app.config.update(
    MAX_CONTENT_LENGTH=1 * 1024 * 1024,
    TRUSTED_HOSTS=["127.0.0.1", "localhost"],
    JSON_SORT_KEYS=False,
)

MEMORY_DB = {
    "highlights": [],
    "all_unique_tags": set(),
    "all_book_tags": set(),
    "ontology": {},
}


def _is_loopback_address(value):
    try:
        return ipaddress.ip_address(value).is_loopback
    except (TypeError, ValueError):
        return False


def _json_error(message, status_code):
    return jsonify({"success": False, "error": message}), status_code


@app.before_request
def protect_local_app():
    if request.remote_addr and not _is_loopback_address(request.remote_addr):
        abort(403)

    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if not request.is_json:
            abort(415)

        if request.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
            abort(403)

        origin = request.headers.get("Origin")
        expected_origin = f"{request.scheme}://{request.host}"
        if origin and origin != expected_origin:
            abort(403)

        supplied_token = request.cookies.get(CSRF_COOKIE_NAME, "")
        if not hmac.compare_digest(supplied_token, CSRF_TOKEN):
            abort(403)


@app.after_request
def set_security_headers(response):
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https://upload.wikimedia.org; "
        "connect-src 'self'; "
        "font-src 'self'; "
        "object-src 'none'; "
        "base-uri 'none'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Origin-Agent-Cluster"] = "?1"
    if request.path.startswith("/api/") and not request.path.startswith("/api/covers/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.errorhandler(400)
def bad_request(_error):
    return _json_error("Invalid request.", 400)


@app.errorhandler(403)
def forbidden(_error):
    return _json_error("Request rejected.", 403)


@app.errorhandler(404)
def not_found(_error):
    return _json_error("Not found.", 404)


@app.errorhandler(413)
def payload_too_large(_error):
    return _json_error("Request body is too large.", 413)


@app.errorhandler(415)
def unsupported_media_type(_error):
    return _json_error("JSON request body required.", 415)


def request_json():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400)
    return data


def bounded_string(data, key, *, max_length, default="", required=False):
    value = data.get(key, default)
    if value is None:
        value = default
    if not isinstance(value, str):
        abort(400)
    value = value.strip() if key not in {"note", "text"} else value
    if required and not value:
        abort(400)
    if len(value) > max_length:
        abort(400)
    return value


def bounded_string_list(data, key, *, max_items=200, item_max_length=200):
    value = data.get(key, [])
    if not isinstance(value, list) or len(value) > max_items:
        abort(400)
    result = []
    for item in value:
        if not isinstance(item, str) or len(item) > item_max_length:
            abort(400)
        result.append(item)
    return result


def save_highlights_cache():
    with DATA_LOCK:
        atomic_write_json(LOCAL_JSON_CACHE, MEMORY_DB["highlights"])

# =============================================================================
# 2. CORE UTILITIES & DATA PROCESSING
# =============================================================================

def remove_diacritics(input_str):
    if not input_str:
        return ""
    nfkd_form = unicodedata.normalize("NFKD", str(input_str))
    return "".join([c for c in nfkd_form if not unicodedata.combining(c)])

def _empty_book_cache():
    return {"version": BOOK_CACHE_VERSION, "books": {}, "legacy_titles": {}}

def load_book_cache():
    if not BOOK_CACHE_FILE.exists():
        return _empty_book_cache()

    try:
        with open(BOOK_CACHE_FILE, "r", encoding="utf-8") as f:
            raw_cache = json.load(f)
    except Exception as e:
        print(f"[Cover Cache] Could not read cache metadata: {e}")
        return _empty_book_cache()

    if (
        isinstance(raw_cache, dict)
        and raw_cache.get("version") == BOOK_CACHE_VERSION
        and isinstance(raw_cache.get("books"), dict)
    ):
        raw_cache.setdefault("legacy_titles", {})
        return raw_cache

    if isinstance(raw_cache, dict):
        migrated = _empty_book_cache()
        migrated["legacy_titles"] = raw_cache
        return migrated

    return _empty_book_cache()

def save_book_cache(book_cache):
    atomic_write_json(BOOK_CACHE_FILE, book_cache, indent=2)

def get_book_cache_key(user_book_id, title="", author=""):
    if user_book_id not in (None, ""):
        return str(user_book_id)

    fallback = f"{title}\0{author}".encode("utf-8", errors="ignore")
    return "anon-" + hashlib.sha256(fallback).hexdigest()[:24]

def _cover_digest(book_key):
    return hashlib.sha256(str(book_key).encode("utf-8")).hexdigest()


def _extension_from_image(content_type="", remote_url="", image_data=None):
    content_type = (content_type or "").split(";", 1)[0].strip().lower()
    known_types = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/avif": ".avif",
        "image/bmp": ".bmp",
        "image/tiff": ".tiff",
    }
    if content_type in known_types:
        return known_types[content_type]

    if image_data:
        if image_data.startswith(b"\xff\xd8\xff"):
            return ".jpg"
        if image_data.startswith(b"\x89PNG\r\n\x1a\n"):
            return ".png"
        if image_data.startswith((b"GIF87a", b"GIF89a")):
            return ".gif"
        if image_data.startswith(b"RIFF") and image_data[8:12] == b"WEBP":
            return ".webp"
        if len(image_data) >= 12 and image_data[4:12] in (b"ftypavif", b"ftypavis"):
            return ".avif"
        if image_data.startswith(b"BM"):
            return ".bmp"
        if image_data.startswith((b"II*\x00", b"MM\x00*")):
            return ".tiff"

    guessed_type = mimetypes.guess_type((remote_url or "").split("?", 1)[0])[0] or ""
    return known_types.get(guessed_type.lower(), ".jpg")


def _strict_image_extension(image_data):
    if image_data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if image_data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if image_data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if image_data.startswith(b"RIFF") and len(image_data) >= 12 and image_data[8:12] == b"WEBP":
        return ".webp"
    if len(image_data) >= 12 and image_data[4:12] in (b"ftypavif", b"ftypavis"):
        return ".avif"
    raise ValueError("Downloaded file is not a supported raster image")


def _cover_filename(book_key, extension=".jpg"):
    if not extension.startswith("."):
        extension = f".{extension}"
    return f"{_cover_digest(book_key)}{extension.lower()}"


def _local_cover_url(book_key):
    return f"/api/covers/{book_key}"


@contextmanager
def cover_lock(book_key):
    with COVER_LOCKS_GUARD:
        record = COVER_LOCKS.setdefault(book_key, {"lock": threading.Lock(), "users": 0})
        record["users"] += 1
        lock = record["lock"]
    lock.acquire()
    try:
        yield
    finally:
        lock.release()
        with COVER_LOCKS_GUARD:
            current = COVER_LOCKS.get(book_key)
            if current is record:
                current["users"] -= 1
                if current["users"] == 0:
                    COVER_LOCKS.pop(book_key, None)


def _cover_path(entry):
    filename = entry.get("filename", "")
    return COVERS_DIR / filename if filename else None


def _delete_cached_cover(entry):
    filename = entry.get("filename")
    if filename:
        try:
            (COVERS_DIR / filename).unlink(missing_ok=True)
        except Exception as e:
            print(f"[Cover Cache] Could not remove stale cover {filename}: {e}")

    # Older cache versions used the same hash with a .img suffix. Remove any
    # stale sibling left behind after a URL change.
    book_key = entry.get("book_key")
    if book_key:
        try:
            (COVERS_DIR / _cover_filename(book_key, ".img")).unlink(missing_ok=True)
        except Exception as e:
            print(f"[Cover Cache] Could not remove legacy cover for {book_key}: {e}")


def _normalize_cached_filename(entry):
    book_key = entry.get("book_key")
    if not book_key:
        return

    old_filename = entry.get("filename") or _cover_filename(
        book_key,
        _extension_from_image(remote_url=entry.get("remote_cover_url", "")),
    )
    old_path = COVERS_DIR / old_filename

    image_data = None
    if old_path.is_file():
        try:
            with open(old_path, "rb") as f:
                image_data = f.read(32)
        except OSError:
            pass

    extension = _extension_from_image(
        content_type=entry.get("content_type", ""),
        remote_url=entry.get("remote_cover_url", ""),
        image_data=image_data,
    )
    new_filename = _cover_filename(book_key, extension)
    new_path = COVERS_DIR / new_filename

    if old_path.is_file() and old_path != new_path and not new_path.exists():
        try:
            os.replace(old_path, new_path)
        except OSError as e:
            print(f"[Cover Cache] Could not rename {old_filename}: {e}")
            return
    elif old_path.is_file() and old_path != new_path and new_path.exists():
        old_path.unlink(missing_ok=True)

    entry["filename"] = new_filename


def register_books_in_cache(book_data, book_cache):
    books_cache = book_cache.setdefault("books", {})
    legacy_titles = book_cache.setdefault("legacy_titles", {})

    for book in book_data:
        title = book.get("title", "Unknown Title")
        author = book.get("author", "")
        book_key = get_book_cache_key(book.get("user_book_id"), title, author)
        entry = books_cache.get(book_key, {})
        legacy_entry = legacy_titles.get(title, {}) if isinstance(legacy_titles, dict) else {}

        has_cover_metadata = "cover_image_url" in book
        incoming_url = (
            book.get("cover_image_url") or ""
            if has_cover_metadata
            else entry.get("remote_cover_url", "")
        )
        previous_url = entry.get("remote_cover_url", "")
        url_changed = incoming_url != previous_url

        if url_changed:
            _delete_cached_cover(entry)
            entry.pop("content_hash", None)
            entry.pop("content_type", None)
            entry.pop("upstream_etag", None)
            entry.pop("upstream_last_modified", None)
            entry.pop("last_checked", None)
            entry.pop("metadata_checked_at", None)
            entry["needs_refresh"] = bool(incoming_url)
            entry["filename"] = _cover_filename(
                book_key,
                _extension_from_image(remote_url=incoming_url),
            )

        entry.update({
            "book_key": book_key,
            "user_book_id": book.get("user_book_id"),
            "title": title,
            "author": author,
            "remote_cover_url": incoming_url,
            "filename": entry.get("filename") or _cover_filename(
                book_key,
                _extension_from_image(remote_url=incoming_url),
            ),
            "readwise_url": book.get("readwise_url") or entry.get("readwise_url") or legacy_entry.get("readwise_url", ""),
            "category": book.get("category") or entry.get("category") or legacy_entry.get("category", "books"),
            "book_tags": (
                [t.get("name") for t in book.get("book_tags", []) if t.get("name")]
                or entry.get("book_tags")
                or legacy_entry.get("book_tags", [])
            ),
        })

        old_cover_url = legacy_entry.get("cover_url", "") if isinstance(legacy_entry, dict) else ""
        if old_cover_url and not incoming_url and old_cover_url.startswith("http"):
            entry["remote_cover_url"] = old_cover_url
            entry["filename"] = _cover_filename(
                book_key,
                _extension_from_image(remote_url=old_cover_url),
            )
            entry["needs_refresh"] = True

        old_local_path = BASE_DIR / old_cover_url if old_cover_url and not old_cover_url.startswith("http") else None
        if old_local_path and old_local_path.is_file():
            try:
                image_data = old_local_path.read_bytes()
                content_type = mimetypes.guess_type(old_local_path.name)[0] or ""
                extension = _extension_from_image(content_type, image_data=image_data[:32])
                entry["filename"] = _cover_filename(book_key, extension)
                new_local_path = COVERS_DIR / entry["filename"]
                if not new_local_path.exists():
                    atomic_write_bytes(new_local_path, image_data)
                entry["content_hash"] = hashlib.sha256(image_data).hexdigest()
                entry["content_type"] = content_type or mimetypes.guess_type(new_local_path.name)[0] or "image/jpeg"
                entry["needs_refresh"] = False
            except Exception as e:
                print(f"[Cover Cache] Could not migrate {old_local_path}: {e}")

        _normalize_cached_filename(entry)
        books_cache[book_key] = entry


def seed_book_cache_from_highlights(highlights, book_cache):
    books_cache = book_cache.setdefault("books", {})
    for hl in highlights:
        title = hl.get("book_title", "Unknown Title")
        author = hl.get("book_author", "")
        book_key = get_book_cache_key(hl.get("user_book_id"), title, author)
        entry = books_cache.get(book_key, {})
        existing_cover = hl.get("cover_url", "")

        entry.update({
            "book_key": book_key,
            "user_book_id": hl.get("user_book_id"),
            "title": title,
            "author": author,
            "filename": entry.get("filename") or _cover_filename(
                book_key,
                _extension_from_image(remote_url=existing_cover),
            ),
            "readwise_url": hl.get("readwise_url") or entry.get("readwise_url", ""),
            "category": hl.get("category") or entry.get("category", "books"),
            "book_tags": hl.get("book_tags") or entry.get("book_tags", []),
        })

        if existing_cover.startswith("http") and not entry.get("remote_cover_url"):
            entry["remote_cover_url"] = existing_cover
            entry["filename"] = _cover_filename(
                book_key,
                _extension_from_image(remote_url=existing_cover),
            )
            entry["needs_refresh"] = True
        elif existing_cover and not existing_cover.startswith("http"):
            old_local_path = BASE_DIR / existing_cover.lstrip("/")
            if old_local_path.is_file():
                try:
                    image_data = old_local_path.read_bytes()
                    content_type = mimetypes.guess_type(old_local_path.name)[0] or ""
                    extension = _extension_from_image(content_type, image_data=image_data[:32])
                    entry["filename"] = _cover_filename(book_key, extension)
                    new_local_path = COVERS_DIR / entry["filename"]
                    if not new_local_path.exists():
                        atomic_write_bytes(new_local_path, image_data)
                    entry["content_hash"] = hashlib.sha256(image_data).hexdigest()
                    entry["content_type"] = content_type or mimetypes.guess_type(new_local_path.name)[0] or "image/jpeg"
                    entry["needs_refresh"] = False
                except Exception as e:
                    print(f"[Cover Cache] Could not migrate {old_local_path}: {e}")

        _normalize_cached_filename(entry)
        books_cache[book_key] = entry


def apply_cached_cover_urls(highlights, book_cache):
    books_cache = book_cache.get("books", {})
    for hl in highlights:
        book_key = get_book_cache_key(
            hl.get("user_book_id"),
            hl.get("book_title", ""),
            hl.get("book_author", ""),
        )
        entry = books_cache.get(book_key)
        if not entry:
            continue

        filepath = _cover_path(entry)
        local_file_exists = bool(filepath and filepath.is_file())
        if entry.get("remote_cover_url") or local_file_exists:
            hl["cover_url"] = _local_cover_url(book_key)
        else:
            hl["cover_url"] = ""


def _entry_needs_refresh(entry, filepath):
    if not entry.get("remote_cover_url"):
        return False
    return bool(entry.get("needs_refresh")) or not filepath.exists()


def refresh_cached_cover(entry):
    remote_url = entry.get("remote_cover_url", "")
    filepath = _cover_path(entry)
    if not remote_url:
        return filepath if filepath and filepath.exists() else None

    try:
        image_data, content_type, final_url = download_public_image(
            remote_url,
            max_bytes=MAX_COVER_BYTES,
        )
        extension = _strict_image_extension(image_data[:32])
        expected_type = {
            ".jpg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".avif": "image/avif",
        }[extension]
        if content_type != expected_type:
            raise ValueError("Cover MIME type does not match its contents")

        new_filename = _cover_filename(entry["book_key"], extension)
        new_filepath = COVERS_DIR / new_filename
        atomic_write_bytes(new_filepath, image_data)

        if filepath and filepath != new_filepath:
            filepath.unlink(missing_ok=True)

        entry["filename"] = new_filename
        entry["content_hash"] = hashlib.sha256(image_data).hexdigest()
        entry["content_type"] = content_type
        entry["resolved_cover_url"] = final_url
        entry.pop("upstream_etag", None)
        entry.pop("upstream_last_modified", None)
        entry.pop("last_checked", None)
        entry.pop("metadata_checked_at", None)
        entry["needs_refresh"] = False
        return new_filepath
    except Exception as e:
        print(f"[Cover Cache] Failed to refresh cover for {entry.get('book_key')}: {e}")
        # Preserve a previously cached image if the network is temporarily down.
        if filepath and filepath.exists():
            entry["needs_refresh"] = False
            return filepath
        return None

def load_ontology():
    ontology = {}
    if os.path.exists(ONTOLOGY_CSV_PATH):
        with open(ONTOLOGY_CSV_PATH, mode="r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                tag = row.get("Tag", "").strip()
                if tag:
                    ontology[tag.lower()] = {
                        "Category": row.get("Category", "").strip(),
                        "Field": row.get("Field", "").strip(),
                        "Role": row.get("Role (If Person)", "").strip(),
                        "Date": row.get("Lifespan (If Person)", "").strip(),
                    }
    return ontology
def group_tags_by_ontology(related_tags_set):
    # this currently groups persons in the people section and everyhing else in field subsections. 
    grouped_tags = {"Person": []}

    for tag in related_tags_set:
        tag_lower = tag.lower()
        ontology_data = MEMORY_DB["ontology"].get(tag_lower, {})
        cat = ontology_data.get("Category", "").strip()

        if not cat:
            cat = "Uncategorized"

        if cat.lower() == "person":
            grouped_tags["Person"].append(tag)
        else:
            if cat not in grouped_tags:
                grouped_tags[cat] = defaultdict(list)

            fields_raw = ontology_data.get("Field", "Uncategorized")
            fields = [f.strip() for f in fields_raw.split(",") if f.strip()]
            if not fields:
                fields = ["Uncategorized"]

            for field in fields:
                grouped_tags[cat][field].append(tag)

    sorted_groups = {}
    for cat, content in grouped_tags.items():
        if cat == "Person":
            if content:
                sorted_groups[cat] = sorted(content)
        else:
            sorted_groups[cat] = {}
            for field, tags in content.items():
                sorted_groups[cat][field] = sorted(tags)

    return sorted_groups
def get_wikipedia_data(person_name):
    search_name = re.sub(r"\{.*?\}", "", person_name).strip()

    with WIKI_CACHE_LOCK:
        cache = {}
        if WIKI_CACHE_FILE.exists():
            try:
                with WIKI_CACHE_FILE.open("r", encoding="utf-8") as handle:
                    loaded = json.load(handle)
                if isinstance(loaded, dict):
                    cache = loaded
            except (OSError, json.JSONDecodeError):
                pass
        if search_name in cache:
            return cache[search_name]

    url = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "query", "format": "json", "titles": search_name,
        "prop": "extracts|pageimages", "exintro": True, "explaintext": True,
        "pithumbsize": 500, "redirects": 1,
    }
    headers = {"User-Agent": "Litero/1.0"}

    try:
        resp = requests.get(url, params=params, headers=headers, timeout=10)
        data = resp.json()
        pages = data.get("query", {}).get("pages", {})
        page = next(iter(pages.values()))

        if "missing" in page:
            result = {"blurb": "", "image_url": ""}
        else:
            result = {
                "blurb": page.get("extract", ""),
                "image_url": page.get("thumbnail", {}).get("source", ""),
            }

        with WIKI_CACHE_LOCK:
            latest_cache = {}
            if WIKI_CACHE_FILE.exists():
                try:
                    with WIKI_CACHE_FILE.open("r", encoding="utf-8") as handle:
                        loaded = json.load(handle)
                    if isinstance(loaded, dict):
                        latest_cache = loaded
                except (OSError, json.JSONDecodeError):
                    pass
            latest_cache[search_name] = result
            atomic_write_json(WIKI_CACHE_FILE, latest_cache)

        return result
    except Exception as e:
        print(f"Wiki API Error: {e}")
        return {"blurb": "", "image_url": ""}
# =============================================================================
# 3. READWISE API & SYNC ENGINE
# =============================================================================

def fetch_export_data(updated_after=None):
    full_data = []
    next_page_cursor = None
    if updated_after:
        print(f"Fetching incremental data from Readwise (since {updated_after})...")
    else:
        print("Performing full refresh of Readwise data. This may take a minute...")

    while True:
        params = {}
        if next_page_cursor: params["pageCursor"] = next_page_cursor
        if updated_after:
            params["updatedAfter"] = updated_after
            params["includeDeleted"] = "true"

        response = requests.get(
            url="https://readwise.io/api/v2/export/",
            params=params,
            headers={"Authorization": f"Token {API_TOKEN}"},
            timeout=READWISE_TIMEOUT,
        )
        if response.status_code == 401:
            print("Error: Unauthorized Readwise API Token.")
            break
        elif response.status_code == 429:
            time.sleep(int(response.headers.get("Retry-After", 60)))
            continue
        elif response.status_code != 200:
            break

        json_data = response.json()
        full_data.extend(json_data.get("results", []))
        next_page_cursor = json_data.get("nextPageCursor")
        if not next_page_cursor:
            break
        time.sleep(0.5)
    return full_data

#shoutout to readwise for detailed API!
def process_api_data(books_data, book_cache):
    flat_highlights = []
    books_cache = book_cache.get("books", {})
    legacy_titles = book_cache.get("legacy_titles", {})

    for book in books_data:
        title = book.get("title", "Unknown Title")
        author = book.get("author", "Unknown Author")
        book_key = get_book_cache_key(book.get("user_book_id"), title, author)
        cache_entry = books_cache.get(book_key, {})
        legacy_entry = legacy_titles.get(title, {}) if isinstance(legacy_titles, dict) else {}

        b_tags = [t.get("name") for t in book.get("book_tags", []) if t.get("name")]
        if not b_tags:
            b_tags = cache_entry.get("book_tags") or legacy_entry.get("book_tags", [])

        local_file_exists = (COVERS_DIR / cache_entry.get("filename", "")).is_file()
        cover_url = ""
        if cache_entry.get("remote_cover_url") or local_file_exists:
            cover_url = _local_cover_url(book_key)

        book_info = {
            "user_book_id": book.get("user_book_id"),
            "book_title": title,
            "book_author": author,
            "cover_url": cover_url,
            "readwise_url": book.get("readwise_url") or cache_entry.get("readwise_url", ""),
            "source_url": book.get("source_url", ""),
            "category": book.get("category") or cache_entry.get("category", "books"),
            "book_tags": b_tags,
        }

        for highlight in book.get("highlights", []):
            hl_tags = [tag.get("name") for tag in highlight.get("tags", []) if tag.get("name")]
            hl_date = highlight.get("highlighted_at") or highlight.get("created_at") or highlight.get("updated_at") or ""

            flat_highlights.append({
                **book_info,
                "highlight_id": str(highlight.get("id")),
                "text": highlight.get("text", ""),
                "note": highlight.get("note", ""),
                "tags": hl_tags,
                "highlighted_at": hl_date,
                "updated_at": highlight.get("updated_at", ""),
                "is_deleted": highlight.get("is_deleted", False),
                "location": highlight.get("location"),
                "location_type": highlight.get("location_type"),
            })
    return flat_highlights

def run_manual_sync():
    print("\n[Sync] Manual Full Sync initiated from UI...")
    current_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    all_readwise_books = fetch_export_data()

    if not all_readwise_books:
        raise Exception("Failed to fetch data from Readwise API.")

    _process_sync_data(all_readwise_books, incremental=False)

    atomic_write_text(SYNC_TRACKER_FILE, current_time)
    save_highlights_cache()
    print("[Sync] Manual Full Sync complete. Caches updated.")

def run_incremental_sync():
    last_sync = None
    if os.path.exists(SYNC_TRACKER_FILE):
        with open(SYNC_TRACKER_FILE, "r") as f:
            last_sync = f.read().strip()

    current_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    new_books = fetch_export_data(updated_after=last_sync)

    if not new_books:
        atomic_write_text(SYNC_TRACKER_FILE, current_time)
        return 0

    _process_sync_data(new_books, incremental=True)

    atomic_write_text(SYNC_TRACKER_FILE, current_time)
    save_highlights_cache()
    return len(new_books)

def _process_sync_data(book_data, incremental=False):
    with BOOK_CACHE_LOCK:
        book_cache = load_book_cache()
        register_books_in_cache(book_data, book_cache)
        raw_hls = process_api_data(book_data, book_cache)
        save_book_cache(book_cache)

    with sqlite3.connect(SRS_DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT highlight_id FROM srs_data")
        local_srs_ids = {str(row[0]) for row in cursor.fetchall()}

        for book in book_data:
            title = book.get("title", "Unknown Title")
            author = book.get("author", "")
            category = book.get("category", "")
            user_book_id = book.get("user_book_id")

            if user_book_id:
                cursor.execute("SELECT title, author, category FROM sources WHERE source_id = ?", (str(user_book_id),))
                existing_source = cursor.fetchone()
                if existing_source:
                    if (existing_source[0] != title or existing_source[1] != author or existing_source[2] != category):
                        cursor.execute("UPDATE sources SET title = ?, author = ?, category = ? WHERE source_id = ?",
                            (title, author, category, str(user_book_id)),
                        )
                else:
                    cursor.execute("INSERT INTO sources (source_id, title, author, category) VALUES (?, ?, ?, ?)",
                        (str(user_book_id), title, author, category),
                    )

        for hl in raw_hls:
            hl_id_str = str(hl["highlight_id"])
            if not hl.get("is_deleted"):
                if hl_id_str in local_srs_ids:
                    db_update_highlight_date(conn, hl_id_str, hl["updated_at"])
                else:
                    db_add_highlight(conn, hl, str(hl.get("user_book_id")))
                    local_srs_ids.add(hl_id_str)
                db_sync_tags(conn, hl_id_str, hl.get("tags", []))
            else:
                cursor.execute("DELETE FROM srs_data WHERE highlight_id = ?", (hl_id_str,))
                cursor.execute("DELETE FROM highlight_tags WHERE highlight_id = ?", (hl_id_str,))
        conn.commit()

    with DATA_LOCK:
        if incremental:
            mem_dict = {str(h["highlight_id"]): h for h in MEMORY_DB["highlights"]}
            for hl in raw_hls:
                hl_id_str = str(hl["highlight_id"])
                if hl.get("is_deleted"):
                    mem_dict.pop(hl_id_str, None)
                else:
                    mem_dict[hl_id_str] = hl
            MEMORY_DB["highlights"] = list(mem_dict.values())
        else:
            MEMORY_DB["highlights"] = [h for h in raw_hls if not h.get("is_deleted")]

        apply_cached_cover_urls(MEMORY_DB["highlights"], book_cache)
        rebuild_memory_indexes()

# =============================================================================
# 4. DATABASE INITIALIZATION & LOADING
# =============================================================================

def init_db():
    with sqlite3.connect(SRS_DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("""CREATE TABLE IF NOT EXISTS sources (source_id TEXT PRIMARY KEY, title TEXT, author TEXT, category TEXT, weight REAL DEFAULT 1.0)""")
        cursor.execute("""CREATE TABLE IF NOT EXISTS srs_data (highlight_id TEXT PRIMARY KEY, source_id TEXT, last_reviewed_at TEXT, easiness_factor REAL, repetitions INTEGER, highlighted_at TEXT, FOREIGN KEY(source_id) REFERENCES sources(source_id))""")
        cursor.execute("""CREATE TABLE IF NOT EXISTS tags (tag_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)""")
        cursor.execute("""CREATE TABLE IF NOT EXISTS highlight_tags (highlight_id TEXT, tag_id INTEGER, PRIMARY KEY (highlight_id, tag_id), FOREIGN KEY(highlight_id) REFERENCES srs_data(highlight_id), FOREIGN KEY(tag_id) REFERENCES tags(tag_id))""")
        conn.commit()
    restrict_file_permissions(SRS_DB_FILE)

def rebuild_memory_indexes():
    with DATA_LOCK:
        MEMORY_DB["highlights"].sort(key=lambda x: x.get("highlighted_at", ""), reverse=True)
        all_tags = set()
        all_book_tags = set()

        for hl in MEMORY_DB["highlights"]:
            all_tags.update(hl.get("tags", []))
            all_book_tags.update(hl.get("book_tags", []))

        MEMORY_DB["all_unique_tags"] = all_tags
        MEMORY_DB["all_book_tags"] = all_book_tags

def load_data():
    MEMORY_DB["ontology"] = load_ontology()

    if os.path.exists(LOCAL_JSON_CACHE) and os.path.exists(SYNC_TRACKER_FILE):
        print(f"Loading highlights instantly from {LOCAL_JSON_CACHE}...")
        with open(LOCAL_JSON_CACHE, "r") as f:
            MEMORY_DB["highlights"] = json.load(f)

        with BOOK_CACHE_LOCK:
            book_cache = load_book_cache()
            seed_book_cache_from_highlights(MEMORY_DB["highlights"], book_cache)
            apply_cached_cover_urls(MEMORY_DB["highlights"], book_cache)
            save_book_cache(book_cache)

        rebuild_memory_indexes()
        save_highlights_cache()
        run_incremental_sync()
    else:
        current_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        raw_data = fetch_export_data()

        with BOOK_CACHE_LOCK:
            book_cache = load_book_cache()
            register_books_in_cache(raw_data, book_cache)
            hls = process_api_data(raw_data, book_cache)
            save_book_cache(book_cache)

        MEMORY_DB["highlights"] = [h for h in hls if not h.get("is_deleted")]
        apply_cached_cover_urls(MEMORY_DB["highlights"], book_cache)
        rebuild_memory_indexes()

        atomic_write_text(SYNC_TRACKER_FILE, current_time)
        save_highlights_cache()

    print(f"App initialized with {len(MEMORY_DB['highlights'])} active highlights.")

def db_update_highlight_date(conn, highlight_id, remote_updated_at_str):
    cursor = conn.cursor()
    cursor.execute("SELECT last_reviewed_at FROM srs_data WHERE highlight_id = ?", (str(highlight_id),))
    result = cursor.fetchone()
    if not result:
        return False
    local_dt = datetime.strptime(result[0], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    remote_dt = datetime.fromisoformat(remote_updated_at_str.replace("Z", "+00:00"))

    if remote_dt > local_dt:
        new_date_str = remote_dt.strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute("UPDATE srs_data SET last_reviewed_at = ?, easiness_factor = 2.5, repetitions = 1 WHERE highlight_id = ?", (new_date_str, str(highlight_id)))
        return True
    return False

def db_add_highlight(conn, highlight, source_id):
    cursor = conn.cursor()
    formatted_date = datetime.fromisoformat(
        highlight.get("updated_at", datetime.now(timezone.utc).isoformat()).replace("Z", "+00:00")
    ).strftime("%Y-%m-%d %H:%M:%S")

    raw_hl = highlight.get("highlighted_at")
    formatted_hl_date = (
        datetime.fromisoformat(raw_hl.replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M:%S")
        if raw_hl else formatted_date
    )

    cursor.execute(
        "INSERT INTO srs_data (highlight_id, source_id, last_reviewed_at, easiness_factor, repetitions, highlighted_at) VALUES (?, ?, ?, ?, ?, ?)",
        (str(highlight["highlight_id"]), str(source_id), formatted_date, 2.5, 0, formatted_hl_date),
    )

def db_sync_tags(conn, highlight_id, tag_list):
    cursor = conn.cursor()
    cursor.execute("DELETE FROM highlight_tags WHERE highlight_id = ?", (str(highlight_id),))
    for tag_name in tag_list:
        cursor.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (tag_name,))
        cursor.execute("SELECT tag_id FROM tags WHERE name = ?", (tag_name,))
        tag_id = cursor.fetchone()[0]
        cursor.execute("INSERT OR IGNORE INTO highlight_tags (highlight_id, tag_id) VALUES (?, ?)", (str(highlight_id), tag_id))

# =============================================================================
# 5. READWISE API MUTATION WRAPPERS
# =============================================================================

def push_note_to_readwise(highlight_id, new_note):
    url = f"https://readwise.io/api/v2/highlights/{highlight_id}/"
    headers = {"Authorization": f"Token {API_TOKEN}", "Content-Type": "application/json"}
    try:
        requests.patch(url, headers=headers, json={"note": new_note}, timeout=READWISE_TIMEOUT).raise_for_status()
        return True
    except requests.exceptions.RequestException:
        return False

def push_text_to_readwise(highlight_id, new_text):
    url = f"https://readwise.io/api/v2/highlights/{highlight_id}/"
    headers = {"Authorization": f"Token {API_TOKEN}", "Content-Type": "application/json"}
    try:
        requests.patch(url, headers=headers, json={"text": new_text}, timeout=READWISE_TIMEOUT).raise_for_status()
        return True
    except requests.exceptions.RequestException:
        return False

def push_location_to_readwise(highlight_id, location_num):
    url = f"https://readwise.io/api/v2/highlights/{highlight_id}/"
    headers = {"Authorization": f"Token {API_TOKEN}", "Content-Type": "application/json"}
    try:
        payload = {"location": int(location_num), "location_type": "page"}
        requests.patch(url, headers=headers, json=payload, timeout=READWISE_TIMEOUT).raise_for_status()
        return True
    except requests.exceptions.RequestException:
        return False

def add_tag_to_readwise(highlight_id, tag_name):
    url = f"https://readwise.io/api/v2/highlights/{highlight_id}/tags/"
    headers = {"Authorization": f"Token {API_TOKEN}", "Content-Type": "application/json"}
    try:
        resp = requests.post(url, headers=headers, json={"name": tag_name}, timeout=READWISE_TIMEOUT)
        return resp.status_code in [200, 201] or (resp.status_code == 400 and "already exists" in resp.text)
    except Exception:
        return False

def delete_tag_from_readwise(highlight_id, tag_name):
    get_url = f"https://readwise.io/api/v2/highlights/{highlight_id}/tags/"
    headers = {"Authorization": f"Token {API_TOKEN}"}
    try:
        resp = requests.get(get_url, headers=headers, params={"page_size": 100}, timeout=READWISE_TIMEOUT)
        if resp.status_code != 200:
            return False
        tag_id = next((t["id"] for t in resp.json().get("results", []) if t["name"].strip().lower() == tag_name.strip().lower()), None)
        if not tag_id: return True
        return requests.delete(f"{get_url}{tag_id}/", headers=headers, timeout=READWISE_TIMEOUT).status_code == 204
    except Exception:
        return False

def delete_highlight_from_readwise(highlight_id):
    url = f"https://readwise.io/api/v2/highlights/{highlight_id}/"
    headers = {"Authorization": f"Token {API_TOKEN}"}
    try:
        resp = requests.delete(url, headers=headers, timeout=READWISE_TIMEOUT)
        return resp.status_code == 204
    except Exception:
        return False


# =============================================================================
# 6. FLASK API ROUTES
# =============================================================================

# --- On-demand Cover Cache ---
@app.route("/api/covers/<book_key>", methods=["GET"])
def get_cached_cover(book_key):
    if not re.fullmatch(r"[A-Za-z0-9._~-]{1,128}", book_key):
        abort(404)
    with cover_lock(book_key):
        with BOOK_CACHE_LOCK:
            book_cache = load_book_cache()
            entry = book_cache.get("books", {}).get(book_key)
            if not entry:
                return jsonify({"error": "Unknown cover"}), 404
            entry = dict(entry)

        _normalize_cached_filename(entry)
        filepath = _cover_path(entry)
        original_remote_url = entry.get("remote_cover_url", "")

        if filepath and _entry_needs_refresh(entry, filepath):
            refreshed_path = refresh_cached_cover(entry)
            if refreshed_path:
                filepath = refreshed_path

            with BOOK_CACHE_LOCK:
                latest_cache = load_book_cache()
                latest_entry = latest_cache.get("books", {}).get(book_key, {})

                # If a sync changed the URL while this request was downloading,
                # keep the newer sync metadata. The next image request will fetch
                # that newer URL.
                if latest_entry.get("remote_cover_url", "") == original_remote_url:
                    latest_cache.setdefault("books", {})[book_key] = entry
                    save_book_cache(latest_cache)
                else:
                    entry = latest_entry
                    _normalize_cached_filename(entry)
                    filepath = _cover_path(entry)

        if not filepath or not filepath.exists():
            return jsonify({"error": "Cover unavailable"}), 404

        response = send_file(
            filepath,
            mimetype=entry.get("content_type") or mimetypes.guess_type(filepath.name)[0] or "image/jpeg",
            conditional=True,
            etag=entry.get("content_hash") or True,
            max_age=0,
        )
        response.headers["Cache-Control"] = "private, no-cache"
        return response

# --- Sync Routes ---
@app.route("/api/sync", methods=["POST"])
def sync_data():
    request_json()
    try:
        run_manual_sync()
        return jsonify({"success": True})
    except Exception as e:
        print(f"[Sync] Full sync failed: {e}")
        return jsonify({"success": False, "error": "Readwise sync failed."}), 502

@app.route("/api/sync/incremental", methods=["POST"])
def sync_incremental_data():
    request_json()
    try:
        count = run_incremental_sync()
        return jsonify({"success": True, "new_count": count})
    except Exception as e:
        print(f"[Sync] Incremental sync failed: {e}")
        return jsonify({"success": False, "error": "Readwise sync failed."}), 502

# --- Exploration & Search Routes ---
@app.route("/api/explore", methods=["POST"])
def explore_highlights():
    data = request_json()
    active_tags = bounded_string_list(data, "tags", max_items=100, item_max_length=MAX_TAG_LENGTH)

    if not active_tags:
        filtered_highlights = MEMORY_DB["highlights"]
        related_tags_set = MEMORY_DB["all_unique_tags"].copy()
    else:
        active_tags_set = set(active_tags)
        filtered_highlights, related_tags_set = [], set()
        for hl in MEMORY_DB["highlights"]:
            hl_tags_set = set(hl.get("tags", []))
            if active_tags_set.issubset(hl_tags_set):
                filtered_highlights.append(hl)
                related_tags_set.update(hl_tags_set)
        related_tags_set.difference_update(active_tags_set)

    grouped_tags = group_tags_by_ontology(related_tags_set)
    tag_dates = {
        t: MEMORY_DB["ontology"].get(t.lower(), {}).get("Date", "")
        for t in related_tags_set
    }

    tag_counts = {}
    for hl in filtered_highlights:
        combined_tags = set(hl.get("tags", [])) | set(hl.get("book_tags", []))
        for t in combined_tags:
            if not active_tags or t in related_tags_set:
                tag_counts[t] = tag_counts.get(t, 0) + 1

    clean_all_tags = sorted(list(MEMORY_DB["all_unique_tags"]))

    return jsonify({
        "highlights": filtered_highlights[:75],
        "related_tags_grouped": grouped_tags,
        "tag_dates": tag_dates,
        "tag_counts": tag_counts,
        "total_count": len(filtered_highlights),
        "all_database_tags": clean_all_tags,
    })

@app.route("/api/library/explore", methods=["POST"])
def explore_library():
    data = request_json()
    active_tags = bounded_string_list(data, "tags", max_items=100, item_max_length=MAX_TAG_LENGTH)
    sort_by = bounded_string(data, "sort_by", max_length=32, default="last_highlighted")
    if sort_by not in {"last_highlighted", "title", "author"}:
        abort(400)
    search_query = bounded_string(data, "query", max_length=MAX_QUERY_LENGTH).lower()

    books_dict = {}
    for hl in MEMORY_DB["highlights"]:
        t = hl.get("book_title", "Unknown Title")
        hl_date = hl.get("highlighted_at", "")

        if t not in books_dict:
            books_dict[t] = {
                "title": t,
                "author": hl.get("book_author", "Unknown Author"),
                "cover_url": hl.get("cover_url", ""),
                "readwise_url": hl.get("readwise_url", ""),
                "category": hl.get("category", "books"),
                "book_tags": set(hl.get("book_tags", [])),
                "last_highlight_at": hl_date,
                "highlight_count": 0,
            }
        books_dict[t]["highlight_count"] += 1

        if hl_date > books_dict[t]["last_highlight_at"]:
            books_dict[t]["last_highlight_at"] = hl_date

    active_tags_set = set(active_tags)
    filtered_books = []
    related_tags_set = set()

    for b in books_dict.values():
        b_tags_set = b["book_tags"]

        text_match = True
        if search_query:
            searchable = remove_diacritics(f"{b['title']} {b['author']}").lower()
            if remove_diacritics(search_query) not in searchable:
                text_match = False

        if text_match and active_tags_set.issubset(b_tags_set):
            filtered_books.append(b)
            related_tags_set.update(b_tags_set)

    related_tags_set.difference_update(active_tags_set)

    if sort_by == "title":
        filtered_books.sort(key=lambda x: x["title"].lower())
    elif sort_by == "author":
        filtered_books.sort(key=lambda x: x["author"].lower())
    else:
        filtered_books.sort(key=lambda x: x["last_highlight_at"] or "", reverse=True)

    for b in filtered_books:
        b["book_tags"] = list(b["book_tags"])

    grouped_tags = group_tags_by_ontology(related_tags_set)

    return jsonify({
        "books": filtered_books,
        "related_tags_grouped": grouped_tags,
        "total_count": len(filtered_books),
        "all_book_tags": sorted(list(MEMORY_DB["all_book_tags"])),
    })

@app.route("/api/book_highlights", methods=["POST"])
def get_book_highlights():
    data = request_json()
    title = bounded_string(data, "title", max_length=1_000, required=True)
    hls = [hl for hl in MEMORY_DB["highlights"] if hl.get("book_title") == title]

    related_tags_set = set()
    for hl in hls:
        related_tags_set.update(hl.get("tags", []))

    grouped_tags = group_tags_by_ontology(related_tags_set)
    tag_dates = {
        t: MEMORY_DB["ontology"].get(t.lower(), {}).get("Date", "")
        for t in related_tags_set
    }

    tag_counts = {}
    for hl in hls:
        combined_tags = set(hl.get("tags", [])) | set(hl.get("book_tags", []))
        for t in combined_tags:
            if t in related_tags_set:
                tag_counts[t] = tag_counts.get(t, 0) + 1

    return jsonify({
        "highlights": hls,
        "related_tags_grouped": grouped_tags,
        "tag_dates": tag_dates,
        "tag_counts": tag_counts,
    })

@app.route("/api/person", methods=["POST"])
def person_page():
    data = request_json()
    person_name = bounded_string(data, "person", max_length=MAX_TAG_LENGTH, required=True)
    wiki_data = get_wikipedia_data(person_name)

    primary_sources = {}
    secondary_sources = {}
    person_lower = person_name.lower()

    for hl in MEMORY_DB["highlights"]:
        b_title = hl.get("book_title") or "Unknown Title"
        b_author = hl.get("book_author") or "Unknown Author"
        b_cover = hl.get("cover_url") or ""
        b_category = hl.get("category", "books")

        is_primary = person_lower in b_author.lower()
        hl_tags = [t.lower() for t in hl.get("tags", []) + hl.get("book_tags", [])]
        is_secondary = person_lower in hl_tags and not is_primary

        if is_primary:
            if b_title not in primary_sources:
                primary_sources[b_title] = {
                    "title": b_title, "author": b_author, "cover": b_cover, "category": b_category, "count": 0,
                }
            primary_sources[b_title]["count"] += 1

        if is_secondary:
            if b_title not in secondary_sources:
                secondary_sources[b_title] = {
                    "title": b_title, "author": b_author, "cover": b_cover, "category": b_category, "count": 0,
                }
            secondary_sources[b_title]["count"] += 1

    return jsonify({
        "success": True,
        "name": person_name,
        "wiki": wiki_data,
        "primary_sources": list(primary_sources.values()),
        "secondary_sources": list(secondary_sources.values()),
    })

@app.route("/api/search", methods=["POST"])
def global_search():
    data = request_json()
    query = bounded_string(data, "query", max_length=MAX_QUERY_LENGTH)
    full_search = data.get("full", False)
    if not isinstance(full_search, bool):
        abort(400)

    if not query or len(query.strip()) < 2:
        return jsonify({"tags": [], "highlights": []})

    raw_criteria = [c.strip() for c in query.split(",")]
    tag_filters = []
    text_filters = []

    for c in raw_criteria:
        if not c:
            continue
        if c.startswith("#"):
            tag_filters.append(remove_diacritics(c[1:].lower()))
        else:
            if c.startswith(("'", '"')) and c.endswith(("'", '"')) and len(c) >= 2:
                text_filters.append(remove_diacritics(c[1:-1].lower()))
            else:
                text_filters.append(remove_diacritics(c.lower()))

    matched_tags = []
    matched_hls = []

    last_token = raw_criteria[-1] if raw_criteria else ""
    tag_search_term = ""
    if last_token.startswith("#"):
        tag_search_term = remove_diacritics(last_token[1:].lower())
    elif last_token and not last_token.startswith(("'", '"')):
        tag_search_term = remove_diacritics(last_token.lower())

    if tag_search_term:
        for tag in MEMORY_DB["all_unique_tags"]:
            if tag_search_term in remove_diacritics(tag.lower()):
                matched_tags.append(tag)
                if not full_search and len(matched_tags) >= 10:
                    break

    for hl in MEMORY_DB["highlights"]:
        searchable_text = remove_diacritics(
            f"{hl.get('text','')} {hl.get('note','')} {hl.get('book_title','')} {hl.get('book_author','')}"
        ).lower()

        match = True
        for tf in text_filters:
            if tf not in searchable_text:
                match = False
                break

        if match and tag_filters:
            hl_tags_norm = [remove_diacritics(t.lower()) for t in hl.get("tags", []) + hl.get("book_tags", [])]
            for tf_tag in tag_filters:
                if not any(tf_tag in ht for ht in hl_tags_norm):
                    match = False
                    break

        if match:
            matched_hls.append(hl)
            if not full_search and len(matched_hls) >= 20:
                break

    return jsonify({"tags": matched_tags, "highlights": matched_hls})

@app.route("/api/graph", methods=["GET"])
def graph_data():
    nodes_dict = {}
    edges_dict = {}

    for hl in MEMORY_DB["highlights"]:
        tags = [t for t in hl["tags"] if t in MEMORY_DB["all_unique_tags"]]
        for t in tags:
            nodes_dict[t] = nodes_dict.get(t, 0) + 1
        for i in range(len(tags)):
            for j in range(i + 1, len(tags)):
                t1, t2 = sorted([tags[i], tags[j]])
                edge = f"{t1}|{t2}"
                edges_dict[edge] = edges_dict.get(edge, 0) + 1

    top_nodes = sorted(nodes_dict.keys(), key=lambda k: nodes_dict[k], reverse=True)[:250]
    top_nodes_set = set(top_nodes)

    graph_nodes = []
    for n in top_nodes:
        cat = MEMORY_DB["ontology"].get(n.lower(), {}).get("Category", "Other")
        date_str = MEMORY_DB["ontology"].get(n.lower(), {}).get("Date", "")
        graph_nodes.append({"id": n, "group": cat, "val": nodes_dict[n], "dateStr": date_str})

    graph_links = []
    for edge, weight in edges_dict.items():
        t1, t2 = edge.split("|")
        if t1 in top_nodes_set and t2 in top_nodes_set and weight > 1:
            graph_links.append({"source": t1, "target": t2, "value": weight})

    return jsonify({"nodes": graph_nodes, "links": graph_links})

@app.route("/api/time_metrics", methods=["POST"])
def time_metrics():
    data = request_json()
    start_date_str = data.get("start_date")
    end_date_str = data.get("end_date")
    date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    for value in (start_date_str, end_date_str):
        if value is not None and (not isinstance(value, str) or not date_pattern.fullmatch(value)):
            abort(400)

    valid_hls = []
    min_date = "9999-12-31"
    max_date = "0000-01-01"

    for hl in MEMORY_DB["highlights"]:
        hl_date_full = hl.get("highlighted_at") or hl.get("updated_at") or ""
        if not hl_date_full:
            continue

        hl_date = hl_date_full[:10]

        if hl_date < min_date: min_date = hl_date
        if hl_date > max_date: max_date = hl_date

        if start_date_str and hl_date < start_date_str:
            continue
        if end_date_str and hl_date > end_date_str:
            continue

        valid_hls.append(hl)

    if min_date == "9999-12-31":
        min_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        max_date = min_date

    tag_counts = defaultdict(int)
    source_counts = defaultdict(int)

    for hl in valid_hls:
        for t in hl.get("tags", []):
            tag_counts[t] += 1

        title = hl.get("book_title", "Unknown Source")
        source_counts[title] += 1

    return jsonify({
        "success": True,
        "total_highlights": len(valid_hls),
        "tag_counts": tag_counts,
        "source_counts": source_counts,
        "absolute_min_date": min_date,
        "absolute_max_date": max_date
    })
# --- Update & Delete Routes ---
@app.route("/api/update_note", methods=["POST"])
def update_note():
    data = request_json()
    hl_id = bounded_string(data, "highlight_id", max_length=128, required=True)
    new_note = bounded_string(data, "note", max_length=MAX_TEXT_LENGTH)
    if not push_note_to_readwise(hl_id, new_note):
        return jsonify({"success": False}), 500
    with DATA_LOCK:
        for hl in MEMORY_DB["highlights"]:
            if str(hl.get("highlight_id")) == str(hl_id):
                hl["note"] = new_note
                break
        save_highlights_cache()
    return jsonify({"success": True})

@app.route("/api/update_highlight_text", methods=["POST"])
def update_highlight_text():
    data = request_json()
    hl_id = bounded_string(data, "highlight_id", max_length=128, required=True)
    new_text = bounded_string(data, "text", max_length=MAX_TEXT_LENGTH)
    if not push_text_to_readwise(hl_id, new_text):
        return jsonify({"success": False}), 500
    with DATA_LOCK:
        for hl in MEMORY_DB["highlights"]:
            if str(hl.get("highlight_id")) == str(hl_id):
                hl["text"] = new_text
                break
        save_highlights_cache()
    return jsonify({"success": True})

@app.route("/api/update_location", methods=["POST"])
def update_location():
    data = request_json()
    hl_id = bounded_string(data, "highlight_id", max_length=128, required=True)
    page = data.get("page")
    if isinstance(page, bool):
        abort(400)
    try:
        page = int(page)
    except (TypeError, ValueError):
        abort(400)
    if page < 0 or page > 10_000_000:
        abort(400)

    if not push_location_to_readwise(hl_id, page):
        return jsonify({"success": False, "error": "Failed to sync to Readwise."}), 500

    with DATA_LOCK:
        for hl in MEMORY_DB["highlights"]:
            if str(hl.get("highlight_id")) == str(hl_id):
                hl["location"] = page
                hl["location_type"] = "page"
                break
        save_highlights_cache()
    return jsonify({"success": True})

@app.route("/api/add_tag", methods=["POST"])
def add_tag():
    data = request_json()
    hl_id = bounded_string(data, "highlight_id", max_length=128, required=True)
    tag_name = bounded_string(data, "tag_name", max_length=MAX_TAG_LENGTH, required=True)
    if add_tag_to_readwise(hl_id, tag_name):
        with DATA_LOCK:
            for hl in MEMORY_DB["highlights"]:
                if str(hl.get("highlight_id")) == str(hl_id):
                    if tag_name not in hl["tags"]:
                        hl["tags"].append(tag_name)
                    break
            MEMORY_DB["all_unique_tags"].add(tag_name)
            save_highlights_cache()
        return jsonify({"success": True})
    return jsonify({"success": False}), 500

@app.route("/api/remove_tag", methods=["POST"])
def remove_tag():
    data = request_json()
    hl_id = bounded_string(data, "highlight_id", max_length=128, required=True)
    tag_name = bounded_string(data, "tag_name", max_length=MAX_TAG_LENGTH, required=True)
    if delete_tag_from_readwise(hl_id, tag_name):
        with DATA_LOCK:
            for hl in MEMORY_DB["highlights"]:
                if str(hl.get("highlight_id")) == str(hl_id):
                    if tag_name in hl["tags"]:
                        hl["tags"].remove(tag_name)
                    break
            save_highlights_cache()
        return jsonify({"success": True})
    return jsonify({"success": False}), 500

@app.route("/api/delete_highlight", methods=["POST"])
def api_delete_highlight():
    data = request_json()
    hl_id = bounded_string(data, "highlight_id", max_length=128, required=True)

    if not delete_highlight_from_readwise(hl_id):
        return jsonify({"success": False, "error": "Failed to delete from Readwise API."}), 500

    with DATA_LOCK:
        MEMORY_DB["highlights"] = [hl for hl in MEMORY_DB["highlights"] if str(hl.get("highlight_id")) != str(hl_id)]
        save_highlights_cache()
        rebuild_memory_indexes()

    try:
        with sqlite3.connect(SRS_DB_FILE) as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM highlight_tags WHERE highlight_id = ?", (str(hl_id),))
            cursor.execute("DELETE FROM srs_data WHERE highlight_id = ?", (str(hl_id),))
            conn.commit()
    except sqlite3.Error as error:
        print(f"[SRS] Could not remove deleted highlight from the local review database: {error}")

    return jsonify({"success": True})

# --- SRS Routes ---
def calculate_srs_update(quality, repetitions, easiness_factor):
    if quality < 3:
        repetitions = 0
    else:
        repetitions += 1
    easiness_factor += 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)
    if easiness_factor < 1.3:
        easiness_factor = 1.3
    return {"repetitions": repetitions, "easiness_factor": easiness_factor}

@app.route("/api/srs/next", methods=["POST"])
def srs_next():
    data = request_json()
    tags = bounded_string_list(data, "tags", max_items=100, item_max_length=MAX_TAG_LENGTH)
    book = bounded_string(data, "book", max_length=1_000)
    yesterday = data.get("yesterday", False)
    ignore_date = data.get("ignore_date", False)
    skipped_ids = bounded_string_list(data, "skipped_ids", max_items=500, item_max_length=128)
    if not isinstance(yesterday, bool) or not isinstance(ignore_date, bool):
        abort(400)

    if not os.path.exists(SRS_DB_FILE):
        return jsonify({"success": False, "error": "SRS Database not found."})

    with sqlite3.connect(SRS_DB_FILE) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        base_select = """
            SELECT srs.highlight_id, srs.repetitions, srs.easiness_factor, src.weight,
            MIN(((JULIANDAY('now', 'utc') - JULIANDAY(srs.last_reviewed_at)) / srs.easiness_factor) * src.weight, 100.0) AS priority
            FROM srs_data srs
            JOIN sources src ON srs.source_id = src.source_id
        """
        joins, where_clauses, params = "", [], []

        if tags:
            joins = " JOIN highlight_tags ht ON srs.highlight_id = ht.highlight_id JOIN tags t ON ht.tag_id = t.tag_id"
            placeholders = ",".join(["?"] * len(tags))
            where_clauses.append(f"t.name IN ({placeholders})")
            params.extend(tags)
        if book:
            where_clauses.append("src.title LIKE ?")
            params.append(f"%{book}%")
        if yesterday:
            where_clauses.append("srs.highlighted_at >= datetime('now', '-24 hours', 'utc')")
            ignore_date = True
        if not ignore_date:
            where_clauses.append("srs.last_reviewed_at <= datetime('now', '-12 hours', 'utc')")

        if skipped_ids:
            placeholders = ",".join(["?"] * len(skipped_ids))
            where_clauses.append(f"srs.highlight_id NOT IN ({placeholders})")
            params.extend(skipped_ids)

        where_stmt = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        group_stmt = " GROUP BY srs.highlight_id"
        having_stmt = f" HAVING COUNT(DISTINCT t.name) = {len(tags)}" if tags else ""
        order_stmt = " ORDER BY srs.highlighted_at DESC" if yesterday else " ORDER BY priority DESC, RANDOM()"

        query = base_select + joins + where_stmt + group_stmt + having_stmt + order_stmt + " LIMIT 50"

        try:
            cursor.execute(query, params)
            rows = cursor.fetchall()
        except sqlite3.OperationalError as e:
            print(f"[SRS] Database query failed: {e}")
            return jsonify({"success": False, "error": "SRS database query failed."}), 500

        for row in rows:
            hl_id = str(row["highlight_id"])
            hl = next((h for h in MEMORY_DB["highlights"] if str(h["highlight_id"]) == hl_id), None)
            if hl:
                hl_copy = hl.copy()
                hl_copy["srs"] = {
                    "priority": round(row["priority"] or 0, 2),
                    "repetitions": row["repetitions"],
                    "easiness_factor": round(row["easiness_factor"], 2),
                }
                return jsonify({"success": True, "highlight": hl_copy})

        return jsonify({"success": False, "error": "No due highlights match these filters."})

@app.route("/api/srs/rate", methods=["POST"])
def srs_rate():
    data = request_json()
    hl_id = bounded_string(data, "highlight_id", max_length=128, required=True)
    rating = data.get("rating", 3)
    if isinstance(rating, bool):
        abort(400)
    try:
        rating = int(rating)
    except (TypeError, ValueError):
        abort(400)
    if rating < 0 or rating > 5:
        abort(400)
    if not os.path.exists(SRS_DB_FILE):
        return jsonify({"success": False, "error": "SRS Database not found."})

    with sqlite3.connect(SRS_DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT repetitions, easiness_factor FROM srs_data WHERE highlight_id = ?", (str(hl_id),))
        row = cursor.fetchone()

        if not row:
            return jsonify({"success": False, "error": "Highlight not found in SRS database."})

        updates = calculate_srs_update(rating, row[0], row[1])
        formatted_date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

        cursor.execute(
            "UPDATE srs_data SET repetitions = ?, easiness_factor = ?, last_reviewed_at = ? WHERE highlight_id = ?",
            (updates["repetitions"], updates["easiness_factor"], formatted_date, str(hl_id)),
        )
        conn.commit()
    return jsonify({"success": True})

# --- Taxonomy Config Routes ---
@app.route("/api/taxonomy/config", methods=["GET"])
def get_tax_config():
    if TAXONOMY_CONFIG_PATH.exists():
        with open(TAXONOMY_CONFIG_PATH, "r") as f:
            return jsonify(json.load(f))
    return jsonify({"provider": "gemini", "categories": [], "fields": [], "roles": []})

@app.route("/api/taxonomy/config", methods=["POST"])
def save_tax_config():
    data = request_json()
    provider = bounded_string(data, "provider", max_length=32, default="gemini")
    if provider not in {"gemini", "openai", "anthropic"}:
        abort(400)
    config = {
        "provider": provider,
        "categories": bounded_string_list(data, "categories", max_items=MAX_TAXONOMY_ITEMS, item_max_length=MAX_TAG_LENGTH),
        "fields": bounded_string_list(data, "fields", max_items=MAX_TAXONOMY_ITEMS, item_max_length=MAX_TAG_LENGTH),
        "roles": bounded_string_list(data, "roles", max_items=MAX_TAXONOMY_ITEMS, item_max_length=MAX_TAG_LENGTH),
    }
    atomic_write_json(TAXONOMY_CONFIG_PATH, config, indent=4)
    return jsonify({"success": True})

@app.route("/api/taxonomy/run", methods=["POST"])
def run_taxonomy():
    request_json()
    try:
        subprocess.Popen(
            [sys.executable, str(BASE_DIR / "taxonomer.py")],
            cwd=BASE_DIR,
            close_fds=True,
        )
        return jsonify({"success": True})
    except Exception as e:
        print(f"[Taxonomy] Failed to start worker: {e}")
        return jsonify({"success": False, "error": "Unable to start taxonomy worker."}), 500

# --- Explicit Static Serving ---
def _index_response():
    response = make_response(send_from_directory(BASE_DIR, "index.html"))
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(
        CSRF_COOKIE_NAME,
        CSRF_TOKEN,
        httponly=True,
        secure=False,
        samesite="Strict",
        path="/",
    )
    return response


@app.get("/")
@app.get("/index.html")
def index_page():
    return _index_response()


@app.get("/js/<path:filename>")
def javascript_asset(filename):
    return send_from_directory(BASE_DIR / "js", filename)


@app.get("/themes/<path:filename>")
def theme_asset(filename):
    return send_from_directory(BASE_DIR / "themes", filename)


@app.get("/mobile.css")
def mobile_stylesheet():
    return send_from_directory(BASE_DIR, "mobile.css")


@app.get("/icon.svg")
def app_icon():
    return send_from_directory(BASE_DIR, "icon.svg")


@app.get("/<path:_path>")
def unknown_path(_path):
    abort(404)

# =============================================================================
# 7. MAIN EXECUTION
# =============================================================================

if __name__ == "__main__":
    if not API_TOKEN:
        sys.exit("Error: READWISE_API_KEY is missing. Please run setup.py or export the variable.")

    init_db()
    load_data()
    print("\nServer starting! Open http://127.0.0.1:43353 in your browser.")
    app.run(host="127.0.0.1", port=43353, debug=False, use_reloader=False)
