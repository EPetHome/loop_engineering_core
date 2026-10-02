// Read-only DOM observation, serialized unchanged into the real CDP evaluation.
// 5.6.2 source confirms the root/title/source/tab selectors, but renders NO version field.
// Explicit version-field selectors below are an unverified field contract: absence MUST fail;
// neither native/disk versions nor descriptions/body text may supply the missing UI value.
export function readTargetVersion(document, { pluginName, marketName, expectedVersion, scope }) {
  const result = { scope, target: { pluginName, marketName }, expectedVersion, actualVersion: null,
    status: 'FAIL', correct: false, reason: null, locator: null, candidates: [],
    versionFieldBasis: 'explicit-field-contract; not rendered by inspected WorkBuddy 5.6.2 components' };
  const fail = reason => ({ ...result, reason });
  if (typeof pluginName !== 'string' || !pluginName || typeof marketName !== 'string' || !marketName
    || typeof expectedVersion !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expectedVersion)) return fail('TARGET_VERSION_EXPECTATION_INVALID');
  const view = document.defaultView;
  const visible = element => {
    if (!element || !element.isConnected) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = view.getComputedStyle(node);
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0') return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
      && rect.left < view.innerWidth && rect.top < view.innerHeight;
  };
  const field = (root, selector) => {
    const elements = [...(root?.querySelectorAll(selector) || [])];
    return { selector, count: elements.length, text: elements.length === 1 ? elements[0].textContent.trim() : null,
      visible: elements.length === 1 && visible(elements[0]) };
  };
  // An open (even hidden/wrong) detail must never borrow a background card's version.
  const details = [...document.querySelectorAll('.cb-plugin-detail')], kind = details.length ? 'detail' : 'card';
  const rootSelector = kind === 'detail' ? '.cb-plugin-detail' : '.cb-plugins-card-item';
  const titleSelector = kind === 'detail' ? '.cb-plugin-detail-title' : '.cb-plugins-card-name';
  const versionSelector = kind === 'detail' ? '.cb-plugin-detail-version' : '.cb-plugins-card-version';
  const roots = kind === 'detail' ? details : [...document.querySelectorAll(rootSelector)];
  result.candidates = roots.map((root, index) => {
    const title = field(root, titleSelector);
    let market;
    if (kind === 'detail') {
      market = field(root, '.cb-plugin-detail-source-link');
      // Host source renders localized label + " (" + marketplaceName + ")".
      market.name = market.text?.match(/^[^()]+ \(([^()]+)\)$/)?.[1] ?? null;
    } else {
      market = field(root, '.cb-plugins-card-source-value');
      if (market.count === 0) market = field(root.closest('.cb-plugins'), '.cb-plugins-marketplace-tab--active .cb-plugins-marketplace-tab-name');
      market.name = market.text;
    }
    return { kind, index, rootSelector, title, market, version: field(root, versionSelector), visible: visible(root) };
  });
  const matching = result.candidates.filter(candidate => candidate.title.count === 1
    && candidate.title.text === pluginName && candidate.market.count === 1 && candidate.market.name === marketName);
  if (matching.length !== 1) return fail(matching.length ? 'TARGET_CARD_NOT_UNIQUE' : 'TARGET_CARD_OR_MARKET_MISSING');
  const selected = matching[0];
  result.locator = { kind, index: selected.index, rootSelector, titleSelector, marketSelector: selected.market.selector,
    versionSelector, pluginName: selected.title.text, marketName: selected.market.name, marketText: selected.market.text,
    matchCount: matching.length, visible: selected.visible && selected.title.visible && selected.market.visible };
  result.actualVersion = selected.version.text;
  if (!result.locator.visible) return fail('TARGET_CARD_NOT_VISIBLE');
  if (selected.version.count !== 1) return fail(selected.version.count ? 'TARGET_VERSION_FIELD_NOT_UNIQUE' : 'TARGET_VERSION_FIELD_MISSING');
  if (!selected.version.visible) return fail('TARGET_VERSION_FIELD_NOT_VISIBLE');
  if (result.actualVersion !== expectedVersion) return fail('TARGET_VERSION_MISMATCH');
  return { ...result, status: 'PASS', correct: true, reason: 'UNIQUE_VISIBLE_TARGET_VERSION_EXACT' };
}
export function targetVersionExpression(target) {
  return `(${readTargetVersion.toString()})(document,${JSON.stringify(target)})`;
}
// Acceptance rechecks the raw locating/field evidence, not only a reported PASS boolean.
export function targetVersionEvidenceMatches(observation, target) {
  if (observation?.status !== 'PASS' || observation.correct !== true || observation.scope !== target.scope
    || observation.target?.pluginName !== target.pluginName || observation.target?.marketName !== target.marketName
    || observation.expectedVersion !== target.expectedVersion || observation.actualVersion !== target.expectedVersion
    || observation.reason !== 'UNIQUE_VISIBLE_TARGET_VERSION_EXACT' || !Array.isArray(observation.candidates)) return false;
  const locator = observation.locator, matches = observation.candidates.filter(candidate => candidate?.title?.count === 1
    && candidate.title.text === target.pluginName && candidate.market?.count === 1 && candidate.market.name === target.marketName);
  if (!locator || matches.length !== 1 || locator.matchCount !== 1 || locator.visible !== true
    || locator.pluginName !== target.pluginName || locator.marketName !== target.marketName) return false;
  const selected = matches[0], kind = locator.kind;
  if (!['card', 'detail'].includes(kind) || selected.kind !== kind || selected.index !== locator.index
    || observation.candidates.some(candidate => candidate.kind !== kind)) return false;
  const rootSelector = kind === 'detail' ? '.cb-plugin-detail' : '.cb-plugins-card-item';
  const titleSelector = kind === 'detail' ? '.cb-plugin-detail-title' : '.cb-plugins-card-name';
  const versionSelector = kind === 'detail' ? '.cb-plugin-detail-version' : '.cb-plugins-card-version';
  const marketSelectors = kind === 'detail' ? ['.cb-plugin-detail-source-link']
    : ['.cb-plugins-card-source-value', '.cb-plugins-marketplace-tab--active .cb-plugins-marketplace-tab-name'];
  const marketName = kind === 'detail' ? selected.market.text?.match(/^[^()]+ \(([^()]+)\)$/)?.[1] : selected.market.text;
  return marketSelectors.includes(locator.marketSelector) && marketName === target.marketName && locator.rootSelector === rootSelector && selected.rootSelector === rootSelector && locator.titleSelector === titleSelector
    && selected.title.selector === titleSelector && locator.versionSelector === versionSelector && selected.version?.selector === versionSelector
    && locator.marketSelector === selected.market.selector && locator.marketText === selected.market.text
    && selected.visible === true && selected.title.visible === true && selected.market.visible === true
    && selected.version.count === 1 && selected.version.visible === true && selected.version.text === target.expectedVersion;
}
