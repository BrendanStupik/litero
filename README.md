Litero is a themable, customizable frontend for Readwise, designed around a principle of navigability for users with lots of tagged highlights.


## Core Features

* **Filter by multiple tags at once**. Tired of scrolling through 150 highlights tagged "Immanuel Kant" just to find his comments on marriage? Just select "Immanuel Kant" and "marriage"!

![Example](https://github.com/BrendanStupik/litero/blob/main/screenshots/5.png?raw=true)

* **Group by book**. Viewing highlights chronologically can be useful, but I often find myself wanting to know how a tag is mentioned in a particular book.

![Group by book](https://github.com/BrendanStupik/litero/blob/main/screenshots/2.png?raw=true)

* **Taxonomy view**. Sorts all tags into categories and fields. For example, "Ashʿarism," "Muʿtazilism," "Scholasticism," and "Thomism" might be readily available under a "Medieval Philosophy" field value, depending on your setup!

* **Automated taxonomy**. Send your tags incrementally to Claude, Gemini, or ChatGPT for processing.

* **Taxonomy config**. Easily customize your taxonomy agent's available categories and fields.

* **Difficulty-based SRS**. The daily reviews on Readwise are fantastic, but Litero aims to give you more control over your review time, allowing you to select any individual document or tag for review with ease, or simply recap yesterday's reading.

![Study feature](https://github.com/BrendanStupik/litero/blob/main/screenshots/3.png?raw=true)

* **Map**. Allows for a quick glance at your tags' relationships to each other. Inspired by Obsidian.

* **Tag index**. A full, glanceable index of your tags, with period recap information.

* **Tag pages**. A homepage for your tags. See all the documents they appear in in one place, with a brief overview from Wikipedia. For authors, see primary and secondary sources.

![Tag homepage](https://github.com/BrendanStupik/litero/blob/main/screenshots/4.png?raw=true)

* **Lightning-fast search**. Pressing Tab brings up a search menu that easily directs you to your desired highlights or tags.

## Installation & Setup

1. Clone the repository: `git clone https://github.com/BrendanStupik/litero.git && cd litero`
2. Install the locked dependencies: `pip install -r requirements.lock`
3. Run the setup wizard: `python setup.py` will generate sample `taxonomy.json` and `secrets.json` files. **Note:** This stores API keys locally, with protections based on your operating system. You may want to use environment variables instead!
4. Launch the app: `python app.py`
5. Open your browser to `http://127.0.0.1:43353`
6. Press the settings button in the top-right corner to edit your taxonomy settings for AI agents.
7. Perform an initial refresh on the study page to generate your SRS database.

## Prerequisites

* Python 3.10 or newer
* A Readwise account with an active API token

## Security & Privacy

Litero is designed to run only at `http://127.0.0.1:43353`. Of course, you're more than welcome to change the port from 43353, but I do not recommend binding it to `0.0.0.0`, exposing it through a reverse proxy, port-forwarding it, or doing anything similar without revising the code.

Litero locally stores your Readwise highlights, notes, tags, book metadata, SRS history, taxonomy, cached cover images, and provided API credentials, excluding environment variables.

As far as network activity goes, Litero accesses the Readwise API to sync and edit highlights, notes, and tags. Covers are downloaded from public HTTPS URLs supplied by Readwise. Wikipedia requests are made on demand when accessing a tag page. When `taxonomer.py` is run, tag names from Readwise and configured taxonomy prompts are sent to the Gemini, OpenAI, or Anthropic API. Highlight bodies and notes are not intentionally included in that taxonomy request.

Frontend dependencies are vendored under `js/vendor/`; Litero does not load executable JavaScript from a CDN.

## Contributions

Contributions are more than welcome! Feel free to submit a pull request or open an issue on the GitHub repository!

## License

Copyright (c) 2026 Brendan Stupik

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
