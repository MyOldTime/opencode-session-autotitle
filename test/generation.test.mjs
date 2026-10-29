import test from 'node:test';
import assert from 'node:assert/strict';
import { NamingGenerator, generationRoute, TRANSIENT_SESSION } from '../src/generation.mjs';

const free = {providerID: 'opencode', id: 'a-new-free-model', variant: 'default'};
const paid = {providerID: 'custom', id: 'my-model', variant: 'high'};
const input = (extra = {}) => ({info: {id: 'ses_user', agent: 'build'}, model: free, sessionModel: free,
  route: 'session', prompt: 'Only the bounded naming input', signal: new AbortController().signal,
  onDispatch: () => {}, ...extra});

async function harness() {
  let hook;
  const calls = [], created = [], removed = [], events = [];
  let generate;
  const ctx = {location: {directory: process.cwd()},
    session: {
      hook: async (kind, fn) => {assert.equal(kind, 'generate');hook = fn;return {dispose: async () => {}};},
      create: async value => {created.push(value);return {id: 'ses_host_created'};},
      remove: async ({sessionID}) => {removed.push(sessionID);},
      generate: async (value, options) => {
        calls.push({value, options});
        const event = {sessionID: value.sessionID, model: free,
          system: [{type: 'text', text: 'REAL_HOST_SYSTEM'}], tools: {read: {description: 'HOST_TOOL'}},
          messages: [{role: 'assistant', content: [{type: 'text', text: 'PRIVATE_HISTORY'}]},
            {role: 'user', content: [{type: 'text', text: value.prompt}]}]};
        events.push(event);
        return generate(event, options);
      },
    },
    experimental: {generate: {text: async (value, options) => {calls.push({value, options});return {text: 'detached'};}}},
  };
  generate = async event => {await hook(event);return {text: 'session'};};
  const adapter = new NamingGenerator(ctx);await adapter.start();
  return {adapter, ctx, calls, created, removed, events, hook: event => hook(event),
    setGenerate: fn => {generate = fn;}};
}

test('route uses host price metadata for all built-in free models, never model-name guesses', async () => {
  const catalog = [
    {...free, cost: [{input: 0, output: 0}]},
    {providerID: 'opencode-go', id: 'another', cost: [{input: 0, output: 0}]},
    {providerID: 'opencode', id: 'sounds-free', cost: [{input: 0, output: 2}]},
    {providerID: 'opencode', id: 'tiered', cost: [{input: 0, output: 0}, {input: 1, output: 1}]},
    {providerID: 'opencode', id: 'unknown-price', cost: []},
  ];
  const ctx = {model: {list: async () => ({data: catalog})}};
  for (const model of catalog) assert.equal(await generationRoute(ctx, model),
    ['a-new-free-model', 'another'].includes(model.id) ? 'session' : 'detached');
  assert.equal(await generationRoute(ctx, {providerID: 'opencode', id: 'missing'}), 'detached');
  assert.equal(await generationRoute({}, paid), 'detached');
  assert.equal(await generationRoute({}, undefined), 'detached');
});

test('session route preserves real host system/tools and isolates history to the naming prompt', async () => {
  const h = await harness();let dispatched = 0;
  h.setGenerate(async event => {
    const system = event.system, tools = event.tools;
    await h.hook(event);
    assert.equal(event.system, system);assert.equal(event.tools, tools);
    assert.deepEqual(event.messages, [{role: 'user', content: [{type: 'text', text: input().prompt}]}]);
    return {text: 'safe result'};
  });
  assert.deepEqual(await h.adapter.generate(input({onDispatch: () => dispatched++})), {text: 'safe result'});
  assert.equal(dispatched, 1);assert.equal(h.created.length, 0);assert.equal(h.removed.length, 0);
  assert.equal(h.adapter.pending.size, 0);assert.notEqual(h.calls[0].value.prompt, input().prompt);
});

