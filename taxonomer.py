#!/usr/bin/env python3

import os
import sys
import time
import csv
import json
import argparse
import io
import requests
from pathlib import Path

from security_utils import atomic_write_text, ensure_private_dir, restrict_file_permissions

# =============================================================================
# 1. CONFIGURATION & DIRECTORY ROUTING
# =============================================================================

def get_config_dir():
    home = Path.home()
    if sys.platform == "win32": 
        return Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "Litero"
    elif sys.platform == "darwin": 
        return home / "Library" / "Application Support" / "Litero"
    else: 
        return Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "Litero"

CONFIG_DIR = get_config_dir()
ensure_private_dir(CONFIG_DIR)
SECRETS_FILE = CONFIG_DIR / "secrets.json"
TAXONOMY_FILE = CONFIG_DIR / "taxonomy.json"
OUTPUT_FILE = CONFIG_DIR / "readwise_tags.csv"
HTTP_TIMEOUT = (5, 60)
MAX_TAG_LENGTH = 200
for private_file in (SECRETS_FILE, TAXONOMY_FILE, OUTPUT_FILE):
    restrict_file_permissions(private_file)

def load_secrets():
    if os.environ.get("READWISE_API_KEY"):
        return {
            "READWISE_API_KEY": os.environ.get("READWISE_API_KEY"),
            "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", ""),
            "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY", ""),
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", "")
        }

    if SECRETS_FILE.exists():
        try:
            with open(SECRETS_FILE, "r") as f: 
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            sys.exit("Error: secrets.json could not be read. Run setup.py again or use environment variables.")
            
    sys.exit(f"Error: {SECRETS_FILE} not found. Please run setup.py first or set environment variables.")

def load_taxonomy():
    if TAXONOMY_FILE.exists():
        with open(TAXONOMY_FILE, "r") as f:
            return json.load(f)
    return {"provider": "gemini", "categories": [], "fields": [], "roles": []}

SECRETS = load_secrets()
TAX_CONFIG = load_taxonomy()

READWISE_TOKEN = SECRETS.get("READWISE_API_KEY")
if not READWISE_TOKEN: 
    sys.exit("Error: READWISE_API_KEY missing from secrets.")

# =============================================================================
# 2. LLM PROMPT GENERATION
# =============================================================================

def get_prompt():
    categories = "\n".join(f"    {c}" for c in TAX_CONFIG.get("categories", []))
    fields = "\n".join(f"    {f}" for f in TAX_CONFIG.get("fields", []))
    roles = "\n".join(f"    {r}" for r in TAX_CONFIG.get("roles", []))

    return f"""Role & Objective
You are an expert taxonomist and data organizer. I will provide you with a raw list of tags from my reading library. Your absolute requirement is to categorize every single tag provided into a structured Markdown table. You must not skip, summarize, or omit any tags.

Taxonomy Rules
Analyze each tag and assign it to the following columns based on these strict definitions. You are strictly forbidden from inventing new options. You must choose ONLY from the provided lists. The more detail the better. For example, 'Machine Learning' should be tagged as FIELD Computer Science, Artificial Intelligence, and so on.

1. Tag: The exact name or phrase provided in the input list.
2. Category: You must choose exactly ONE of the following:
{categories}

3. Field: The broad academic discipline. Because these will be used to tag my highlights, we have to avoid false positives. This means persons should be tagged ONLY with larger fields. A false positive would arise if we tagged, for example, 'Albert Einstein', with the field 'Marine Biology', because it would improperly group all of his highlights with that field. For ideas, you may (AND SHOULD) use multiple of the following separated by a "," (use one if two or more are not applicable):
{fields}

4. Role (For People Only): If the Category is Person, you may (AND SHOULD) use multiple of the following separated by a ",". If the Category is not Person, output N/A.
{roles}

5. Lifespan (If Person): If the Category is Person, provide their birth and death years (e.g., "1889-1951" or "c. 428 BC - c. 348 BC"). If they are still alive, use "1962-Present". If the Category is not Person, output "N/A".

Output Format
Respond only with the Markdown table using `|` to separate columns. Do not include any introductory or concluding text, and do not explain your reasoning.
| Tag | Category | Field | Role (If Person) | Lifespan (If Person) |
|---|---|---|---|---|
"""

