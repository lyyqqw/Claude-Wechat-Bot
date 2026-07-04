const BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('panel_token');
}

export function setToken(token: string) {
  localStorage.setItem('panel_token', token);
}

export function clearToken() {
  localStorage.removeItem('panel_token');
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...opts, headers });

  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('Unauthorized');
  }

  return res.json();
}

export interface LoginResult {
  token: string;
}

export interface StatusData {
  bots: number;
  botList: { id: string; nickname: string; sessions: number }[];
  totalSessions: number;
  uptime: number;
  uptimeStr: string;
  memoryMB: number;
  heapMB: number;
}

export interface BotData {
  id: string;
  bot_token: string;
  bot_base_url: string;
  nickname: string;
  createdAt: number;
}

export interface SessionData {
  userId: string;
  botId: string;
  messageCount: number;
  selectedModel?: string;
  pendingMedia: number;
  updatedAt: number;
  age: number;
}

export interface LogEntry {
  time: number;
  level: string;
  message: string;
}

export async function fetchVersion(): Promise<string> {
  const data = await request<{ version: string }>('/version');
  return data.version;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

export async function fetchStatus(): Promise<StatusData> {
  return request<StatusData>('/status');
}

export async function fetchBots(): Promise<BotData[]> {
  return request<BotData[]>('/bots');
}

export async function deleteBot(id: string): Promise<void> {
  await request(`/bots/${id}`, { method: 'DELETE' });
}

export async function fetchSessions(userId?: string): Promise<SessionData[]> {
  const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  return request<SessionData[]>(`/sessions${qs}`);
}

export interface ConvSummary {
  userId: string;
  botId: string;
  messageCount: number;
  lastMessage: { role: string; text: string; timestamp: number } | null;
  updatedAt: number;
}

export interface MessageEntry {
  type?: string;
  role: string;
  text: string;
  timestamp: number;
  botName?: string;
  media?: { filepath: string; isImage: boolean }[];
}

export interface Conversation {
  botId: string;
  userId: string;
  contextToken?: string;
  messages: MessageEntry[];
  messageCount: number;
  updatedAt: number;
}

export async function fetchConversations(): Promise<ConvSummary[]> {
  return request<ConvSummary[]>('/conversations');
}

export async function fetchConversation(userId: string): Promise<Conversation> {
  return request<Conversation>(`/conversations/${encodeURIComponent(userId)}`);
}

export async function sendConversationMessage(userId: string, text: string): Promise<{ reply: string }> {
  return request<{ reply: string }>(`/conversations/${encodeURIComponent(userId)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

export function connectConversationStream(
  userId: string,
  onEntry: (entry: MessageEntry) => void,
): () => void {
  const token = getToken();
  const url = `${BASE}/conversations/${encodeURIComponent(userId)}/stream`;
  const es = new EventSourcePolyfill(url, token);
  es.onmessage = (e) => {
    try { onEntry(JSON.parse(e.data)); } catch { /* skip */ }
  };
  return () => es.close();
}

export function connectLogStream(
  onEntry: (entry: LogEntry) => void,
): () => void {
  const token = getToken();
  const url = `${BASE}/logs`;
  const es = new EventSourcePolyfill(url, token);
  es.onmessage = (e) => {
    try { onEntry(JSON.parse(e.data)); } catch { /* skip */ }
  };
  return () => es.close();
}

// Fallback SSE with auth header (EventSource doesn't support custom headers natively)
class EventSourcePolyfill {
  private xhr: XMLHttpRequest | null = null;
  private lastIndex = 0;
  private closed = false;
  private url: string;
  private token: string | null;
  onmessage: ((e: MessageEvent) => void) | null = null;

  constructor(url: string, token: string | null) {
    this.url = url;
    this.token = token;
    this.poll();
  }

  private poll() {
    if (this.closed) return;
    const xhr = new XMLHttpRequest();
    this.xhr = xhr;
    xhr.open('GET', this.url, true);
    if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
    xhr.setRequestHeader('Accept', 'text/event-stream');
    xhr.setRequestHeader('Cache-Control', 'no-cache');
    xhr.onprogress = () => {
      const newData = xhr.responseText.slice(this.lastIndex);
      this.lastIndex = xhr.responseText.length;
      const lines = newData.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          this.onmessage?.({ data: line.slice(6) } as MessageEvent);
        }
      }
      // Reconnect when done
      if (xhr.readyState === 4) {
        setTimeout(() => this.poll(), 100);
      }
    };
    xhr.send();
  }

  close() {
    this.closed = true;
    this.xhr?.abort();
  }
}
