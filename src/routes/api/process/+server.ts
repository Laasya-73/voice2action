import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { safeJsonParse, type ActionItem, type ProcessResult } from '$lib/utils';

const ACTION_TYPES = ['task', 'reminder', 'calendar', 'note', 'idea'] as const;

type ActionType = (typeof ACTION_TYPES)[number];

type RawAction = {
  title?: unknown;
  type?: unknown;
  intent?: unknown;
  due?: unknown;
  summary?: unknown;
  confidence?: unknown;
  group?: unknown;
  subtasks?: unknown;
};

function normalizeType(value: unknown): ActionType {
  if (typeof value !== 'string') return 'task';
  const lowered = value.trim().toLowerCase() as ActionType;
  return ACTION_TYPES.includes(lowered) ? lowered : 'task';
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.75;
  return Math.max(0, Math.min(1, value));
}

function formatDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateTime(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function setTime(base: Date, hour: number, minute = 0): Date {
  const next = new Date(base);
  next.setHours(hour, minute, 0, 0);
  return next;
}

function parseExplicitDate(raw: string): { value: string; hasTime: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    return { value: trimmed, hasTime: false };
  }

  const dateTime = /^(\d{4})-(\d{2})-(\d{2})[t\s](\d{1,2}):(\d{2})$/.exec(trimmed.toLowerCase());
  if (dateTime) {
    const parsed = new Date(
      Number(dateTime[1]),
      Number(dateTime[2]) - 1,
      Number(dateTime[3]),
      Number(dateTime[4]),
      Number(dateTime[5])
    );
    if (!Number.isNaN(parsed.getTime())) {
      return { value: formatDateTime(parsed), hasTime: true };
    }
  }

  const generic = new Date(trimmed.includes(' ') ? trimmed.replace(' ', 'T') : trimmed);
  if (!Number.isNaN(generic.getTime())) {
    const hasTime = /\d{1,2}:\d{2}/.test(trimmed);
    return { value: hasTime ? formatDateTime(generic) : formatDateOnly(generic), hasTime };
  }

  return null;
}

function parseNaturalTime(text: string): { hour: number; minute: number } | null {
  const explicit = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (explicit) {
    let hour = Number(explicit[1]);
    const minute = explicit[2] ? Number(explicit[2]) : 0;
    const meridiem = explicit[3].toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  const twentyFour = /(?:at\s+)?(\d{1,2}):(\d{2})\b/.exec(text);
  if (twentyFour) {
    return { hour: Number(twentyFour[1]), minute: Number(twentyFour[2]) };
  }

  if (text.includes('morning')) return { hour: 9, minute: 0 };
  if (text.includes('afternoon')) return { hour: 15, minute: 0 };
  if (text.includes('evening')) return { hour: 19, minute: 0 };
  if (text.includes('tonight')) return { hour: 20, minute: 0 };
  if (text.includes('noon')) return { hour: 12, minute: 0 };
  if (text.includes('midnight')) return { hour: 0, minute: 0 };

  return null;
}

function parseNaturalDue(raw: string, fallbackText: string): string | null {
  const now = new Date();
  const text = `${raw} ${fallbackText}`.toLowerCase();
  const time = parseNaturalTime(text);

  let base: Date | null = null;
  if (text.includes('tomorrow')) base = addDays(now, 1);
  else if (text.includes('next week')) base = addDays(now, 7);
  else if (text.includes('today')) base = now;

  if (!base) return null;
  if (!time) return formatDateOnly(base);

  return formatDateTime(setTime(base, time.hour, time.minute));
}

function normalizeDue(rawDue: unknown, fallbackText: string): string | null {
  if (typeof rawDue !== 'string') return parseNaturalDue('', fallbackText);
  const trimmed = rawDue.trim();
  if (!trimmed) return parseNaturalDue('', fallbackText);

  const explicit = parseExplicitDate(trimmed);
  if (explicit) return explicit.value;

  return parseNaturalDue(trimmed, fallbackText);
}

function inferGroupedSubtasks(title: string): { group: string | null; subtasks: string[] } {
  const lower = title.toLowerCase();
  const buyLike = /^(buy|get|pick up|purchase)\s+(.+)/i.exec(title);

  if (buyLike) {
    const items = buyLike[2]
      .split(/,| and /i)
      .map((item) => item.trim())
      .filter(Boolean);

    if (items.length >= 2) {
      return {
        group: lower.startsWith('buy') || lower.startsWith('get') ? 'Grocery list' : `${buyLike[1]} list`,
        subtasks: items
      };
    }
  }

  return { group: null, subtasks: [] };
}

function normalizeActions(raw: unknown, transcript: string): ActionItem[] {
  const list = Array.isArray(raw) ? (raw as RawAction[]) : [];

  const normalized = list
    .map((action): ActionItem => {
      const title = typeof action.title === 'string' ? action.title.trim() : '';
      const summary = typeof action.summary === 'string' ? action.summary.trim() : '';
      const intent = normalizeType(action.intent ?? action.type);
      const due = normalizeDue(action.due, `${title} ${summary} ${transcript}`);
      const confidence = normalizeConfidence(action.confidence);

      const explicitSubtasks = Array.isArray(action.subtasks)
        ? action.subtasks.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
        : [];

      const grouped = inferGroupedSubtasks(title);
      const subtasks = explicitSubtasks.length > 0 ? explicitSubtasks : grouped.subtasks;
      const group = typeof action.group === 'string' && action.group.trim()
        ? action.group.trim()
        : grouped.group;

      return {
        title: title || 'Follow up',
        summary: summary || title || 'Follow up on this note.',
        type: intent,
        intent,
        due,
        confidence,
        group,
        subtasks
      };
    })
    .filter((action) => action.title.length > 0);

  if (normalized.length > 0) return normalized;

  return [
    {
      title: 'Review note',
      summary: transcript || 'No clear task detected.',
      type: 'note',
      intent: 'note',
      due: null,
      confidence: 0.6,
      group: null,
      subtasks: []
    }
  ];
}

async function transcribeWithDeepgram(file: File): Promise<string> {
  const deepgramApiKey = env.DEEPGRAM_API_KEY;

  if (!deepgramApiKey) {
    throw new Error('Missing DEEPGRAM_API_KEY.');
  }

  const buffer = await file.arrayBuffer();

  const res = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${deepgramApiKey}`,
        'Content-Type': file.type || 'application/octet-stream'
      },
      body: buffer
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Deepgram failed: ${text}`);
  }

  const data = await res.json();

  const transcript =
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';

  if (!transcript) {
    throw new Error('No transcript returned from Deepgram.');
  }

  return transcript;
}

