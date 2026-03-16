export type ActionItem = {
  title: string;
  type: 'task' | 'reminder' | 'calendar' | 'note' | 'idea';
  intent?: 'task' | 'reminder' | 'calendar' | 'note' | 'idea';
  due?: string | null;
  summary: string;
  confidence?: number;
  group?: string | null;
  subtasks?: string[];
};

export type ProcessResult = {
  transcript: string;
  summary: string;
  actions: ActionItem[];
};

export function safeJsonParse<T>(raw: string): T {
  const cleaned = raw
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('Model did not return valid JSON.');
  }

  const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice) as T;
}
