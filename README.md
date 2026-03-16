# Voice Note to Action

Voice Note to Action is a SvelteKit app that turns spoken notes into clear tasks, reminders, and calendar-ready actions.

## What it does

- Records audio in-browser (with format fallbacks) and supports manual audio upload.
- Shows live speech preview while recording when browser speech recognition is available.
- Transcribes audio with Deepgram.
- Extracts structured actions with Groq:
  - intent types: `task`, `reminder`, `calendar`, `note`, `idea`
  - confidence score (0-1)
  - due-date normalization (`YYYY-MM-DD` or `YYYY-MM-DD HH:mm`)
  - grouped subtasks for list-like commands
- Lets users manage actions:
  - complete
  - modify
  - delete
  - export to Google Calendar
- Includes an AI correction loop (`Improve tasks`) to refine extracted actions.
- Saves searchable/filterable history in browser local storage.
- Sends browser reminder notifications with configurable lead time.

## Storage model

- Current history/reminder state is stored locally in the browser (`localStorage`).
- No cloud database is required for core functionality.

## Browser/device compatibility

- Works across modern desktop and mobile browsers.
- If live recording is unavailable on a browser/device, users can still upload audio files (`mp3`, `m4a`, `wav`, `ogg`, `webm`).
- Some capabilities (live transcription preview, notifications) depend on browser support and permissions.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` in project root:

```bash
DEEPGRAM_API_KEY=your_deepgram_key
GROQ_API_KEY=your_groq_key
GROQ_MODEL=your_groq_model
```

3. Start development server:

```bash
npm run dev
```

4. Optional checks/build:

```bash
npm run check
npm run build
```