async function extractActionsWithGroq(transcript: string): Promise<ProcessResult> {
  const groqApiKey = env.GROQ_API_KEY;
  const groqModel = env.GROQ_MODEL;

  if (!groqApiKey) {
    throw new Error('Missing GROQ_API_KEY.');
  }

  if (!groqModel) {
    throw new Error('Missing GROQ_MODEL.');
  }

  const prompt = `
You are an assistant that converts a voice note into structured action items.

Return ONLY valid JSON in this exact shape:
{
  "transcript": "string",
  "summary": "string",
  "actions": [
    {
      "title": "string",
      "type": "task | reminder | calendar | note | idea",
      "intent": "task | reminder | calendar | note | idea",
      "due": "YYYY-MM-DD | YYYY-MM-DD HH:mm | natural date text | null",
      "summary": "string",
      "confidence": 0.91,
      "group": "string or null",
      "subtasks": ["string"]
    }
  ]
}

Rules:
- Keep "transcript" exactly as given.
- Write a short clear summary.
- Extract concrete next actions.
- Include confidence from 0 to 1 for each action.
- Detect intent so non-action thoughts become "note" or "idea".
- Group list-like commands into one grouped task with subtasks array.
- If you detect natural time (e.g., tomorrow morning), include it in due.
- If there is no real action, return one item of type "note".
- Do not include markdown fences.
- Do not include any extra text.

Transcript:
${transcript}
`.trim();

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: groqModel,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You extract structured actions from voice notes and must reply with valid JSON only.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq failed: ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Groq returned an empty response.');
  }

  const parsed = safeJsonParse<ProcessResult>(content);

  return {
    transcript: parsed.transcript || transcript,
    summary: parsed.summary || '',
    actions: normalizeActions(parsed.actions, transcript)
  };
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const formData = await request.formData();
    const audio = formData.get('audio');

    if (!(audio instanceof File)) {
      return json({ error: 'Audio file is required.' }, { status: 400 });
    }

    const transcript = await transcribeWithDeepgram(audio);
    const result = await extractActionsWithGroq(transcript);

    return json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unexpected server error.';
    return json({ error: message }, { status: 500 });
  }
};
