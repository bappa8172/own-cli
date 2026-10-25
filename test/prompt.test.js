import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT, workspacePrompt, buildUserMessage, trimConversation } from '../src/prompt.js';

const user = (content) => ({ role: 'user', content });
const assistant = (content) => ({ role: 'assistant', content });

test('prompt states actual capabilities and evidence limits', () => {
  assert.match(SYSTEM_PROMPT, /actual project files with tools/);
  assert.match(SYSTEM_PROMPT, /Never claim/);
  assert.match(SYSTEM_PROMPT, /untrusted reference/);
  assert.equal(buildUserMessage('  explain  '), 'explain');
  assert.match(buildUserMessage('explain', 'file snapshot'), /<repository_context>\nfile snapshot\n<\/repository_context>/);
});

test('workspace prompt accurately describes the active permissions', () => {
  assert.match(workspacePrompt({ root: 'project', permissions: 'read-only' }), /no write or command tools/);
  assert.match(workspacePrompt({ root: 'project', permissions: 'workspace' }), /file\/folder editing is enabled/);
  assert.match(workspacePrompt({ root: 'project', permissions: 'all' }), /command execution are enabled/);
});

test('conversation drops whole oldest turns and never starts with an orphan assistant', () => {
  const history = [user('one'), assistant('two'), user('three'), assistant('four'), user('five')];
  assert.deepEqual(trimConversation(history, { maxMessages: 4 }), history.slice(2));
  assert.deepEqual(trimConversation([assistant('orphan'), user('valid')]), [user('valid')]);
  assert.deepEqual(trimConversation(history, { maxChars: 10 }), [user('five')]);
  assert.equal(history.length, 5);
});

test('an oversized pending prompt is rejected rather than silently losing the request', () => {
  assert.throws(() => trimConversation([user('x'.repeat(20))], { maxChars: 10 }), /exceeds/);
  assert.throws(() => trimConversation([], { maxMessages: 0 }), /positive/);
});

test('conversation limits stay bounded across a long session', () => {
  let history = [];
  for (let turn = 0; turn < 1000; turn += 1) {
    history = trimConversation([...history, user(`question ${turn}`), assistant('answer'.repeat(100))]);
    assert.ok(history.length <= 12);
    assert.equal(history[0].role, 'user');
    assert.ok(history.reduce((count, message) => count + message.content.length, 0) <= 48000);
  }
});
