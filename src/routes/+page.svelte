
<script lang="ts">
  import { onMount } from 'svelte';
  import type { ActionItem, ProcessResult } from '$lib/utils';

  type EditAction = ActionItem & { uiId: string; completed: boolean };
  type SavedAction = ActionItem & { completed: boolean };
  type HistoryEntry = {
    id: string;
    createdAt: string;
    transcript: string;
    summary: string;
    actions: SavedAction[];
    tags: string[];
  };
  type SpeechRec = {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
  };

  const DUE_HINT = 'YYYY-MM-DD or YYYY-MM-DD HH:mm';
  const K_HISTORY = 'vna_history_v1';
  const K_REMIND = 'vna_reminder_cfg_v1';
  const K_SENT = 'vna_reminder_sent_v1';

  let mediaRecorder: MediaRecorder | null = null;
  let speechRecognition: SpeechRec | null = null;
  let reminderInterval: ReturnType<typeof setInterval> | null = null;
  let recordingSupported = false;
  let recordingMimeType = '';
  let recordingExtension = 'webm';

  let chunks: Blob[] = [];
  let isRecording = false;
  let isProcessing = false;
  let isImproving = false;
  let streamingSupported = false;

  let error = '';
  let info = '';
  let reminderInfo = '';
  let audioUrl = '';
  let liveTranscript = '';
  let stableTranscript = '';

  let result: ProcessResult | null = null;
  let actions: EditAction[] = [];
  let editingId: string | null = null;
  let editDraft: { title: string; summary: string; type: ActionItem['type']; due: string } | null = null;

  let historyEntries: HistoryEntry[] = [];
  let activeHistoryId: string | null = null;
  let historySearch = '';
  let historyType: 'all' | ActionItem['type'] = 'all';
  let historyTag = 'all';
  let historyStatus: 'all' | 'open' | 'completed' = 'all';

  let reminderEnabled = false;
  let reminderLeadMin = 15;
  let notificationPermission: NotificationPermission | 'unsupported' = 'default';
  let reminded = new Set<string>();

  $: totalActions = actions.length;
  $: scheduledActions = actions.filter((a) => Boolean(a.due)).length;
  $: completedActions = actions.filter((a) => a.completed).length;
  $: avgConfidence = totalActions
    ? Math.round((actions.reduce((s, a) => s + (a.confidence ?? 0.75), 0) / totalActions) * 100)
    : 0;
  $: tagOptions = ['all', ...Array.from(new Set(historyEntries.flatMap((h) => h.tags))).sort()];
  $: pendingReminders = historyEntries.reduce((s, h) => s + h.actions.filter((a) => a.due && !a.completed).length, 0);

  $: filteredHistory = historyEntries.filter((h) => {
    const text = [
      h.transcript,
      h.summary,
      h.tags.join(' '),
      h.actions.map((a) => `${a.title} ${a.summary}`).join(' ')
    ]
      .join(' ')
      .toLowerCase();

    if (historySearch.trim() && !text.includes(historySearch.trim().toLowerCase())) return false;
    if (historyType !== 'all' && !h.actions.some((a) => a.type === historyType)) return false;
    if (historyTag !== 'all' && !h.tags.includes(historyTag)) return false;

    const allDone = h.actions.length > 0 && h.actions.every((a) => a.completed);
    if (historyStatus === 'completed' && !allDone) return false;
    if (historyStatus === 'open' && allDone) return false;
    return true;
  });

  onMount(() => {
    loadHistory();
    loadReminderCfg();
    loadReminded();

    recordingSupported =
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== 'undefined';

    if ('Notification' in window) notificationPermission = Notification.permission;
    else notificationPermission = 'unsupported';

    checkReminders();
    reminderInterval = setInterval(checkReminders, 45_000);

    return () => {
      if (reminderInterval) clearInterval(reminderInterval);
    };
  });

  function mkEditable(list: Array<ActionItem | SavedAction>): EditAction[] {
    return list.map((a) => ({
      ...a,
      uiId: makeId(),
      completed: typeof (a as SavedAction).completed === 'boolean' ? (a as SavedAction).completed : false,
      confidence: typeof a.confidence === 'number' ? Math.max(0, Math.min(1, a.confidence)) : 0.75,
      subtasks: Array.isArray(a.subtasks) ? a.subtasks.filter((s): s is string => typeof s === 'string') : []
    }));
  }

  function makeId(): string {
    if (typeof crypto !== 'undefined') {
      if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      if (typeof crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
    }
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function getSupportedRecorderMimeType(): string {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }

    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg'
    ];

    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }

    return '';
  }

  function extensionFromMime(mime: string): string {
    const lower = mime.toLowerCase();
    if (lower.includes('mp4')) return 'm4a';
    if (lower.includes('ogg')) return 'ogg';
    if (lower.includes('webm')) return 'webm';
    return 'audio';
  }

  function toSaved(list: EditAction[]): SavedAction[] {
    return list.map((a) => ({
      title: a.title,
      summary: a.summary,
      type: a.type,
      intent: a.intent,
      due: a.due ?? null,
      confidence: a.confidence,
      group: a.group ?? null,
      subtasks: a.subtasks ?? [],
      completed: a.completed
    }));
  }

  function toPayload(list: EditAction[]): ActionItem[] {
    return list.map((a) => ({
      title: a.title,
      summary: a.summary,
      type: a.type,
      intent: a.intent,
      due: a.due ?? null,
      confidence: a.confidence,
      group: a.group ?? null,
      subtasks: a.subtasks ?? []
    }));
  }

  function confPct(v?: number): number {
    const x = typeof v === 'number' && !Number.isNaN(v) ? v : 0.75;
    return Math.round(Math.max(0, Math.min(1, x)) * 100);
  }

  function dueDate(due?: string | null): Date | null {
    if (!due) return null;
    const t = due.trim();
    if (!t) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(`${t}T09:00:00`);
    const dt = new Date(t.includes(' ') ? t.replace(' ', 'T') : t);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function dueText(due?: string | null): string {
    if (!due) return 'No due date';
    const dt = dueDate(due);
    return dt ? dt.toLocaleString() : `${due} (${DUE_HINT})`;
  }

  function tagsFrom(transcript: string, summary: string, list: Array<ActionItem | SavedAction>): string[] {
    const tags = new Set<string>();
    list.forEach((a) => {
      tags.add(a.type);
      if (a.due) tags.add('scheduled');
      if (a.group) tags.add('grouped');
    });
    `${summary} ${transcript}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 5)
      .slice(0, 4)
      .forEach((w) => tags.add(w));
    return Array.from(tags).slice(0, 8);
  }

  function persistHistory() {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(K_HISTORY, JSON.stringify(historyEntries));
  }

  function saveReminderCfg() {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(K_REMIND, JSON.stringify({ enabled: reminderEnabled, lead: reminderLeadMin }));
  }

  function saveReminded() {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(K_SENT, JSON.stringify(Array.from(reminded)));
  }

  function loadReminderCfg() {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(K_REMIND);
      if (!raw) return;
      const p = JSON.parse(raw) as { enabled?: unknown; lead?: unknown };
      if (typeof p.enabled === 'boolean') reminderEnabled = p.enabled;
      if (typeof p.lead === 'number') reminderLeadMin = Math.min(120, Math.max(1, Math.round(p.lead)));
    } catch {
      // ignore
    }
  }

  function loadReminded() {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(K_SENT);
      if (!raw) return;
      const p = JSON.parse(raw) as unknown;
      if (Array.isArray(p)) reminded = new Set(p.filter((x): x is string => typeof x === 'string'));
    } catch {
      // ignore
    }
  }
  function loadHistory() {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(K_HISTORY);
      if (!raw) return;
      const p = JSON.parse(raw) as unknown;
      if (!Array.isArray(p)) return;

      historyEntries = p
        .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
        .map((h) => {
          const arr = Array.isArray(h.actions) ? h.actions : [];
          const parsedActions: SavedAction[] = arr.map((rawAction) => {
            const a = (rawAction || {}) as Record<string, unknown>;
            return {
              title: typeof a.title === 'string' ? a.title : 'Follow up',
              summary: typeof a.summary === 'string' ? a.summary : 'Follow up on this note.',
              type: typeof a.type === 'string' ? (a.type as ActionItem['type']) : 'task',
              intent: typeof a.intent === 'string' ? (a.intent as ActionItem['intent']) : 'task',
              due: typeof a.due === 'string' ? a.due : null,
              confidence: typeof a.confidence === 'number' ? a.confidence : 0.75,
              group: typeof a.group === 'string' ? a.group : null,
              subtasks: Array.isArray(a.subtasks) ? a.subtasks.filter((s): s is string => typeof s === 'string') : [],
              completed: Boolean(a.completed)
            };
          });

          const transcript = typeof h.transcript === 'string' ? h.transcript : '';
          const summary = typeof h.summary === 'string' ? h.summary : '';
          return {
            id: typeof h.id === 'string' ? h.id : makeId(),
            createdAt: typeof h.createdAt === 'string' ? h.createdAt : new Date().toISOString(),
            transcript,
            summary,
            actions: parsedActions,
            tags: Array.isArray(h.tags)
              ? h.tags.filter((t): t is string => typeof t === 'string')
              : tagsFrom(transcript, summary, parsedActions)
          };
        })
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

      if (historyEntries[0]) loadHistoryEntry(historyEntries[0].id);
    } catch {
      // ignore
    }
  }

  function addHistoryFromCurrent() {
    if (!result) return;
    const entry: HistoryEntry = {
      id: makeId(),
      createdAt: new Date().toISOString(),
      transcript: result.transcript,
      summary: result.summary,
      actions: toSaved(actions),
      tags: tagsFrom(result.transcript, result.summary, actions)
    };
    historyEntries = [entry, ...historyEntries];
    activeHistoryId = entry.id;
    persistHistory();
  }

  function syncActiveHistory() {
    if (!result || !activeHistoryId) return;
    const current = result;
    const nowActions = toSaved(actions);
    historyEntries = historyEntries.map((h) =>
      h.id === activeHistoryId
        ? {
            ...h,
            transcript: current.transcript,
            summary: current.summary,
            actions: nowActions,
            tags: tagsFrom(current.transcript, current.summary, nowActions)
          }
        : h
    );
    persistHistory();
  }

  function loadHistoryEntry(id: string) {
    const h = historyEntries.find((x) => x.id === id);
    if (!h) return;
    activeHistoryId = h.id;
    result = {
      transcript: h.transcript,
      summary: h.summary,
      actions: h.actions.map((a) => ({
        title: a.title,
        summary: a.summary,
        type: a.type,
        intent: a.intent,
        due: a.due ?? null,
        confidence: a.confidence,
        group: a.group ?? null,
        subtasks: a.subtasks ?? []
      }))
    };
    actions = mkEditable(h.actions);
    info = 'Loaded from history.';
    error = '';
  }

  function removeHistoryEntry(id: string) {
    historyEntries = historyEntries.filter((h) => h.id !== id);
    if (activeHistoryId === id) {
      activeHistoryId = null;
      result = null;
      actions = [];
      info = '';
    }
    persistHistory();
  }

  function clearHistory() {
    if (typeof window === 'undefined') return;
    if (!window.confirm('Clear all history?')) return;
    historyEntries = [];
    activeHistoryId = null;
    result = null;
    actions = [];
    info = '';
    persistHistory();
  }

  async function requestNotifications() {
    if (!('Notification' in window)) {
      notificationPermission = 'unsupported';
      error = 'Notifications are not supported here.';
      return;
    }
    notificationPermission = await Notification.requestPermission();
    if (notificationPermission === 'granted') {
      error = '';
      reminderInfo = 'Notifications enabled.';
      checkReminders();
    } else {
      error = 'Please allow notifications to enable reminders.';
    }
  }

  function setReminderEnabled(v: boolean) {
    reminderEnabled = v;
    saveReminderCfg();
    if (v) checkReminders();
  }

  function setReminderLead(v: string) {
    const n = Number(v);
    reminderLeadMin = Number.isFinite(n) ? Math.min(120, Math.max(1, Math.round(n))) : 15;
    saveReminderCfg();
    if (reminderEnabled) checkReminders();
  }

  function checkReminders() {
    if (!reminderEnabled || notificationPermission !== 'granted' || !('Notification' in window)) return;

    const now = Date.now();
    const leadMs = reminderLeadMin * 60_000;
    const graceMs = 5 * 60_000;
    let sent = 0;

    for (const h of historyEntries) {
      h.actions.forEach((a, idx) => {
        if (!a.due || a.completed) return;
        const d = dueDate(a.due);
        if (!d) return;
        const k = `${h.id}:${idx}:${a.due}`;
        if (reminded.has(k)) return;

        const dueMs = d.getTime();
        if (now < dueMs - leadMs || now > dueMs + graceMs) return;

        new Notification('Voice Note Reminder', { body: `${a.title} due ${d.toLocaleString()}` });
        reminded.add(k);
        sent += 1;
      });
    }

    if (sent > 0) {
      reminderInfo = sent === 1 ? '1 reminder sent.' : `${sent} reminders sent.`;
      saveReminded();
    }
  }

  function toggleComplete(id: string) {
    actions = actions.map((a) => (a.uiId === id ? { ...a, completed: !a.completed } : a));
    syncActiveHistory();
  }

  function deleteAction(id: string) {
    actions = actions.filter((a) => a.uiId !== id);
    if (editingId === id) cancelEdit();
    syncActiveHistory();
  }

  function startEdit(a: EditAction) {
    editingId = a.uiId;
    editDraft = { title: a.title, summary: a.summary, type: a.type, due: a.due || '' };
  }

  function cancelEdit() {
    editingId = null;
    editDraft = null;
  }

  function saveEdit(id: string) {
    if (!editDraft) return;
    actions = actions.map((a) =>
      a.uiId === id
        ? {
            ...a,
            title: editDraft?.title.trim() || a.title,
            summary: editDraft?.summary.trim() || a.summary,
            type: editDraft?.type || a.type,
            intent: editDraft?.type || a.type,
            due: editDraft?.due.trim() || null
          }
        : a
    );
    cancelEdit();
    syncActiveHistory();
  }

  function formatGoogleUtc(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function addMinutes(date: Date, m: number): Date {
    return new Date(date.getTime() + m * 60_000);
  }

  function toGoogleCalendarUrl(a: EditAction): string | null {
    if (!a.due) return null;
    const title = a.title || 'Action item';
    const details = a.summary || '';
    const due = a.due.trim();
    let dates = '';

    if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      const start = new Date(`${due}T00:00:00`);
      if (Number.isNaN(start.getTime())) return null;
      const end = addMinutes(start, 24 * 60);
      const sd = `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}${String(start.getDate()).padStart(2, '0')}`;
      const ed = `${end.getFullYear()}${String(end.getMonth() + 1).padStart(2, '0')}${String(end.getDate()).padStart(2, '0')}`;
      dates = `${sd}/${ed}`;
    } else {
      const start = dueDate(due);
      if (!start) return null;
      const end = addMinutes(start, 30);
      dates = `${formatGoogleUtc(start)}/${formatGoogleUtc(end)}`;
    }

    const params = new URLSearchParams({ action: 'TEMPLATE', text: title, details, dates });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }
  function startStreamingTranscript() {
    const SpeechCtor =
      (window as unknown as { SpeechRecognition?: new () => SpeechRec }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;

    if (!SpeechCtor) {
      streamingSupported = false;
      return;
    }

    streamingSupported = true;
    stableTranscript = '';
    liveTranscript = '';
    speechRecognition = new SpeechCtor();
    speechRecognition.lang = 'en-US';
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;

    speechRecognition.onresult = (event: unknown) => {
      const e = event as { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> };
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const chunk = e.results[i][0]?.transcript || '';
        if (e.results[i].isFinal) stableTranscript += `${chunk} `;
        else interim += chunk;
      }
      liveTranscript = `${stableTranscript}${interim}`.trim();
    };

    speechRecognition.onend = () => {
      if (isRecording) {
        try {
          speechRecognition?.start();
        } catch {
          // ignore
        }
      }
    };

    try {
      speechRecognition.start();
    } catch {
      streamingSupported = false;
      speechRecognition = null;
    }
  }

  function stopStreamingTranscript() {
    if (!speechRecognition) return;
    try {
      speechRecognition.stop();
    } catch {
      // ignore
    }
    speechRecognition = null;
  }

  async function startRecording() {
    error = '';
    info = '';
    result = null;
    audioUrl = '';
    actions = [];
    stableTranscript = '';
    liveTranscript = '';
    cancelEdit();

    try {
      if (!recordingSupported) {
        error = 'Live recording is not supported in this browser. Use Upload audio.';
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recordingMimeType = getSupportedRecorderMimeType();
      recordingExtension = extensionFromMime(recordingMimeType);

      mediaRecorder = recordingMimeType
        ? new MediaRecorder(stream, { mimeType: recordingMimeType })
        : new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const blobType = recordingMimeType || chunks[0]?.type || 'application/octet-stream';
        const blob = new Blob(chunks, { type: blobType });
        audioUrl = URL.createObjectURL(blob);
        await uploadAudio(blob, `voice-note.${recordingExtension}`);
        stream.getTracks().forEach((t) => t.stop());
      };

      mediaRecorder.start();
      isRecording = true;
      startStreamingTranscript();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not access microphone.';
    }
  }

  function stopRecording() {
    if (mediaRecorder && isRecording) {
      stopStreamingTranscript();
      mediaRecorder.stop();
      isRecording = false;
    }
  }

  async function uploadAudio(audio: Blob | File, filename = 'voice-note.webm') {
    isProcessing = true;
    error = '';
    try {
      const formData = new FormData();
      if (audio instanceof File) {
        formData.append('audio', audio, audio.name || filename);
      } else {
        formData.append('audio', audio, filename);
      }

      const res = await fetch('/api/process', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Processing failed.');

      result = data;
      actions = mkEditable(data.actions || []);
      addHistoryFromCurrent();
      checkReminders();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Something went wrong.';
    } finally {
      isProcessing = false;
    }
  }

  async function handleAudioUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    error = '';
    info = '';
    audioUrl = URL.createObjectURL(file);
    await uploadAudio(file, file.name || 'voice-note-upload');
    input.value = '';
  }

  async function improveTasks() {
    if (!result || actions.length === 0) return;
    isImproving = true;
    error = '';
    info = '';

    try {
      const res = await fetch('/api/improve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: result.transcript,
          summary: result.summary,
          actions: toPayload(actions)
        })
      });

      const data = (await res.json()) as ProcessResult & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Task refinement failed.');

      result = {
        transcript: data.transcript || result.transcript,
        summary: data.summary || result.summary,
        actions: data.actions || []
      };
      actions = mkEditable(result.actions);
      cancelEdit();
      if (!activeHistoryId) addHistoryFromCurrent();
      else syncActiveHistory();
      checkReminders();
      info = 'Tasks were refined. Review and edit if needed.';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Task refinement failed.';
    } finally {
      isImproving = false;
    }
  }
</script>

<svelte:head>
  <title>Voice Note to Action</title>
  <meta name="description" content="Convert voice notes into structured actions." />
</svelte:head>

<div class="page">
  <main class="shell">
    <section class="card hero">
      <p class="eyebrow">VOICE PRODUCTIVITY STUDIO</p>
      <h1>Voice Note to Action</h1>
      <p class="tagline">Turn spoken thoughts into clear tasks, reminders, and calendar actions.</p>

      <div class="control-row">
        {#if recordingSupported}
          {#if !isRecording}
            <button class="primary" on:click={startRecording} disabled={isProcessing || isImproving}>Start recording</button>
          {:else}
            <button class="danger" on:click={stopRecording}>Stop recording</button>
          {/if}
        {:else}
          <span class="muted compatibility-note">Recording is unavailable in this browser. Upload audio instead.</span>
        {/if}

        <label class="mini ghost upload-btn">
          Upload audio
          <input type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm" on:change={handleAudioUpload} />
        </label>

        {#if isRecording}<span class="chip">Recording live</span>{/if}
        {#if isProcessing}<span class="chip">Extracting</span>{/if}
        {#if isImproving}<span class="chip">Improving</span>{/if}
      </div>

      {#if isRecording || liveTranscript}
        <div class="panel">
          <p class="label">Live transcription</p>
          {#if streamingSupported}
            <p>{liveTranscript || 'Start speaking...'}</p>
          {:else}
            <p class="muted">Streaming preview is not supported in this browser.</p>
          {/if}
        </div>
      {/if}

      {#if audioUrl}
        <div class="panel">
          <p class="label">Recorded clip</p>
          <audio controls src={audioUrl}></audio>
        </div>
      {/if}

      {#if error}<div class="error">{error}</div>{/if}
      {#if info}<div class="success">{info}</div>{/if}
    </section>

    {#if totalActions > 0 || historyEntries.length > 0}
      <section class="quick-stats">
        <article class="pill">
          <p>Actions</p>
          <strong>{totalActions}</strong>
        </article>
        <article class="pill">
          <p>Completed</p>
          <strong>{completedActions}</strong>
        </article>
        <article class="pill">
          <p>History</p>
          <strong>{historyEntries.length}</strong>
        </article>
        <article class="pill">
          <p>Reminders</p>
          <strong>{pendingReminders}</strong>
        </article>
      </section>
    {/if}

    <section class="card">
      {#if result}
        <h2>Transcript</h2>
        <p>{result.transcript}</p>
        <h2>Summary</h2>
        <p>{result.summary}</p>

        <div class="actions-header">
          <div>
            <h2>Action items</h2>
            <p class="muted">Due format: {DUE_HINT}</p>
          </div>
          <button class="secondary" on:click={improveTasks} disabled={isImproving || isProcessing || actions.length === 0}>
            {isImproving ? 'Improving...' : 'Improve tasks'}
          </button>
        </div>

        {#if actions.length === 0}
          <p>No actions found.</p>
        {:else}
          <div class="list">
            {#each actions as action, i}
              <div class={`item ${action.completed ? 'complete' : ''}`} style={`--i:${i}`}>
                {#if editingId === action.uiId && editDraft}
                  <div class="edit-grid">
                    <input bind:value={editDraft.title} placeholder="Task title" />
                    <select bind:value={editDraft.type}>
                      <option value="task">task</option>
                      <option value="reminder">reminder</option>
                      <option value="calendar">calendar</option>
                      <option value="note">note</option>
                      <option value="idea">idea</option>
                    </select>
                    <input bind:value={editDraft.summary} placeholder="Task summary" />
                    <input bind:value={editDraft.due} placeholder={`Due (${DUE_HINT})`} />
                  </div>
                    <div class="row edit-actions">
                      <button class="mini" on:click={() => saveEdit(action.uiId)}>Save</button>
                      <button class="mini ghost" on:click={cancelEdit}>Cancel</button>
                    </div>
                {:else}
                  <div class="row top">
                    <label class="checkbox">
                      <input type="checkbox" checked={action.completed} on:change={() => toggleComplete(action.uiId)} />
                      <strong class={action.completed ? 'done' : ''}>{action.title}</strong>
                    </label>
                    <span class="badge">{action.type}</span>
                  </div>
                  <p>{action.summary}</p>
                  <div class="progress"><span style={`width:${confPct(action.confidence)}%`}></span></div>
                  <small>Intent: {action.intent || action.type} • {confPct(action.confidence)}% confidence • Due: {dueText(action.due)}</small>

                  {#if action.group || (action.subtasks && action.subtasks.length > 0)}
                    <div class="group">
                      <p><strong>{action.group || 'Grouped subtasks'}</strong></p>
                      {#if action.subtasks && action.subtasks.length > 0}
                        <ul>{#each action.subtasks as subtask}<li>{subtask}</li>{/each}</ul>
                      {/if}
                    </div>
                  {/if}

                    <div class="row action-bar">
                      {#if toGoogleCalendarUrl(action)}
                        <a class="mini calendar" href={toGoogleCalendarUrl(action) || '#'} target="_blank" rel="noreferrer">Google Calendar</a>
                      {/if}
                      <button class="mini ghost" on:click={() => startEdit(action)}>Modify</button>
                      <button class="mini danger-soft" on:click={() => deleteAction(action.uiId)}>Delete</button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        <h2>No active note yet</h2>
        <p>Record one or load from history.</p>
      {/if}
    </section>

    <section class="card compact-tools">
      <details>
        <summary>Advanced settings</summary>
        <div class="advanced-grid">
          <div class="stack-sm">
            <h3>Reminders</h3>
            <button class="secondary" on:click={requestNotifications}>Enable notifications</button>
            <label><input type="checkbox" checked={reminderEnabled} on:change={(e) => setReminderEnabled((e.currentTarget as HTMLInputElement).checked)} /> Reminders active</label>
            <label>
              Lead time
              <select value={String(reminderLeadMin)} on:change={(e) => setReminderLead((e.currentTarget as HTMLSelectElement).value)}>
                <option value="5">5 min</option>
                <option value="10">10 min</option>
                <option value="15">15 min</option>
                <option value="30">30 min</option>
                <option value="60">60 min</option>
              </select>
            </label>
            <p class="muted">Permission: {notificationPermission}</p>
            {#if reminderInfo}<div class="success">{reminderInfo}</div>{/if}
          </div>

          <div class="stack-sm">
            <h3>History filters</h3>
            <input type="text" placeholder="Search transcript, summary, actions..." bind:value={historySearch} />
            <select bind:value={historyType}>
              <option value="all">All types</option>
              <option value="task">Task</option>
              <option value="reminder">Reminder</option>
              <option value="calendar">Calendar</option>
              <option value="note">Note</option>
              <option value="idea">Idea</option>
            </select>
            <select bind:value={historyTag}>
              {#each tagOptions as tag}<option value={tag}>{tag === 'all' ? 'All tags' : tag}</option>{/each}
            </select>
            <select bind:value={historyStatus}>
              <option value="all">All status</option>
              <option value="open">Open only</option>
              <option value="completed">Completed only</option>
            </select>
            <button class="mini ghost" on:click={clearHistory} disabled={historyEntries.length === 0}>Clear history</button>
          </div>
        </div>
      </details>
    </section>

    {#if historyEntries.length > 0}
      <section class="card">
        <h2>History</h2>
        {#if filteredHistory.length === 0}
          <p class="muted">No history matches current filters.</p>
        {:else}
          <div class="history-list">
            {#each filteredHistory as h}
              <article class={`history ${activeHistoryId === h.id ? 'active' : ''}`}>
                <div class="row top"><strong>{new Date(h.createdAt).toLocaleString()}</strong><span>{h.actions.length} actions</span></div>
                <p>{h.summary}</p>
                <div class="tags">{#each h.tags as tag}<span class="tag">{tag}</span>{/each}</div>
                <div class="row history-actions">
                  <button class="mini" on:click={() => loadHistoryEntry(h.id)}>Load</button>
                  <button class="mini danger-soft" on:click={() => removeHistoryEntry(h.id)}>Delete</button>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  </main>
</div>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=JetBrains+Mono:wght@500&display=swap');

  :root {
    --bg-a: #f4efdf;
    --bg-b: #e8f3f6;
    --card: #fffdf9e9;
    --line: #cfdbe1;
    --text: #15212c;
    --muted: #5b6671;
    --brand: #0b6c79;
    --danger: #b43a2d;
    --ok-bg: #ebf8ef;
    --ok-line: #b5ddc1;
  }

  :global(body) {
    margin: 0;
    font-family: 'Outfit', sans-serif;
    color: var(--text);
    background: linear-gradient(150deg, var(--bg-a) 0%, #eff6f7 42%, var(--bg-b) 100%);
  }

  :global(*) { box-sizing: border-box; }
  .page { min-height: 100vh; padding: 16px 12px 24px; }
  .shell { max-width: 980px; margin: 0 auto; display: grid; gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; box-shadow: 0 14px 28px rgba(7, 28, 40, 0.07); }

  .eyebrow { margin: 0; font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; letter-spacing: 0.1em; color: var(--muted); }
  h1 { margin: 8px 0; font-size: clamp(1.8rem, 3.9vw, 2.7rem); line-height: 1.1; }
  .tagline { margin: 4px 0 2px; font-size: 1rem; color: #21313f; }
  h2 { margin: 8px 0; font-size: 1.15rem; }
  p { margin: 0; line-height: 1.55; }
  .muted { color: var(--muted); }
  h3 { margin: 0; font-size: 1rem; }

  button, .mini {
    border: none;
    border-radius: 10px;
    padding: 9px 12px;
    font-weight: 700;
    font-family: inherit;
    cursor: pointer;
    color: #fff;
    text-decoration: none;
  }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  .primary { background: linear-gradient(120deg, var(--brand) 0%, #0f7f8f 100%); }
  .secondary { background: linear-gradient(120deg, #385f7c 0%, #284b66 100%); }
  .danger { background: linear-gradient(120deg, #be483a 0%, #a22b2b 100%); }
  .mini { display: inline-flex; align-items: center; font-size: 0.82rem; background: #0d6f7d; }
  .mini.calendar { background: #228148; }
  .mini.ghost { background: #deeff2; color: #0f5f6a; }
  .mini.danger-soft { background: #f7d9dd; color: #8f2d37; }

  .chip { display: inline-flex; align-items: center; gap: 6px; background: #d7ebef; color: #0e6270; border-radius: 999px; padding: 5px 9px; font-size: 0.8rem; font-weight: 700; }
  .control-row, .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .control-row {
    margin-top: 12px;
    margin-bottom: 8px;
    padding: 0;
    border: none;
    background: transparent;
    width: auto;
  }
  .top { justify-content: space-between; }
  .panel { margin-top: 10px; background: #f6fbfd; border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
  .label { margin-bottom: 6px; font-size: 0.82rem; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
  .upload-btn {
    position: relative;
    overflow: hidden;
  }
  .upload-btn input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .compatibility-note {
    font-size: 0.9rem;
  }
  audio { width: 100%; }

  .error, .success { margin-top: 10px; padding: 10px; border-radius: 10px; border: 1px solid; font-size: 0.9rem; }
  .error { border-color: #f2bec3; background: #ffedf0; color: #952f39; }
  .success { border-color: var(--ok-line); background: var(--ok-bg); color: #266744; }

  .quick-stats {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    padding: 12px;
  }
  .pill {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #f8fcfd;
    padding: 10px 12px;
  }
  .pill p { margin: 0; font-size: 0.8rem; color: var(--muted); }
  .pill strong { font-size: 1.3rem; }

  .stack-sm { display: grid; gap: 10px; }
  .actions-header { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; margin-top: 10px; }

  input, select {
    width: 100%;
    border: 1px solid #cfd9df;
    border-radius: 8px;
    padding: 8px 10px;
    font: inherit;
    color: var(--text);
    background: #fff;
  }
  label { display: grid; gap: 6px; font-size: 0.9rem; color: var(--muted); }
  label input[type='checkbox'] { width: auto; }

  .list { display: grid; gap: 9px; margin-top: 10px; }
  .item { border: 1px solid #d7e1e7; border-radius: 12px; background: #f7fbfc; padding: 10px; }
  .item.complete { background: #edf8ef; border-color: #c5dcc9; }
  .checkbox { display: flex; align-items: center; gap: 8px; }
  .badge { background: #e0edf2; border-radius: 999px; padding: 3px 8px; font-size: 0.76rem; text-transform: lowercase; }
  .done { text-decoration: line-through; color: var(--muted); }
  .progress { margin: 7px 0; width: 100%; height: 7px; border-radius: 999px; background: #dcebf0; overflow: hidden; }
  .progress span { display: block; height: 100%; background: linear-gradient(120deg, #0a6f7d 0%, #1d9aa4 100%); }
  small { display: block; color: var(--muted); line-height: 1.45; }
  .group { margin-top: 8px; padding: 8px 9px; border: 1px dashed #b9d4da; border-radius: 9px; background: #ecf7fa; }
  .group ul { margin: 0; padding-left: 16px; }
  .edit-grid { display: grid; gap: 8px; grid-template-columns: 2fr 1fr; }
  .edit-actions { margin-top: 12px; }
  .action-bar {
    margin-top: 10px;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
  }

  .compact-tools {
    display: grid;
    gap: 10px;
    padding-top: 10px;
  }
  .compact-tools details {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: #f8fcfd;
    padding: 8px 10px;
  }
  .compact-tools summary {
    cursor: pointer;
    font-weight: 700;
    color: var(--text);
  }
  .compact-tools details[open] summary {
    margin-bottom: 10px;
  }
  .advanced-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
    align-items: start;
  }
  .advanced-grid > .stack-sm:first-child {
    padding-right: 6px;
  }
  .advanced-grid > .stack-sm:last-child {
    border-left: 1px solid #d6e3e8;
    padding-left: 16px;
  }

  .history-list { display: grid; gap: 8px; }
  .history { border: 1px solid #d7e1e7; border-radius: 10px; background: #f9fcfd; padding: 10px; }
  .history.active { border-color: #7cb6c1; box-shadow: inset 0 0 0 1px #7cb6c1; }
  .tags { margin-top: 7px; display: flex; gap: 6px; flex-wrap: wrap; }
  .tag { font-size: 0.72rem; border-radius: 999px; padding: 3px 8px; background: #e9f3f6; color: #1c6b76; }
  .history-actions { margin-top: 12px; }

  @media (max-width: 1080px) {
    .quick-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .advanced-grid { grid-template-columns: 1fr; }
    .advanced-grid > .stack-sm:first-child {
      padding-right: 0;
    }
    .advanced-grid > .stack-sm:last-child {
      border-left: none;
      border-top: 1px solid #d6e3e8;
      padding-left: 0;
      padding-top: 12px;
    }
  }
  @media (max-width: 740px) {
    .quick-stats { grid-template-columns: 1fr 1fr; }
    .edit-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 560px) {
    .quick-stats { grid-template-columns: 1fr; }
  }
</style>