test('detached route retains the exact model/variant and authenticated host API', async () => {
  const h = await harness();const request = input({model: paid, route: 'detached'});
  assert.deepEqual(await h.adapter.generate(request), {text: 'detached'});
  assert.deepEqual(h.calls[0].value, {model: paid, prompt: request.prompt});
  assert.equal(h.calls[0].options.signal, request.signal);assert.equal(h.created.length, 0);
});

test('default and omitted variants use the original session, not a temporary override', async () => {
  const h = await harness();
  await h.adapter.generate(input({sessionModel: {providerID: free.providerID, id: free.id}}));
  assert.equal(h.created.length, 0);
});

test('a different explicit free model uses an empty child and removes it on success or failure', async () => {
  for (const fail of [false, true]) {
    const h = await harness();
    if (fail) h.setGenerate(async event => {await h.hook(event);throw new Error('provider failed');});
    const work = h.adapter.generate(input({sessionModel: paid}));
    if (fail) await assert.rejects(work, /provider failed/);else await work;
    assert.equal(h.created.length, 1);const child = h.created[0];
    assert.equal(child.parentID, 'ses_user');assert.deepEqual(child.model, free);
    assert.deepEqual(child.metadata, {[TRANSIENT_SESSION]: true});
    assert.equal(child.id, undefined, 'the host must allocate its native session ID');
    assert.equal(h.calls[0].value.sessionID, 'ses_host_created');assert.deepEqual(h.removed, ['ses_host_created']);
    assert.equal(h.adapter.pending.size, 0);
  }
});

test('concurrent same-session requests and other callers never mix their naming inputs', async () => {
  const h = await harness();const gates = [];
  h.setGenerate(event => new Promise(resolve => {gates.push(async () => {await h.hook(event);resolve({text: event.messages[0].content[0].text});});}));
  const first = h.adapter.generate(input({prompt: 'first'}));const second = h.adapter.generate(input({prompt: 'second'}));
  await new Promise(resolve => setImmediate(resolve));
  const other = {sessionID: 'ses_user', messages: [{role: 'user', content: 'another caller'}]};
  const before = structuredClone(other);await h.hook(other);assert.deepEqual(other, before);
  await gates[1]();await gates[0]();assert.deepEqual(await Promise.all([first, second]), [{text: 'first'}, {text: 'second'}]);
  assert.notEqual(h.calls[0].value.prompt, h.calls[1].value.prompt);
});

test('aborting an uncooperative request removes its temporary session and rejects its late hook', async () => {
  const h = await harness();let late;
  h.setGenerate(event => {late = event;return new Promise(() => {});});
  const abort = new AbortController();const work = h.adapter.generate(input({sessionModel: paid, signal: abort.signal}));
  await new Promise(resolve => setImmediate(resolve));abort.abort();
  await assert.rejects(work, {name: 'AbortError'});
  assert.equal(h.adapter.pending.size, 0);assert.deepEqual(h.removed, ['ses_host_created']);
  await assert.rejects(async () => h.hook(late), {name: 'AbortError'});
});

test('cancellation while creating a helper never dispatches generation and cleans up after creation', async () => {
  const h = await harness();let finish;const abort = new AbortController();let dispatched = 0;
  h.ctx.session.create = value => {h.created.push(value);return new Promise(resolve => {finish = () => resolve({id: 'ses_host_created'});});};
  const work = h.adapter.generate(input({sessionModel: paid, signal: abort.signal, onDispatch: () => dispatched++}));
  abort.abort();finish();await assert.rejects(work, {name: 'AbortError'});
  assert.equal(dispatched, 0);assert.deepEqual(h.removed, ['ses_host_created']);
});

test('model or session mismatch is rejected before a generated result can be accepted', async () => {
  for (const field of ['model', 'sessionID']) {
    const h = await harness();h.setGenerate(async event => {
      event[field] = field === 'model' ? paid : 'ses_other';await h.hook(event);return {text: 'wrong'};
    });
    await assert.rejects(h.adapter.generate(input()), field === 'model' ? {code: 'autotitle_model_changed'} : {name: 'AbortError'});
    assert.equal(h.adapter.pending.size, 0);
  }
});
