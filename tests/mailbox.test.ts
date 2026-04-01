
import { describe, test, expect, beforeEach } from 'bun:test';
import { InMemoryMailbox } from '../src/facts/mailbox.js';
import type { MessageType } from '../src/facts/mailbox.js';

describe('Mailbox FactBus', () => {
  let mb: InMemoryMailbox;
  beforeEach(() => { mb = new InMemoryMailbox(); });

  test('sendMessage returns incrementing ids', () => {
    const a = mb.sendMessage('r1', 'lead', 'w1', 'A', 'task');
    const b = mb.sendMessage('r1', 'lead', 'w2', 'B', 'task');
    expect(b).toBe(a + 1);
  });
  test('receiveMessages filters by agent', () => {
    mb.sendMessage('r1', 'lead', 'w1', 'A', 'task');
    mb.sendMessage('r1', 'lead', 'w2', 'B', 'task');
    expect(mb.receiveMessages('r1', 'w1')).toHaveLength(1);
  });
  test('unread tracking', () => {
    const id = mb.sendMessage('r1', 'lead', 'w1', 'A', 'task');
    mb.sendMessage('r1', 'lead', 'w1', 'B', 'task');
    mb.markRead(id);
    expect(mb.getUnreadMessages('r1', 'w1')).toHaveLength(1);
  });
  test('markAllRead', () => {
    mb.sendMessage('r1', 'lead', 'w1', 'A', 'task');
    mb.sendMessage('r1', 'lead', 'w1', 'B', 'task');
    mb.markAllRead('r1', 'w1');
    expect(mb.getUnreadMessages('r1', 'w1')).toHaveLength(0);
  });
  test('ordering', () => {
    mb.sendMessage('r1', 'a', 'b', '1', 'task');
    mb.sendMessage('r1', 'a', 'b', '2', 'task');
    mb.sendMessage('r1', 'a', 'b', '3', 'task');
    expect(mb.receiveMessages('r1', 'b').map(m => m.content)).toEqual(['1', '2', '3']);
  });
  test('shutdown protocol', () => {
    mb.sendMessage('r1', 'lead', 'w1', 'shutdown', 'shutdown_request');
    mb.sendMessage('r1', 'w1', 'lead', 'ok', 'shutdown_approved');
    expect(mb.receiveMessages('r1', 'lead')[0].type).toBe('shutdown_approved');
  });
  test('conversation', () => {
    mb.sendMessage('r1', 'a', 'b', '1', 'task');
    mb.sendMessage('r1', 'b', 'a', '2', 'result');
    expect(mb.getConversation('r1', 'a', 'b')).toHaveLength(2);
  });
  test('run scoping', () => {
    mb.sendMessage('r1', 'a', 'b', 'x', 'task');
    mb.sendMessage('r2', 'a', 'b', 'y', 'task');
    expect(mb.receiveMessages('r1', 'b')).toHaveLength(1);
  });
  test('all types', () => {
    const types: MessageType[] = ['task', 'result', 'feedback', 'shutdown_request', 'shutdown_approved'];
    for (const t of types) mb.sendMessage('r1', 'a', 'b', t, t);
    expect(mb.receiveMessages('r1', 'b')).toHaveLength(5);
  });
});
