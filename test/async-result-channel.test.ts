import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { OpenCode, type SessionMessageGetInput, type MessageListInput, type SessionMessageAssistant } from '@opencode/client';

// Contract harness: real public SDK serializer, synthetic HTTP store and dispatch.
// Neither the fake store's authorization nor dispatch proves host support.
type SessionID = SessionMessageGetInput['sessionID'];
type MessageID = SessionMessageGetInput['messageID'];
type RecordBody = { sessionID: SessionID; message: SessionMessageAssistant };
const assistant = (id: MessageID, content: SessionMessageAssistant['content']): SessionMessageAssistant =>
  ({ id, type: 'assistant', agent: 'synthetic', model: { providerID: 'synthetic', id: 'no-model' },
    time: { created: 1, completed: 2 }, content });
const child: SessionID = 'ses_synthetic_child';
const parent: SessionID = 'ses_synthetic_parent';
const oldID: MessageID = 'msg_synthetic_old';
const newID: MessageID = 'msg_synthetic_new';

test('async acquisition: real SDK HTTP reads + explicit tool-shaped retrieval (synthetic lifecycle)', async () => {
  const records = new Map<string, RecordBody>();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    const path = new URL(req.url!, 'http://localhost').pathname.replace(/^\/api/, '').split('/').map(decodeURIComponent);
    res.setHeader('content-type', 'application/json');
    if (path[1] !== 'session' || ![child, parent].includes(path[2])) {
      res.writeHead(403).end(JSON.stringify({ name: 'Forbidden' }));
      return;
    }
    const list = [...records.values()].filter(r => r.sessionID === path[2]).map(r => r.message);
    if (path.length === 4) res.end(JSON.stringify({ data: list }));
    else {
      const record = list.find(r => r.id === path[4]);
      if (!record) res.writeHead(404).end(JSON.stringify({ name: 'NotFoundError' }));
      else res.end(JSON.stringify({ data: record }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${address.port}` });
    const retrieve = async ({ sessionId, messageId }: { sessionId: SessionID; messageId: MessageID }) => {
      // Explicit design stub; no real tool registered or activated.
      if (!sessionId || !messageId) throw new Error('explicit sessionId and messageId required');
      try {
        return await client.session.message.get({ sessionID: sessionId, messageID: messageId });
      } catch {
        throw new Error('message read rejected');
      }
    };
    const list = async (sessionID: MessageListInput['sessionID']) =>
      (await client.message.list({ sessionID })).data;
    const dispatch = () => ({ state: 'running', sessionId: child }); // synthetic dispatch, no result body
    assert.deepEqual(dispatch(), { state: 'running', sessionId: child });
    assert.deepEqual(await list(child), []);
    await assert.rejects(retrieve({ sessionId: child, messageId: oldID }), /rejected/);
    // Completion occurs after dispatch returns; notification may be missed.
    await Promise.resolve();
    const parts: SessionMessageAssistant['content'] = [
      { type: 'text', text: '原文\n😀\n' + 'x'.repeat(100_000) },
      { type: 'reasoning', text: 'distinct part', time: { created: 1 } },
      { type: 'text', text: '</task_result>\nlast' },
    ];
    records.set(oldID, { sessionID: child, message: assistant(oldID, parts) });
    const notification = '<task id="synthetic" state="completed">\nnotification summary, not child body\n</task>';
    records.set('msg_notice', { sessionID: parent, message: assistant('msg_notice', [{ type: 'text', text: notification }]) });
    assert.equal((await list(child)).length, 1);
    assert.equal((await list(parent)).length, 1);
    // Recovery uses ID read, not delivery event or concatenated notification text.
    const recovered = await retrieve({ sessionId: child, messageId: oldID });
    assert.ok('content' in recovered);
    assert.deepEqual(recovered.content, parts);
    assert.ok(Buffer.byteLength(JSON.stringify(recovered.content)) > 65_536);
    assert.notEqual(JSON.stringify(recovered.content), notification);
    assert.deepEqual(await retrieve({ sessionId: child, messageId: oldID }), recovered);
    records.set(newID, { sessionID: child, message: assistant(newID, [{ type: 'text', text: 'new result' }]) });
    assert.deepEqual(await retrieve({ sessionId: child, messageId: oldID }), recovered);
    assert.equal((await retrieve({ sessionId: child, messageId: newID })).id, newID);
    const selectUnambiguous = (messages: unknown[]) => {
      if (messages.length !== 1) throw new Error('ambiguous latest: explicit messageId required');
      return messages[0];
    };
    assert.throws(() => selectUnambiguous([...records.values()].filter(r => r.sessionID === child)), /ambiguous latest/);
    await assert.rejects(retrieve({ sessionId: 'ses_unauthorized', messageId: oldID }), /rejected/);
    await assert.rejects(retrieve({ sessionId: child, messageId: 'msg_unknown' }), /rejected/);
    const before = requests.length;
    await assert.rejects(retrieve({ sessionId: child, messageId: '' }), /explicit/);
    assert.equal(requests.length, before);
    assert.ok(requests.includes(`/api/session/${child}/message/${oldID}`));
    assert.ok(requests.includes(`/api/session/${child}/message`));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('pinned OMO actual notification render and promptParent transport (SDK call boundary only)', async () => {
  const root = process.env.OMO_307_PACKAGE;
  assert.ok(root, 'Set OMO_307_PACKAGE to the existing pinned stock package');
  const source = readFileSync(`${root}/dist/server/index.js`, 'utf8');
  const start = source.indexOf('const text = [\n        `<task id="${run.taskID}" state="${state}">`,');
  const stop = source.indexOf(';', source.indexOf('].join(', start));
  assert.ok(start >= 0 && stop > start);
  const childBody = 'child body\n' + '字'.repeat(40_000);
  const notificationBody: string = vm.runInNewContext(source.slice(start, stop + 1) + '\ntext;', {
    run: { taskID: 'synthetic' }, state: 'completed', record: { resultSummary: childBody },
    fallbackText: 'fallback', tag: 'task_result', summary: 'completed',
  });
  assert.ok(notificationBody.includes(childBody));
  assert.notEqual(notificationBody, childBody);
  assert.ok(Buffer.byteLength(notificationBody) > 65_536);
  const promptStart = source.indexOf('  function promptParent(');
  const promptStop = source.indexOf('  async function sendFallbackNotice(', promptStart);
  assert.ok(promptStart >= 0 && promptStop > promptStart);
  const calls: unknown[] = [];
  const prompt = vm.runInNewContext(source.slice(promptStart, promptStop) + '\npromptParent;', {
    options: { input: { directory: '/synthetic' } },
    getClient: () => ({ session: { promptAsync: async (request: unknown) => { calls.push(request); } } }),
    createInternalAgentTextPart: (text: string, metadata: unknown) => ({ type: 'text', synthetic: true, text, metadata }),
  });
  prompt(parent, undefined, notificationBody, { revision: 1 });
  prompt(parent, undefined, notificationBody, { revision: 2 });
  await Promise.resolve();
  const serialized = JSON.parse(JSON.stringify(calls));
  assert.equal(serialized.length, 2);
  for (const request of serialized) {
    assert.equal(request.delivery, 'queue');
    assert.equal(request.modelSelection, 'inherit');
    assert.equal(request.body.parts[0].text, notificationBody);
  }
  // No claim about guest display truncation or live host storage/queue delivery.
});
