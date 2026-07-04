import { useState, useEffect, useRef } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import {
  fetchConversations, fetchConversation, sendConversationMessage,
  connectConversationStream, type ConvSummary, type MessageEntry,
} from '../api';

function formatTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function timeStr(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export default function ChatPage() {
  const [convList, setConvList] = useState<ConvSummary[]>([]);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [streamUserId, setStreamUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const msgEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const msgBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { fetchConversations().then(setConvList); }, []);

  const openConv = async (userId: string) => {
    setActiveUserId(userId);
    setStreamUserId(null);
    setMessages([]);
    setLoadingMsg(true);
    try {
      const conv = await fetchConversation(userId);
      setMessages(conv?.messages || []);
      setStreamUserId(userId);
    } finally { setLoadingMsg(false); }
  };

  useEffect(() => {
    if (!streamUserId) return;
    return connectConversationStream(streamUserId, (entry) => {
      if (entry.type !== 'message') return;
      if (entry.role === 'assistant') setThinking(false);
      setMessages(prev => {
        if (prev.some(m => m.timestamp === entry.timestamp && m.role === entry.role && m.text === entry.text)) return prev;
        return [...prev, entry];
      });
      setConvList(prev => prev.map(c =>
        c.userId === streamUserId
          ? { ...c, lastMessage: entry, messageCount: c.messageCount + 1, updatedAt: Date.now() }
          : c,
      ));
    });
  }, [streamUserId]);

  useEffect(() => { msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  useGSAP(() => {
    const box = msgBoxRef.current;
    if (!box) return;
    const children = box.children;
    const last = children[children.length - 2] as HTMLElement | null;
    if (last && !last.dataset.a) {
      last.dataset.a = '1';
      gsap.fromTo(last, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power4.out' });
    }
  }, { scope: msgBoxRef, dependencies: [messages.length], revertOnUpdate: false });

  useGSAP(() => {
    const items = listRef.current?.querySelectorAll<HTMLElement>('.conv-item');
    if (!items?.length) return;
    gsap.fromTo(items, { autoAlpha: 0, x: -6 }, { autoAlpha: 1, x: 0, duration: 0.3, stagger: 0.03, ease: 'power4.out' });
  }, { scope: listRef, dependencies: [convList.length], revertOnUpdate: true });

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || !activeUserId || sending) return;
    setSending(true);
    setThinking(true);
    setInputText('');
    try {
      await sendConversationMessage(activeUserId, text);
      inputRef.current?.focus();
    } catch (err: any) {
      setThinking(false);
      setInputText(text);
      alert(err.message || '发送失败');
    } finally { setSending(false); }
  };

  return (
    <div className="chat-layout">
      <div className="conv-list">
        <div className="conv-list-header"><h2>对话</h2></div>
        <div className="conv-items" ref={listRef}>
          {convList.length === 0 && <div className="empty-state" style={{ padding: '24px 12px' }}>暂无对话</div>}
          {convList.map(conv => (
            <div key={conv.userId} className={`conv-item${activeUserId === conv.userId ? ' active' : ''}`}
              onClick={() => openConv(conv.userId)}>
              <div className="conv-item-top">
                <span className="conv-item-name">{conv.userId.split('@')[0]}</span>
                <span className="conv-item-time">{formatTime(conv.updatedAt)}</span>
              </div>
              <div className="conv-item-preview">
                {conv.lastMessage ? (conv.lastMessage.text || '[媒体]') : '空'}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="chat-area">
        {!activeUserId ? (
          <div className="chat-empty">
            <svg width="32" height="32" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" style={{ opacity: 0.3 }}>
              <path d="M2 8a6 6 0 0 1 6-6h0a6 6 0 0 1 6 6v4a1 1 0 0 1-1 1H8a6 6 0 0 1-6-6z"/><path d="M5 7h6"/><path d="M5 9h4"/>
            </svg>
            <span>选择一个对话开始查看</span>
          </div>
        ) : (
          <>
            <div className="msg-box" ref={msgBoxRef}>
              {loadingMsg && <div className="empty-state">加载中...</div>}
              {messages.map((msg, i) => (
                <div key={i} className={`chat-bubble-row ${msg.role}`}>
                  <div className={`chat-bubble ${msg.role}`}>
                    {msg.role === 'assistant' && msg.botName && (
                      <div className="bot-label">{msg.botName}</div>
                    )}
                    <div className="msg-text">{msg.text || '[媒体文件]'}</div>
                    <div className="msg-time">{timeStr(msg.timestamp)}</div>
                  </div>
                </div>
              ))}
              {thinking && (
                <div className="chat-bubble-row assistant">
                  <div className="thinking-indicator">
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                  </div>
                </div>
              )}
              <div ref={msgEndRef} />
            </div>

            <div className="chat-input-bar">
              <input ref={inputRef} className="chat-input" placeholder="输入消息..." value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
                disabled={sending} />
              <button className="btn btn-primary" onClick={handleSend} disabled={sending || !inputText.trim()}>
                {sending ? '发送中...' : '发送'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
