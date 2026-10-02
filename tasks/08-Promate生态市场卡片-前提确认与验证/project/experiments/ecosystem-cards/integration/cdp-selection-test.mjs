// Selection logic fixtures only. No renderer, desktop, host RPC or installation is simulated as success.
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { DesktopCDP } from './cdp.mjs';
let checks = 0;
const bounds = { x: 30, y: 40, width: 20, height: 10 };
function card(name, disabled = false, rectangle = bounds) {
  const control = { disabled, getAttribute: () => null, getBoundingClientRect: () => rectangle };
  const title = { ...control, textContent: name };
  return { querySelector: selector => selector === '.cb-plugins-card-name' ? title : control,
    getAttribute: () => null, getBoundingClientRect: () => rectangle };
}
const target = 'owned-card';
for (const [cards, expected] of [
  [[card('other-card'), card(target)], true],
  [[card(target), card(target)], false],
  [[card('other-card')], false],
  [[card(target, true)], false],
  [[card(target, false, { ...bounds, width: 0 })], false],
]) {
  const client = Object.create(DesktopCDP.prototype), events = [];
  client.evaluate = expression => runInNewContext(expression, { document: { querySelectorAll: () => cards } });
  client.send = async (method, params) => events.push({ method, params });
  if (expected) {
    await client.clickCard(target, '.cb-plugins-card-install-btn');
    assert.equal(events.length, 2); assert.equal(events[0].params.x, 40); assert.equal(events[0].params.y, 45);
  } else { await assert.rejects(client.clickCard(target, '.cb-plugins-card-install-btn')); assert.equal(events.length, 0); }
  checks++;
}
const client = Object.create(DesktopCDP.prototype), events = [];
client.evaluate = expression => runInNewContext(expression, { document: { querySelectorAll: () => [card(target)] } });
client.send = async (method, params) => events.push({ method, params });
await client.clickCard(target, '.cb-plugins-card-name'); assert.equal(events.length, 2); checks++;
console.log(JSON.stringify({ status: 'PASS', checks, scope: 'logical card targeting only; not desktop operation evidence' }));
