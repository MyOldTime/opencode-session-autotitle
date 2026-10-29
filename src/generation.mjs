import { randomUUID } from 'node:crypto';

export const TRANSIENT_SESSION = 'session-autotitle.transient';
const modelKey = ref => JSON.stringify([ref?.providerID, ref?.id,
  ref?.variant === 'default' ? undefined : ref?.variant]);
const abortError = () => new DOMException('Aborted', 'AbortError');
const messageText = message => typeof message?.content === 'string' ? message.content
  : message?.content?.length === 1 && message.content[0].type === 'text' ? message.content[0].text : undefined;

async function cancellable(run, signal) {
  let onAbort;
  try {
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason ?? abortError());
      signal.addEventListener('abort', onAbort, {once: true});
    });
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason ?? abortError();
      return run();
    }), aborted]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

/** Use the host catalog, not a list of model names or a copied provider SDK. */
export async function generationRoute(ctx, model) {
  if (!['opencode', 'opencode-go'].includes(model?.providerID)) return 'detached';
  const { data } = await ctx.model.list();
  const selected = data.find(item => item.providerID === model.providerID && item.id === model.id);
  return selected?.cost?.length && selected.cost.every(tier => tier.input === 0 && tier.output === 0)
    ? 'session' : 'detached';
}

/**
 * Free OpenCode models require the real host session request context. Keep its
 * system/tool definitions and authorization; isolate only the naming messages.
 * session.generate is transient and does not run a tool loop or write messages.
 */
export class NamingGenerator {
  constructor(ctx, { log = () => {} } = {}) {
    this.ctx = ctx;
    this.log = log;
    this.prefix = `opencode-session-autotitle:${randomUUID()}:`;
    this.pending = new Map();
  }

  async start() {
    return this.ctx.session.hook('generate', event => {
      const marker = messageText(event.messages.at(-1));
      if (typeof marker !== 'string' || !marker.startsWith(this.prefix)) return;
      const request = this.pending.get(marker);
      // Reject a late invocation after timeout instead of sending a marker and
      // the full session history to a provider. Other callers are unaffected.
      if (!request || request.signal.aborted || event.sessionID !== request.sessionID) throw abortError();
      if (modelKey(event.model) !== modelKey(request.model)) {
        throw Object.assign(new Error('The session model changed before generation'), {code: 'autotitle_model_changed'});
      }
      event.messages = [{role: 'user', content: [{type: 'text', text: request.prompt}]}];
      request.applied = true;
    });
  }

  async generate({info, model, sessionModel, route, prompt, signal, onDispatch}) {
    const check = () => { if (signal.aborted) throw signal.reason ?? abortError(); };
    check();
    if (route !== 'session') {
      onDispatch();
      return this.ctx.experimental.generate.text({prompt, ...(model ? {model} : {})}, {signal});
    }
    let sessionID = info.id;
    let temporary;
    const marker = `${this.prefix}${randomUUID()}`;
    const invalidate = () => this.pending.delete(marker);
    signal.addEventListener('abort', invalidate, {once: true});
    try {
      // The transient API follows a session's effective model. An explicit
      // different naming model gets its own empty, short-lived child session.
      // Never switch the user's actual session to implement an override.
      if (modelKey(model) !== modelKey(sessionModel)) {
        const child = await this.ctx.session.create({parentID: info.id, model,
          ...(info.agent ? {agent: info.agent} : {}), location: {directory: this.ctx.location.directory},
          title: '自动命名临时请求', metadata: {[TRANSIENT_SESSION]: true},
          ...(info.permissions ? {permissions: info.permissions} : {}),
        });
        temporary = child.id;
        sessionID = temporary;
      }
      check();
      const request = {sessionID, model, prompt, signal, applied: false};
      this.pending.set(marker, request);
      const result = await cancellable(() => {
        onDispatch();
        return this.ctx.session.generate({sessionID, prompt: marker}, {signal});
      }, signal);
      check();
      if (!request.applied) throw new Error('The host did not isolate the naming request');
      return result;
    } finally {
      invalidate();
      signal.removeEventListener('abort', invalidate);
      if (temporary) {
        try { await this.ctx.session.remove({sessionID: temporary}); }
        catch { this.log('generation_cleanup_failed', temporary); }
      }
    }
  }
}
