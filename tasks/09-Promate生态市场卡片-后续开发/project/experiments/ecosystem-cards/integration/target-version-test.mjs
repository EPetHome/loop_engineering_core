// Minimal logical DOM doubles, not a browser/host selector test and not a DOM framework dependency.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { readTargetVersion, targetVersionExpression, targetVersionEvidenceMatches } from './target-version.mjs';

const target = { pluginName: 'target-card', marketName: 'owned-market', expectedVersion: '1.0.0', scope: 'native-ascii-technical-probe' };
function element(className, text = '', children = []) {
  const node = { className, ownText: text, children, parentElement: null, isConnected: true, hidden: false, attributes: {},
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    rect: { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 },
    getBoundingClientRect() { return this.rect; },
    getAttribute(name) { return this.attributes[name] ?? null; }, hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    matches(selector) { return selector.startsWith('.') && this.className.split(' ').includes(selector.slice(1)); },
    closest(selector) { for (let p = this; p; p = p.parentElement) if (p.matches(selector)) return p; return null; },
    querySelectorAll(selector) {
      const parts = selector.split(' '), found = [];
      const walk = parent => {
        for (const child of parent.children) {
          if (child.matches(parts.at(-1))) {
            let ancestor = child.parentElement, index = parts.length - 2;
            while (index >= 0 && ancestor && ancestor !== this.parentElement) {
              if (ancestor.matches(parts[index])) index--;
              ancestor = ancestor.parentElement;
            }
            if (index < 0) found.push(child);
          }
          walk(child);
        }
      };
      walk(this); return found;
    } };
  Object.defineProperty(node, 'textContent', { get() { return this.ownText + this.children.map(c => c.textContent).join(' '); } });
  for (const child of children) child.parentElement = node;
  return node;
}
function card(name = target.pluginName, version = '1.0.0', market) {
  return element('cb-plugins-card-item', '', [element('cb-plugins-card-name', name),
    ...(version === null ? [] : [element('cb-plugins-card-version', version)]),
    ...(market === undefined ? [] : [element('cb-plugins-card-source-value', market)])]);
}
function detail(version = '1.0.0', name = target.pluginName, market = target.marketName) {
  return element('cb-plugin-detail', '', [element('cb-plugin-detail-title', name),
    element('cb-plugin-detail-source-link', `Plugin Marketplace (${market})`),
    ...(version === null ? [] : [element('cb-plugin-detail-version', version)])]);
}
function fixture(nodes, market = target.marketName) {
  const panel = element('cb-plugins', '', [element('cb-plugins-marketplace-tab--active', '', [element('cb-plugins-marketplace-tab-name', market)]), ...nodes]);
  const body = element('body', 'background version 1.0.0', [panel]);
  const document = { defaultView: { getComputedStyle: e => e.style, innerWidth: 1024, innerHeight: 768 },
    querySelectorAll: selector => body.querySelectorAll(selector) };
  const observe = () => {
    // EXACT serialized function/expression used by integration/index.mjs, not a separate test predicate.
    const result = runInNewContext(targetVersionExpression(target), { document });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), readTargetVersion(document, target));
    return result;
  };
  return { panel, body, observe };
}
const reject = (f, reason) => { const result = f.observe(); assert.equal(result.correct, false); assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, reason); assert.equal(targetVersionEvidenceMatches(result, target), false); return result; };

test('P2-2 wrong target version cannot borrow expected version from another card', () => {
  const result = reject(fixture([card(target.pluginName, '0.9.0'), card('other-card', '1.0.0')]), 'TARGET_VERSION_MISMATCH');
  assert.equal(result.expectedVersion, '1.0.0'); assert.equal(result.actualVersion, '0.9.0');
  assert.equal(result.locator.pluginName, target.pluginName); assert.equal(result.locator.marketName, target.marketName);
  console.log(JSON.stringify({ scope: 'logical DOM double ONLY', versionVerification: result }));
});

test('missing target version cannot borrow from body or another card', () => {
  const result = reject(fixture([card(target.pluginName, null), card('other-card')]), 'TARGET_VERSION_FIELD_MISSING');
  assert.equal(result.actualVersion, null);
});

test('near versions use exact field equality, never substring matching', () => {
  for (const version of ['11.0.0', '1.0.01', 'v1.0.0', '1.0.0-beta', '1.0.0 / 1.0.1']) {
    const result = reject(fixture([card(target.pluginName, version), card('other-card')]), 'TARGET_VERSION_MISMATCH');
    assert.equal(result.actualVersion, version);
  }
});

