/**
 * Feature 1: Mailbox FactBus — Direct agent-to-agent messaging.
 * Extends FactBus with point-to-point messages. Supports read/unread tracking.
 */

export type MessageType = 'task' | 'result' | 'feedback' | 'shutdown_request' | 'shutdown_approved';

export interface AgentMessage {
  id: number; runId: string; from: string; to: string;
  content: string; type: MessageType; read: boolean; createdAt: string;
}

export interface MailboxStore {
  sendMessage(runId: string, from: string, to: string, content: string, type: MessageType): number;
  receiveMessages(runId: string, agentId: string): AgentMessage[];
  getUnreadMessages(runId: string, agentId: string): AgentMessage[];
  markRead(messageId: number): void;
  markAllRead(runId: string, agentId: string): void;
  getConversation(runId: string, agent1: string, agent2: string): AgentMessage[];
  close(): void;
}

export class InMemoryMailbox implements MailboxStore {
  private messages: AgentMessage[] = [];
  private nextId = 1;

  sendMessage(runId: string, from: string, to: string, content: string, type: MessageType): number {
    const id = this.nextId++;
    this.messages.push({ id, runId, from, to, content, type, read: false, createdAt: new Date().toISOString() });
    return id;
  }

  receiveMessages(runId: string, agentId: string): AgentMessage[] {
    return this.messages.filter(m => m.runId === runId && m.to === agentId).sort((a, b) => a.id - b.id);
  }

  getUnreadMessages(runId: string, agentId: string): AgentMessage[] {
    return this.messages.filter(m => m.runId === runId && m.to === agentId && !m.read).sort((a, b) => a.id - b.id);
  }

  markRead(messageId: number): void {
    const msg = this.messages.find(m => m.id === messageId);
    if (msg) msg.read = true;
  }

  markAllRead(runId: string, agentId: string): void {
    for (const m of this.messages) { if (m.runId === runId && m.to === agentId) m.read = true; }
  }

  getConversation(runId: string, agent1: string, agent2: string): AgentMessage[] {
    return this.messages.filter(m => m.runId === runId &&
      ((m.from === agent1 && m.to === agent2) || (m.from === agent2 && m.to === agent1)))
      .sort((a, b) => a.id - b.id);
  }

  close(): void { this.messages = []; }
}

export class SQLiteMailbox implements MailboxStore {
  private db: any;
  constructor(db: any) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
        from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, content TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('task','result','feedback','shutdown_request','shutdown_approved')),
        read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_run_to ON messages(run_id, to_agent);
    `);
  }
  sendMessage(runId: string, from: string, to: string, content: string, type: MessageType): number {
    return Number(this.db.prepare('INSERT INTO messages (run_id, from_agent, to_agent, content, type) VALUES (?, ?, ?, ?, ?)').run(runId, from, to, content, type).lastInsertRowid);
  }
  receiveMessages(runId: string, agentId: string): AgentMessage[] {
    return this.db.prepare('SELECT * FROM messages WHERE run_id = ? AND to_agent = ? ORDER BY id ASC').all(runId, agentId).map(this._row);
  }
  getUnreadMessages(runId: string, agentId: string): AgentMessage[] {
    return this.db.prepare('SELECT * FROM messages WHERE run_id = ? AND to_agent = ? AND read = 0 ORDER BY id ASC').all(runId, agentId).map(this._row);
  }
  markRead(messageId: number): void { this.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(messageId); }
  markAllRead(runId: string, agentId: string): void { this.db.prepare('UPDATE messages SET read = 1 WHERE run_id = ? AND to_agent = ?').run(runId, agentId); }
  getConversation(runId: string, a1: string, a2: string): AgentMessage[] {
    return this.db.prepare('SELECT * FROM messages WHERE run_id = ? AND ((from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)) ORDER BY id ASC').all(runId, a1, a2, a2, a1).map(this._row);
  }
  close(): void {}
  private _row(r: any): AgentMessage { return { id: r.id, runId: r.run_id, from: r.from_agent, to: r.to_agent, content: r.content, type: r.type, read: r.read === 1, createdAt: r.created_at }; }
}
