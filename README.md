# Seneca — Decision Tracker for Obsidian

Seneca turns spoken thoughts into structured decision notes. Speak into your mic, and Seneca transcribes, extracts key fields, and gives you an observation about your own thinking — building a searchable record of how you make decisions over time.

## How it works

1. **Open command palette** → "Seneca: Voice decision"
2. **Speak your thought** — a specific decision, a half-formed idea, or just thinking out loud
3. **Seneca creates a structured note** with:
   - Title, category, status, confidence level, stakes, emotional state
   - Options you considered, what you chose, and why
   - An AI-generated observation about your thinking process
   - The raw transcript preserved for reference

As you log more decisions, Seneca remembers your history. Each new observation is informed by your past decisions — surfacing patterns, recurring themes, and contradictions you might not notice yourself.

## Features

- **Voice-to-structured-note** — Speak freely, get organized notes with frontmatter metadata
- **AI observations** — Non-obvious insights about your thinking process, not just a summary of what you said
- **Decision memory** — Seneca references your past decisions when analyzing new ones
- **Decision analysis** — "Analyze my decisions" command generates a comprehensive report across all your logged decisions
- **Revisit prompts** — Automatic reminders to check back on past decisions after a configurable period
- **Full/quick/voice templates** — Multiple ways to log decisions depending on your context
- **Outcome tracking** — Come back later to record what actually happened and rate the outcome
- **JSON log** — All decisions indexed in a structured log for export and analysis
- **Dataview compatible** — All frontmatter fields are queryable with the Dataview plugin

## Requirements

- **OpenAI API key** — Used for Whisper (transcription) and GPT-4o-mini (field extraction and observations). Add it in Seneca settings.
- **Microphone access** — Obsidian needs microphone permission in your OS settings.

## Commands

| Command | Description |
|---|---|
| **Voice decision** | Record and transcribe a voice note into a structured decision |
| **Log new decision** | Create a full decision template with all fields |
| **Quick decision log** | Create a lightweight decision note |
| **Log outcome** | Mark the current decision as resolved |
| **Analyze my decisions** | Generate an AI-powered analysis report across all decisions |
| **View decision stats** | Quick stats overview |
| **Export log for AI analysis** | Export the decision log as JSON |
| **Import decisions from file** | Merge decisions from a seneca-import.json file |

## Settings

| Setting | Default | Description |
|---|---|---|
| Decisions folder | `Seneca/Decisions` | Where decision notes are stored |
| Log file path | `Seneca/seneca-log.json` | Path to the JSON decision index |
| OpenAI API key | — | Your API key for Whisper and GPT |
| Default category | Other | Default category for new decisions |
| Revisit after (days) | 30 | Days before Seneca prompts you to revisit a decision |

## Recommended companion plugins

- **Dataview** — Create live dashboards that query your decision frontmatter (category, status, confidence, stakes, etc.)
- **Periodic Notes** — Weekly review templates that auto-populate with recent decisions
- **Charts** — Visualize decision trends over time

## Installation

### From Obsidian Community Plugins (coming soon)
1. Open Settings → Community plugins → Browse
2. Search for "Seneca"
3. Install and enable

### Manual installation
1. Download `main.js`, `manifest.json`, and `styles.css` (if present) from the latest release
2. Create a folder `your-vault/.obsidian/plugins/seneca-decision-tracker/`
3. Place the files in that folder
4. Enable the plugin in Settings → Community plugins

## Development

```bash
git clone https://github.com/nicholasbateman/seneca-decision-tracker.git
cd seneca-decision-tracker
npm install
npm run dev
```

## Privacy

Seneca sends your voice recordings to OpenAI's Whisper API for transcription and your transcript text to GPT-4o-mini for field extraction. No data is stored on any server — everything stays in your local vault. Your API key is stored in Obsidian's plugin settings on your device.

## License

MIT