# =============================================================================
# 3. CORE LOGIC & API CALLS
# =============================================================================

def fetch_unique_tags():
    print("Fetching data from Readwise API to build tag list...")
    tags, cursor = set(), None
    while True:
        resp = requests.get(
            "https://readwise.io/api/v2/export/", 
            params={"pageCursor": cursor} if cursor else {}, 
            headers={"Authorization": f"Token {READWISE_TOKEN}"},
            timeout=HTTP_TIMEOUT,
        )
        if resp.status_code == 429:
            time.sleep(int(resp.headers.get("Retry-After", 60)))
            continue
        resp.raise_for_status()
        data = resp.json()
        
        for book in data.get("results", []):
            for t in book.get("book_tags", []) + [t for hl in book.get("highlights", []) for t in hl.get("tags", [])]:
                name = t.get("name")
                if isinstance(name, str) and 0 < len(name) <= MAX_TAG_LENGTH:
                    tags.add(name)
                    
        cursor = data.get("nextPageCursor")
        if not cursor: 
            break
        time.sleep(0.5)
    return sorted(list(tags))

def ask_llm(tags_chunk):
    full_prompt = get_prompt() + "\nHere are the tags to categorize:\n" + "\n".join([f"- {t}" for t in tags_chunk])

    provider = TAX_CONFIG.get("provider", "gemini").lower()
    
    # Key Fallbacks if user hasn't configured properly
    if provider == "openai" and not SECRETS.get("OPENAI_API_KEY"): 
        provider = "anthropic" if SECRETS.get("ANTHROPIC_API_KEY") else "gemini"
    if provider == "anthropic" and not SECRETS.get("ANTHROPIC_API_KEY"): 
        provider = "gemini"
    if provider == "gemini" and not SECRETS.get("GEMINI_API_KEY"): 
        provider = "openai" if SECRETS.get("OPENAI_API_KEY") else "anthropic" if SECRETS.get("ANTHROPIC_API_KEY") else None

    if not provider: 
        sys.exit("Error: No AI keys found in secrets.json or environment variables.")

    for attempt in range(1, 6):
        try:
            if provider == "openai":
                resp = requests.post(
                    "https://api.openai.com/v1/chat/completions", 
                    headers={"Authorization": f"Bearer {SECRETS['OPENAI_API_KEY']}"}, 
                    json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": full_prompt}], "temperature": 0.1},
                    timeout=HTTP_TIMEOUT,
                )
            elif provider == "anthropic":
                resp = requests.post(
                    "https://api.anthropic.com/v1/messages", 
                    headers={"x-api-key": SECRETS["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"}, 
                    json={"model": "claude-3-haiku-20240307", "max_tokens": 2048, "messages": [{"role": "user", "content": full_prompt}], "temperature": 0.1},
                    timeout=HTTP_TIMEOUT,
                )
            elif provider == "gemini":
                resp = requests.post(
                    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
                    headers={"x-goog-api-key": SECRETS["GEMINI_API_KEY"]},
                    json={"contents": [{"parts": [{"text": full_prompt}]}], "generationConfig": {"temperature": 0.1}},
                    timeout=HTTP_TIMEOUT,
                )

            if resp.status_code == 200:
                data = resp.json()
                if provider == "openai": return data["choices"][0]["message"]["content"]
                if provider == "anthropic": return data["content"][0]["text"]
                if provider == "gemini": return data["candidates"][0]["content"]["parts"][0]["text"]
            
            # Retry only on timeouts or server drops
            elif resp.status_code in [500, 502, 503, 504]:
                print(f"  [!] Server error {resp.status_code}. Retrying (Attempt {attempt})...")
                time.sleep(2 ** attempt)
                continue
            else:
                # Terminate completely on 4xx errors (Billing caps, invalid keys, rate limit bans)
                sys.exit(f"  [x] Provider rejected the request (HTTP {resp.status_code}). Check the selected provider, API key, quota, and billing settings.")
                
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
            print(f"  [!] Connection issue. Retrying (Attempt {attempt})...")
            time.sleep(2 ** attempt)
            
    sys.exit("Failed to reach LLM API after maximum retry attempts.")

# =============================================================================
# 4. DATA PARSING & CSV MANAGEMENT
# =============================================================================

def parse_md_table(md_text):
    rows = []
    for line in md_text.strip().split("\n"):
        cols = [c.strip() for c in line.split("|")[1:-1]]
        if len(cols) >= 5 and cols[0].lower() != "tag" and not line.startswith("|-"):
            rows.append({
                "Tag": cols[0], 
                "Category": cols[1], 
                "Field": cols[2], 
                "Role (If Person)": cols[3], 
                "Lifespan (If Person)": cols[4]
            })
    return rows

def load_csv():
    if not OUTPUT_FILE.exists(): 
        return [], ["Tag", "Category", "Field", "Role (If Person)", "Lifespan (If Person)"]
        
    with open(OUTPUT_FILE, mode="r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return list(reader), list(reader.fieldnames)

def save_csv(rows, fieldnames):
    fieldnames = list(fieldnames or ["Tag", "Category", "Field", "Role (If Person)"])
    if "Lifespan (If Person)" not in fieldnames:
        fieldnames.append("Lifespan (If Person)")

    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        safe_row = dict(row)
        safe_row.setdefault("Lifespan (If Person)", "N/A")
        writer.writerow(safe_row)
    atomic_write_text(OUTPUT_FILE, "\ufeff" + output.getvalue(), encoding="utf-8")

def batch_and_update(tag_list, all_rows, fieldnames):
    updated_dict = {}
    for i in range(0, len(tag_list), 40):
        chunk = tag_list[i : i + 40]
        print(f"  -> Sending batch {i // 40 + 1}/{(len(tag_list) - 1) // 40 + 1} ({len(chunk)} items)...")
        parsed_rows = parse_md_table(ask_llm(chunk))
        for p in parsed_rows: 
            updated_dict[p["Tag"].lower()] = p
        time.sleep(2)
    return updated_dict

# =============================================================================
# 5. MAIN EXECUTION ROUTINES
# =============================================================================

def update_lifespans():
    all_rows, fieldnames = load_csv()
    people_to_update = [r["Tag"] for r in all_rows if r.get("Category", "").strip().lower() == "person" and r.get("Lifespan (If Person)", "N/A") in ["", "N/A"]]
    
    if not people_to_update:
        print("No people found missing a lifespan.")
        save_csv(all_rows, fieldnames)
        return
        
    print(f"Found {len(people_to_update)} people missing lifespans.")
    updated_dict = batch_and_update(people_to_update, all_rows, fieldnames)
    
    for row in all_rows:
        if row["Tag"].lower() in updated_dict:
            row.update(updated_dict[row["Tag"].lower()])
            
    print(f"Writing updated data to {OUTPUT_FILE}...")
    save_csv(all_rows, fieldnames)

def process_new_tags():
    unique_tags = fetch_unique_tags()
    all_rows, fieldnames = load_csv()
    existing_tags = {r["Tag"].lower().strip() for r in all_rows if r.get("Tag")}
    
    new_tags = [t for t in unique_tags if t.lower() not in existing_tags]
    if not new_tags:
        print(f"No new tags to add. {OUTPUT_FILE} is up to date!")
        return
        
    print(f"Found {len(new_tags)} new tags. Calling LLM...")
    updated_dict = batch_and_update(new_tags, all_rows, fieldnames)
    all_rows.extend(updated_dict.values())
    
    print(f"Appending {len(updated_dict)} categorized tags to {OUTPUT_FILE}...")
    save_csv(all_rows, fieldnames)

def main():
    parser = argparse.ArgumentParser(description="Readwise Tag Categorizer")
    parser.add_argument("--update-lifespans", action="store_true", help="Fill in missing lifespans for 'Person' tags.")
    args = parser.parse_args()
    
    if args.update_lifespans: 
        update_lifespans()
    else: 
        process_new_tags()

if __name__ == "__main__":
    main()