test('duplicate targets, including a hidden duplicate, never pass', () => {
  for (const hidden of [false, true]) {
    const duplicate = card(); duplicate.hidden = hidden;
    reject(fixture([card(), duplicate]), 'TARGET_CARD_NOT_UNIQUE');
  }
});

test('invisible, offscreen and ancestor-hidden targets never pass', () => {
  for (const mutate of [node => { node.hidden = true; }, node => { node.style.opacity = '0'; },
    node => { node.attributes['aria-hidden'] = 'true'; }, node => { node.rect.width = 0; },
    node => { node.rect.left = 2048; node.rect.right = 2148; }]) {
    const node = card(); mutate(node); reject(fixture([node]), 'TARGET_CARD_NOT_VISIBLE');
  }
  const f = fixture([card()]); f.panel.style.display = 'none'; reject(f, 'TARGET_CARD_NOT_VISIBLE');
});

test('version field itself must be unique and visible', () => {
  const node = card(); node.children[1].style.visibility = 'hidden';
  reject(fixture([node]), 'TARGET_VERSION_FIELD_NOT_VISIBLE');
  const duplicate = element('cb-plugins-card-version', '1.0.0'); duplicate.parentElement = node; node.children.push(duplicate);
  reject(fixture([node]), 'TARGET_VERSION_FIELD_NOT_UNIQUE');
});

test('market context is exact, visible and unique; no cross-market name match', () => {
  reject(fixture([card()], 'another-market'), 'TARGET_CARD_OR_MARKET_MISSING');
  reject(fixture([card(target.pluginName, '1.0.0', 'another-market')]), 'TARGET_CARD_OR_MARKET_MISSING');
  const f = fixture([card()]); f.panel.children[0].hidden = true; reject(f, 'TARGET_CARD_NOT_VISIBLE');
  const second = element('cb-plugins-marketplace-tab--active', '', [element('cb-plugins-marketplace-tab-name', target.marketName)]);
  second.parentElement = f.panel; f.panel.children.push(second); reject(f, 'TARGET_CARD_OR_MARKET_MISSING');
});

test('open detail never falls back to a correct background target card', () => {
  for (const [version, reason] of [['0.9.0', 'TARGET_VERSION_MISMATCH'], [null, 'TARGET_VERSION_FIELD_MISSING']]) {
    reject(fixture([detail(version), card()]), reason);
  }
  const hiddenDetail = detail(); hiddenDetail.hidden = true;
  reject(fixture([hiddenDetail, card()]), 'TARGET_CARD_NOT_VISIBLE');
  reject(fixture([detail('1.0.0', 'other-card'), card()]), 'TARGET_CARD_OR_MARKET_MISSING');
  reject(fixture([detail(), detail(), card()]), 'TARGET_CARD_NOT_UNIQUE');
});

test('unique correct visible card and detail succeed with recorded locator and actual version', () => {
  for (const node of [card(), detail()]) {
    const result = fixture([node, card('other-card')]).observe();
    assert.equal(result.correct, true); assert.equal(result.status, 'PASS'); assert.equal(result.actualVersion, target.expectedVersion);
    assert.equal(result.locator.matchCount, 1); assert.equal(result.locator.visible, true);
    assert.equal(result.scope, 'native-ascii-technical-probe'); assert.equal(targetVersionEvidenceMatches(result, target), true);
  }
});

test('acceptance crosscheck rejects incomplete or contradictory raw version evidence despite PASS flags', () => {
  const correct = fixture([card()]).observe();
  for (const mutate of [raw => { delete raw.locator; }, raw => { raw.actualVersion = '11.0.0'; },
    raw => { raw.expectedVersion = 'wrong'; }, raw => { raw.target.marketName = 'wrong-market'; },
    raw => { raw.candidates.push(raw.candidates[0]); }, raw => { raw.candidates[0].visible = false; },
    raw => { raw.candidates[0].version.count = 0; }, raw => { raw.candidates[0].version.text = '0.9.0'; },
    raw => { raw.locator.versionSelector = 'body'; }, raw => { raw.scope = 'business-complete'; }]) {
    const raw = JSON.parse(JSON.stringify(correct)); mutate(raw); assert.equal(targetVersionEvidenceMatches(raw, target), false);
  }
});

test('missing target does not pass just because background contains the version', () => {
  reject(fixture([card('other-card')]), 'TARGET_CARD_OR_MARKET_MISSING');
});
