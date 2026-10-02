import { requireSafe } from '../fs-safety.mjs';

export class DesktopCDP {
  constructor(url, record) {
    const endpoint = new URL(url);
    requireSafe(endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'CDP_NOT_LOOPBACK');
    this.record = record; this.sequence = 0; this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', reject, { once: true }); });
    this.socket.addEventListener('message', ({ data }) => {
      const value = JSON.parse(data); this.record({ time: new Date().toISOString(), direction: 'host', message: value });
      const job = this.pending.get(value.id);
      if (job) { clearTimeout(job.timer); this.pending.delete(value.id); value.error ? job.reject(new Error(JSON.stringify(value.error))) : job.resolve(value.result); }
    });
    this.socket.addEventListener('close', () => { for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('CDP_CLOSED')); } this.pending.clear(); });
  }
  async send(method, params = {}, timeout = 15000) {
    await this.ready;
    const id = ++this.sequence, message = { id, method, params };
    this.record({ time: new Date().toISOString(), direction: 'automation', message });
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP_TIMEOUT:${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify(message)); return promise;
  }
  async evaluate(expression, timeout = 15000) {
    const reply = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
    requireSafe(!reply.exceptionDetails, 'DESKTOP_EVALUATION_REJECTED:' + JSON.stringify(reply.exceptionDetails));
    return reply.result?.value;
  }
  async click(selector) {
    const bounds = await this.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return null;const r=el.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
    requireSafe(bounds, `DESKTOP_CONTROL_NOT_VISIBLE:${selector}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...bounds });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...bounds });
  }
  async clickCard(pluginName, control = null) {
    const bounds = await this.evaluate(`(()=>{const cards=[...document.querySelectorAll('.cb-plugins-card-item')].filter(e=>e.querySelector('.cb-plugins-card-name')?.textContent.trim()===${JSON.stringify(pluginName)});if(cards.length!==1)return null;const e=${control ? `cards[0].querySelector(${JSON.stringify(control)})` : 'cards[0]'};if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
    requireSafe(bounds, `OWNED_CARD_CONTROL_NOT_UNIQUE_OR_VISIBLE:${pluginName}:${control}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...bounds });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...bounds });
  }
  async clickText(text) {
    const point = await this.evaluate(`(()=>{const nodes=[...document.querySelectorAll('button,[role="button"],a,span,div')].filter(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width&&e.getBoundingClientRect().height);nodes.sort((a,b)=>a.children.length-b.children.length);const r=nodes[0]?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
    requireSafe(point, `DESKTOP_TEXT_NOT_VISIBLE:${text}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  close() { this.socket.close(); }
}
