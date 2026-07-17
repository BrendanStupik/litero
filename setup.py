#!/usr/bin/env python3

import json
import os
import sys
from getpass import getpass
from pathlib import Path

from security_utils import atomic_write_json, ensure_private_dir


def get_config_dir():
    home = Path.home()
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "Litero"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Litero"
    return Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "Litero"


def main():
    print("=" * 55)
    print("             LITERO SETUP WIZARD")
    print("=" * 55)
    print("\nLet's get your environment configured.")
    print("Press [Enter] to skip any key you don't want to provide. Input is hidden.\n")

    supplied = {
        "READWISE_API_KEY": getpass("1. Readwise API Key (Required for sync): ").strip(),
        "GEMINI_API_KEY": getpass("2. Google Gemini API Key (Optional): ").strip(),
        "OPENAI_API_KEY": getpass("3. OpenAI API Key (Optional): ").strip(),
        "ANTHROPIC_API_KEY": getpass("4. Anthropic (Claude) API Key (Optional): ").strip(),
    }
    supplied = {key: value for key, value in supplied.items() if value}

    config_dir = get_config_dir()
    ensure_private_dir(config_dir)
    secrets_path = config_dir / "secrets.json"

    secrets = {}
    if secrets_path.exists():
        try:
            with secrets_path.open("r", encoding="utf-8") as handle:
                existing = json.load(handle)
            if isinstance(existing, dict):
                secrets.update(existing)
        except (OSError, json.JSONDecodeError):
            print("[Warning] Existing secrets.json could not be read; it will be replaced.")
    secrets.update(supplied)
    atomic_write_json(secrets_path, secrets, indent=4)

    taxonomy_path = config_dir / "taxonomy.json"
    if not taxonomy_path.exists():
        atomic_write_json(
            taxonomy_path,
            {
                "provider": "gemini",
                "categories": ["Person", "Concept", "Event", "Location", "Artifact/Product"],
                "fields": [
                    "Science", "Technology & Software", "Engineering", "Mathematics",
                    "Medicine & Health", "History", "Philosophy", "Art & Design",
                    "Literature", "Music", "Business & Economics", "Politics",
                    "Law", "Sociology", "Psychology", "Religion & Spirituality",
                ],
                "roles": [
                    "Writer", "Scientist", "Politician", "Artist", "Philosopher",
                    "Musician / Composer", "Innovator / Entrepreneur", "Historical Figure", "Scholar",
                ],
            },
            indent=4,
        )

    print("\n" + "-" * 55)
    print("[SUCCESS] Configuration saved locally with private file permissions where supported:")
    print(f" -> {secrets_path}")
    print(f" -> {taxonomy_path}")
    print("-" * 55)
    print("\nYou can now launch Litero by running:")
    print("python app.py\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nSetup aborted.")
        sys.exit(0)
