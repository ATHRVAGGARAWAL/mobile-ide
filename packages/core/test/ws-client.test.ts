import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { MideClient } from '../src/ws-client.js';

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onmessage?: (event: { data: string }) => void;
  sent: Record<string, unknown>[] = [];
  constructor() {
    Socket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  // Simulate a network that never completes a close handshake.
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  Socket.instances = [];
  const client = new MideClient({
    baseUrl: 'http://localhost:4820',
    token: 'test',
    clientName: 'test',
    clientVersion: '1',
    WebSocketImpl: Socket as unknown as typeof WebSocket,
    onEvent: () => {},
    pingIntervalMs: 100,
    pongTimeoutMs: 50,
    connectionTimeoutMs: 100,
  });
  t.after(() => client.close());
  client.connect();
  const socket = Socket.instances[0];
  assert.ok(socket);
  return { client, socket };
}

test('missing pong reconnects without waiting for close and restores subscriptions', async (t) => {
  const { client, socket } = setup(t);
  client.subscribe('session-1', 7);
  client.watchSessionList();
  await client.watchDir('/project', 'src');
  socket.open();
  const pending = assert.rejects(client.cancel('session-1'), /connection closed/);
  t.mock.timers.tick(100);
  assert.equal(socket.sent.at(-1)?.type, 'ping');
  t.mock.timers.tick(50);
  assert.equal(client.getState(), 'reconnecting');
  await pending;
  t.mock.timers.tick(750);
  const next = Socket.instances.at(-1);
  assert.ok(next);
  assert.notEqual(next, socket);
  next.open();
  assert.equal(client.getState(), 'open');
  assert.ok(next.sent.some((f) => f.type === 'subscribe' && f.afterSeq === 7));
  assert.ok(next.sent.some((f) => f.type === 'sessions.watch'));
  assert.ok(next.sent.some((f) => f.type === 'fs.watch' && f.dir === 'src'));
  // Delayed events from the retired socket must not tear down its replacement.
  socket.onclose?.({ code: 1006 });
  socket.open();
  assert.equal(client.getState(), 'open');
});

test('pong keeps a healthy socket connected over repeated heartbeat cycles', (t) => {
  const { client, socket } = setup(t);
  socket.open();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(100);
    socket.receive({ type: 'pong', ts: 1 });
    t.mock.timers.tick(50);
    socket.receive({ type: 'pong', ts: 1 });
    assert.equal(client.getState(), 'open');
  }
  assert.equal(Socket.instances.length, 1);
});

test('stalled connection times out and explicit close cancels recovery', (t) => {
  const { client } = setup(t);
  t.mock.timers.tick(100);
  assert.equal(client.getState(), 'reconnecting');
  client.close();
  t.mock.timers.tick(10_000);
  assert.equal(client.getState(), 'closed');
  assert.equal(Socket.instances.length, 1);
});

test('rejected authentication does not retry', (t) => {
  const { client, socket } = setup(t);
  socket.onclose?.({ code: 4401 });
  t.mock.timers.tick(10_000);
  assert.equal(client.getState(), 'closed');
  assert.equal(Socket.instances.length, 1);
});

test('connect is idempotent while opening or reconnecting', (t) => {
  const { client } = setup(t);
  client.connect();
  assert.equal(Socket.instances.length, 1);
  t.mock.timers.tick(100);
  client.connect();
  assert.equal(Socket.instances.length, 1);
});
