'use strict';

/* ============================================================================
 * 关键词高亮 content script — CSS Custom Highlight API 版本
 * ----------------------------------------------------------------------------
 * 核心变化：不再用 DOM 操作（replaceChild 插入 <span class="hl-lens-mark">）
 * 来实现高亮，而是用浏览器原生的 CSS Custom Highlight API（Chrome 105+）：
 *
 *   1. 用 Range 标记要高亮的文字范围
 *   2. 把 Range 塞进一个 Highlight 对象里，注册到 CSS.highlights
 *   3. 用 CSS 里的 ::highlight(name) 规则控制样式
 *
 * 全程不修改页面 DOM 结构，因此：
 *   - 不会和 React / Vue 的虚拟 DOM diff、虚拟列表节点复用发生冲突
 *     （之前反馈的"把没有高亮的词汇替换成高亮词汇"就是这一类问题）
 *   - 不会污染 CKEditor / TinyMCE / Quill / Slate / ProseMirror /
 *     Draft.js / Lexical 等任何富文本编辑器的内部数据模型
 *     （不止 CKEditor，理论上所有基于 contenteditable 的编辑器都受益）
 *   - 不再需要"暂停/恢复 MutationObserver"这类防自触发的补丁逻辑
 *
 * 对不支持该 API 的旧版浏览器（Chrome < 105），会自动回退到原来的
 * DOM span 插入方案（本文件底部的 *Legacy 系列函数），行为和老版本一致，
 * 但仍然保留了本次一起修复的两个小 bug：
 *   - 关键词颜色只在"当前分组已启用的关键词"里查找，不再跨分组误配色
 *   - 支持"整词匹配"开关（见 wholeWordOnly），避免短关键词被其他词"卷入"
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
let keywords = [];
let groups = [];
let currentGroupId = 'default';
let ignoreAccents = false;
let wholeWordOnly = false; // 新增设置项，默认 false 保持和旧版本一致的行为
let keywordsRegex = null;
let activeKeywordList = []; // 当前分组下已启用的关键词（已按长度降序排序）

const SUPPORTS_CUSTOM_HIGHLIGHT =
  typeof Highlight === 'function' && !!(window.CSS && CSS.highlights);

if (typeof console !== 'undefined' && console.debug) {
  console.debug(
    '[HighlightLens] 高亮引擎:',
    SUPPORTS_CUSTOM_HIGHLIGHT ? 'CSS Custom Highlight API（不修改DOM）' : '传统 DOM span 方案（回退模式）'
  );
}

const ACCENT_MAP = {
  'a': '[aàáâäæãåāAÀÁÂÄÆÃÅĀ]',
  'c': '[cçćčCÇĆČ]',
  'e': '[eéèêëēėęEÉÈÊËĒĖĘ]',
  'i': '[iîïíīįìIÎÏÍĪĮÌ]',
  'l': '[lłLŁ]',
  'n': '[nñńNÑŃ]',
  'o': '[oôöòóœøōõOÔÖÒÓŒØŌÕ]',
  'r': '[rŕřRŔŘ]',
  's': '[sśšşSŚŠŞ]',
  't': '[tțťTȚŤ]',
  'u': '[uûüùúūUÛÜÙÚŪ]',
  'y': '[yÿýYŸÝ]',
  'z': '[zžźżZŽŹŻ]'
};

function normalizeText(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function textToAccentRegexPattern(text) {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let pattern = '';
  for (const char of normalized) {
    const lower = char.toLowerCase();
    if (ACCENT_MAP[lower]) {
      pattern += ACCENT_MAP[lower] + '[\\u0300-\\u036f]*';
    } else {
      pattern += escapeRegExp(char) + '[\\u0300-\\u036f]*';
    }
  }
  return pattern;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 整词匹配（可选）：中文没有空格分词边界，用 Intl.Segmenter 做分词判断；
// 不支持 Intl.Segmenter 的环境下，退化为"只对拉丁字母/数字做 \b 风格判断，
// 中日韩文字维持原有子串匹配行为"。
// ---------------------------------------------------------------------------
let wordSegmenter = null;
try {
  wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
} catch (e) {
  wordSegmenter = null;
}

// 按文本内容缓存一次分词结果，避免同一个文本节点里多次匹配时重复分词
const segmentCache = new WeakMap();

function getSegmentsForText(text) {
  // 用文本内容本身做 key 不方便（字符串不能当 WeakMap key），这里改成每次现算，
  // 因为一个文本节点的 matches 通常复用同一次 findMatches 调用内的结果，
  // 见 findMatches() 内部只分词一次。
  return Array.from(wordSegmenter.segment(text));
}

function isWholeWordMatch(text, start, end, cachedSegments) {
  if (!wholeWordOnly) return true;

  if (!wordSegmenter) {
    // 退化方案：只处理拉丁字母/数字/下划线类文本，CJK 文本维持子串匹配（旧行为）
    const wordCharRe = /[\p{L}\p{N}_]/u;
    const before = start > 0 ? text[start - 1] : '';
    const charAtStart = text[start];
    const after = end < text.length ? text[end] : '';
    const charBeforeEnd = text[end - 1];
    if (wordCharRe.test(before) && wordCharRe.test(charAtStart)) return false;
    if (wordCharRe.test(after) && wordCharRe.test(charBeforeEnd)) return false;
    return true;
  }

  const segments = cachedSegments || getSegmentsForText(text);
  const seg = segments.find(s => s.index <= start && start < s.index + s.segment.length);
  if (!seg) return false;
  // 必须恰好覆盖一个完整的分词片段（起点、终点都对齐）
  return seg.index === start && seg.index + seg.segment.length === end;
}

// ---------------------------------------------------------------------------
// 关键词加载 / 变更
// ---------------------------------------------------------------------------
chrome.storage.local.get(
  {
    keywords: [],
    groups: [{ id: 'default', name: 'Default' }],
    currentGroupId: 'default',
    ignoreAccents: false,
    wholeWordOnly: false
  },
  (result) => {
    groups = result.groups;
    currentGroupId = result.currentGroupId;
    ignoreAccents = result.ignoreAccents || false;
    wholeWordOnly = result.wholeWordOnly || false;
    updateKeywords(result.keywords);
    start();
  }
);

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (isEditorDocument()) return;
  if (namespace !== 'local') return;

  let shouldUpdate = false;

  if (changes.keywords) {
    keywords = changes.keywords.newValue || [];
    shouldUpdate = true;
  }
  if (changes.currentGroupId) {
    currentGroupId = changes.currentGroupId.newValue;
    shouldUpdate = true;
  }
  if (changes.ignoreAccents !== undefined) {
    ignoreAccents = changes.ignoreAccents.newValue || false;
    shouldUpdate = true;
  }
  if (changes.wholeWordOnly !== undefined) {
    wholeWordOnly = changes.wholeWordOnly.newValue || false;
    shouldUpdate = true;
  }

  if (shouldUpdate) {
    clearPendingQueue();
    updateKeywords(keywords);
    refreshHighlighting();
  }
});

/**
 * 更新关键词列表并预编译正则表达式。
 * 修复点：kwConfig 查找现在只在"当前分组 + 已启用"的关键词里进行，
 * 不会再因为跨分组同名关键词而配错颜色。
 */
function updateKeywords(allKeywords) {
  keywords = allKeywords;

  activeKeywordList = keywords.filter(
    k => k.groupId === currentGroupId && k.enabled !== false
  );

  if (activeKeywordList.length === 0) {
    keywordsRegex = null;
    return;
  }

  // 按长度降序排序，保证更长的关键词优先匹配
  activeKeywordList = [...activeKeywordList].sort((a, b) => b.text.length - a.text.length);

  const patterns = activeKeywordList.map(k =>
    ignoreAccents ? textToAccentRegexPattern(k.text) : escapeRegExp(k.text)
  );

  keywordsRegex = new RegExp(`(${patterns.join('|')})`, 'gi');
}

function findKeywordConfig(matchedText) {
  return activeKeywordList.find(k => {
    if (ignoreAccents) return normalizeText(k.text) === normalizeText(matchedText);
    return k.text.toLowerCase() === matchedText.toLowerCase();
  });
}

/**
 * 在一段文本里找出所有关键词匹配，附带整词校验和颜色配置。
 * modern / legacy 两套渲染逻辑共用这一个函数，保证行为一致。
 */
function findMatches(text) {
  if (!keywordsRegex) return [];

  keywordsRegex.lastIndex = 0;
  const cachedSegments = wholeWordOnly && wordSegmenter ? getSegmentsForText(text) : null;

  const results = [];
  let match;
  while ((match = keywordsRegex.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    if (isWholeWordMatch(text, start, end, cachedSegments)) {
      results.push({
        start,
        end,
        text: match[0],
        kwConfig: findKeywordConfig(match[0])
      });
    }

    // 防止零宽匹配导致死循环
    if (keywordsRegex.lastIndex === start) {
      keywordsRegex.lastIndex = start + 1;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 编辑器 / 可编辑区域 检测
// 注：在新的 Custom Highlight 方案里，这些排除逻辑不再是"防止把编辑器搞坏"
// 所必需的（因为我们根本不碰 DOM 结构了），纯粹是一个产品层面的选择——
// 默认不在用户正在输入的区域里显示高亮背景，避免干扰编辑体验。
// 如果你希望在编辑器内也显示高亮，可以放宽这里的判断，现在这样做是安全的。
// ---------------------------------------------------------------------------
function isEditorDocument() {
  try {
    if (document.designMode && document.designMode.toLowerCase() === 'on') {
      return true;
    }

    if (window !== window.top) {
      if (document.body) {
        if (document.body.isContentEditable || document.body.contentEditable === 'true') {
          return true;
        }
        const bodyClass = (document.body.className || '').toLowerCase();
        const bodyId = (document.body.id || '').toLowerCase();
        if (
          bodyClass.includes('cke_') ||
          bodyClass.includes('ck-') ||
          bodyClass.includes('mce') ||
          bodyClass.includes('editor') ||
          bodyId.includes('tinymce') ||
          bodyId.includes('editor')
        ) {
          return true;
        }
      }

      if (window.frameElement) {
        const frameClass = (window.frameElement.className || '').toLowerCase();
        const frameId = (window.frameElement.id || '').toLowerCase();
        const frameName = (window.frameElement.name || '').toLowerCase();
        if (
          frameClass.includes('cke_') ||
          frameClass.includes('cke-') ||
          frameClass.includes('ck-') ||
          frameClass.includes('editor') ||
          frameClass.includes('tox') ||
          frameClass.includes('mce') ||
          frameId.includes('cke_') ||
          frameName.includes('cke_')
        ) {
          return true;
        }
      }
    }

    if (document.body) {
      const bodyClass = (document.body.className || '').toLowerCase();
      if (bodyClass.includes('cke_editable') || bodyClass.includes('mce-content-body')) {
        return true;
      }
    }
  } catch (e) {
    // 跨域限制，忽略
  }
  return false;
}

const IGNORED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  'OPTGROUP', 'NOSCRIPT', 'TEMPLATE', 'CANVAS', 'VIDEO', 'AUDIO',
  'IFRAME', 'EMBED', 'OBJECT'
]);

/**
 * CSS selectors matching rich text editors, WYSIWYG editors, and editable components.
 * 覆盖 CKEditor / TinyMCE / Quill / Slate / Draft.js / ProseMirror / Lexical(通过
 * contenteditable 通用规则) / Monaco / CodeMirror / Ace 等常见编辑器容器。
 */
const EDITOR_SELECTORS = [
  '[contenteditable]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
  '.cke', '.cke_editable', '.cke_contents', '.cke_inner', '.cke_editor',
  '.cke_wysiwyg_frame', '.cke_wysiwyg_div', '[id^="cke_"]',
  '.ck', '.ck-editor', '.ck-editor__editable', '.ck-editor__main',
  '.ck-blurred', '.ck-focused', '[data-cke-editable]',
  '.tox', '.tox-tinymce', '.tox-edit-area', '.mce-content-body', '#tinymce',
  '.ql-container', '.ql-editor',
  '[data-slate-editor]', '[data-slate-node]',
  '.DraftEditor-root', '.public-DraftEditor-content',
  '.ProseMirror',
  '.monaco-editor', '.CodeMirror', '.ace_editor',
  '.note-editor', '.note-editable', '.w-e-text-container',
  '.edui-editor', '.edui-body-container', '.fr-box', '.fr-element',
  '[role="textbox"]', '[role="combobox"]'
].join(',');

function isElementHighlightable(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

  if (document.designMode && document.designMode.toLowerCase() === 'on') return false;

  const tagName = el.tagName ? el.tagName.toUpperCase() : '';
  if (IGNORED_TAGS.has(tagName)) return false;

  // 传统方案会插入这个 class，新方案里理论上不会再出现，留着做兼容判断无害
  if (el.classList && el.classList.contains('hl-lens-mark')) return false;
  if (el.closest && el.closest('.hl-lens-mark')) return false;

  if (el.isContentEditable) return false;
  if (el.closest && el.closest(EDITOR_SELECTORS)) return false;

  if (el.namespaceURI === 'http://www.w3.org/2000/svg' || (el.closest && el.closest('svg'))) return false;
  if (el.namespaceURI === 'http://www.w3.org/1998/Math/MathML' || (el.closest && el.closest('math'))) return false;

  return true;
}

function isHighlightable(node) {
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const parent = node.parentNode;
  if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return false;
  return isElementHighlightable(parent);
}

// =============================================================================
// 现代方案：CSS Custom Highlight API
// =============================================================================

const HL_NAME_PREFIX = 'hl-lens-';
const STYLE_ELEMENT_ID = '__hl_lens_highlight_styles__';
// 需要在 manifest.json 里把这个文件加进 content_scripts 的 "css" 数组，
// 浏览器注入的这份样式表不受目标页面 CSP(style-src) 限制，见下方 getInjectedStyleSheet()
const HIGHLIGHT_CSS_FILENAME = 'highlight.css';

let highlightObjects = new Map();     // name -> Highlight 实例
let keywordNameMap = new WeakMap();   // keyword对象 -> highlight name
let nodeRangeMap = new WeakMap();     // 文本节点 -> [{name, range}, ...]
const observedShadowRoots = new WeakSet();

function resetHighlightRegistry() {
  for (const name of highlightObjects.keys()) {
    try { CSS.highlights.delete(name); } catch (e) {}
  }
  highlightObjects = new Map();
  keywordNameMap = new WeakMap();
  nodeRangeMap = new WeakMap();
}

function assignHighlightNames() {
  activeKeywordList.forEach((kw, i) => {
    keywordNameMap.set(kw, `${HL_NAME_PREFIX}${i}`);
  });
}

let injectedStyleSheetRef = null;

/**
 * 找到通过 manifest.json content_scripts.css 注入的那份样式表。
 * 这种方式注入的 CSS 是浏览器扩展系统自己插入的，不受目标页面的
 * CSP(style-src) 限制——很多内部系统/中后台会配置比较严格的 CSP，
 * 直接用 document.createElement('style') 挂到页面 <head> 上的样式，
 * 在这类页面上可能被浏览器悄悄拦截（不会报 JS 异常，只在 devtools
 * Console 里打一条 CSP 警告），表现出来就是"逻辑都对，但看起来完全不生效"。
 */
function getInjectedStyleSheet() {
  if (injectedStyleSheetRef && injectedStyleSheetRef.ownerNode && injectedStyleSheetRef.ownerNode.isConnected) {
    return injectedStyleSheetRef;
  }
  try {
    const cssUrl = chrome.runtime.getURL(HIGHLIGHT_CSS_FILENAME);
    injectedStyleSheetRef = Array.from(document.styleSheets).find(s => s.href === cssUrl) || null;
  } catch (e) {
    injectedStyleSheetRef = null;
  }
  return injectedStyleSheetRef;
}

function rebuildHighlightStyles() {
  const sheet = getInjectedStyleSheet();

  if (sheet) {
    // 优先方案：通过 CSSOM 操作扩展自带的样式表，天然绕开页面 CSP
    try {
      while (sheet.cssRules.length > 0) {
        sheet.deleteRule(0);
      }
      activeKeywordList.forEach((kw) => {
        const name = keywordNameMap.get(kw);
        if (!name) return;
        const bg = kw.color || 'yellow';
        let rule = `::highlight(${name}) { background-color: ${bg};`;
        if (kw.fgColor) rule += ` color: ${kw.fgColor};`;
        rule += ' }';
        try {
          sheet.insertRule(rule, sheet.cssRules.length);
        } catch (e) {
          // 极个别页面对 CSSOM 写入也有限制，单条规则失败不影响其他关键词
        }
      });
      return;
    } catch (e) {
      // 落到下面的兜底方案
    }
  }

  // 兜底方案：如果没有正确配置 highlight.css（manifest 没声明，或者旧版本还没升级），
  // 退回旧的"创建 <style> 标签插到 <head>"方式。提醒：这种方式在有严格 CSP 的
  // 页面上可能被拦截、样式不生效，但不影响 Range/匹配逻辑本身的正确性。
  let styleEl = document.getElementById(STYLE_ELEMENT_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ELEMENT_ID;
    (document.head || document.documentElement).appendChild(styleEl);
  }
  let css = '';
  activeKeywordList.forEach((kw) => {
    const name = keywordNameMap.get(kw);
    if (!name) return;
    const bg = kw.color || 'yellow';
    css += `::highlight(${name}) { background-color: ${bg};`;
    if (kw.fgColor) css += ` color: ${kw.fgColor};`;
    css += ' }\n';
  });
  try {
    styleEl.textContent = css;
  } catch (e) {
    // 同样可能被 CSP 拦截，静默失败
  }
}

function ensureHighlightObject(name) {
  let h = highlightObjects.get(name);
  if (!h) {
    h = new Highlight();
    highlightObjects.set(name, h);
    CSS.highlights.set(name, h);
  }
  return h;
}

function clearNodeHighlights(node) {
  const entries = nodeRangeMap.get(node);
  if (!entries) return;
  for (const { name, range } of entries) {
    const h = highlightObjects.get(name);
    if (h) {
      try { h.delete(range); } catch (e) { /* range 可能已经不在集合里，忽略 */ }
    }
  }
  nodeRangeMap.delete(node);
}

/**
 * 对单个文本节点重新计算并应用高亮（不修改 DOM，只操作 Range + Highlight）。
 */
function highlightNodeModern(node) {
  if (!node) return;

  if (!keywordsRegex || !node.isConnected || !isHighlightable(node)) {
    clearNodeHighlights(node);
    return;
  }

  const text = node.nodeValue;
  clearNodeHighlights(node);
  if (!text || !text.trim()) return;

  const matches = findMatches(text);
  if (matches.length === 0) return;

  const entries = [];
  for (const m of matches) {
    if (!m.kwConfig) continue;
    const name = keywordNameMap.get(m.kwConfig);
    if (!name) continue;

    let range;
    try {
      range = document.createRange();
      range.setStart(node, m.start);
      range.setEnd(node, m.end);
    } catch (e) {
      continue; // 文本在计算和创建 Range 之间发生了变化，跳过这一条即可，不影响其他匹配
    }

    ensureHighlightObject(name).add(range);
    entries.push({ name, range });
  }

  if (entries.length > 0) {
    nodeRangeMap.set(node, entries);
  }
}

/**
 * 递归收集可高亮的文本节点；相比 TreeWalker，额外支持穿透 open shadow root。
 */
function collectHighlightableTextNodes(root, out) {
  if (!root) return;

  if (root.nodeType === Node.TEXT_NODE) {
    if (isHighlightable(root)) out.push(root);
    return;
  }

  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    return;
  }

  if (root.nodeType === Node.ELEMENT_NODE && !isElementHighlightable(root)) {
    return;
  }

  for (const child of root.childNodes) {
    collectHighlightableTextNodes(child, out);
  }

  if (root.nodeType === Node.ELEMENT_NODE && root.shadowRoot) {
    observeShadowRoot(root.shadowRoot);
  }
}

function highlightAllModern() {
  if (!document.body) return;
  const nodes = [];
  collectHighlightableTextNodes(document.body, nodes);
  nodes.forEach(highlightNodeModern);
}

function scanAndHighlightModern(root) {
  if (!root || !root.isConnected) return;
  const nodes = [];
  collectHighlightableTextNodes(root, nodes);
  nodes.forEach(highlightNodeModern);
}

function clearHighlightsModern() {
  for (const h of highlightObjects.values()) {
    try { h.clear(); } catch (e) {}
  }
  nodeRangeMap = new WeakMap();
}

/**
 * 当一个节点（含其子树）从 DOM 上被移除时，清理它相关的 Range，
 * 避免 Highlight 集合里堆积指向"游离节点"的无效 Range。
 */
function cleanupRemovedSubtree(node) {
  if (!node) return;
  if (node.nodeType === Node.TEXT_NODE) {
    clearNodeHighlights(node);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    clearNodeHighlights(n);
  }
}

/**
 * 支持 open shadow root：对新出现的 shadow root 建立监听并做首次扫描。
 * 只在支持 Custom Highlight 的现代模式下启用——legacy 模式往 shadow DOM
 * 里插入 span 会有和"虚拟列表节点复用"同样的风险，索性不做。
 */
function observeShadowRoot(root) {
  if (!SUPPORTS_CUSTOM_HIGHLIGHT) return;
  if (!root || observedShadowRoots.has(root)) return;
  observedShadowRoots.add(root);

  try {
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  } catch (e) { /* 有些环境下对 ShadowRoot 调用 observe 可能受限，忽略即可 */ }

  const nodes = [];
  collectHighlightableTextNodes(root, nodes);
  nodes.forEach(highlightNodeModern);
}

if (SUPPORTS_CUSTOM_HIGHLIGHT && Element.prototype.attachShadow && !Element.prototype.attachShadow.__hlLensPatched) {
  const originalAttachShadow = Element.prototype.attachShadow;
  function patchedAttachShadow(init) {
    const root = originalAttachShadow.call(this, init);
    if (init && init.mode === 'open') {
      // 延后一个微任务，给调用方留出时间把初始内容塞进 shadow root 再扫描
      Promise.resolve().then(() => observeShadowRoot(root));
    }
    return root;
  }
  patchedAttachShadow.__hlLensPatched = true;
  Element.prototype.attachShadow = patchedAttachShadow;
}

// =============================================================================
// 传统方案（回退）：直接操作 DOM，插入 <span class="hl-lens-mark">
// 仅在浏览器不支持 CSS Custom Highlight API 时使用。
// =============================================================================

function clearHighlightsLegacy() {
  const marks = document.querySelectorAll('.hl-lens-mark');
  const parents = new Set();
  marks.forEach(mark => {
    const parent = mark.parentNode;
    if (parent) {
      const textNode = document.createTextNode(mark.textContent);
      parent.replaceChild(textNode, mark);
      parents.add(parent);
    }
  });
  parents.forEach(parent => {
    try { parent.normalize(); } catch (e) {}
  });
}

function highlightNodeLegacy(node) {
  if (!keywordsRegex || !node.isConnected || !isHighlightable(node)) return;

  const text = node.nodeValue;
  if (!text || !text.trim()) return;

  const matches = findMatches(text);
  if (matches.length === 0) return;

  const fragment = document.createDocumentFragment();
  let lastIndex = 0;

  for (const m of matches) {
    if (m.start > lastIndex) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex, m.start)));
    }
    const span = document.createElement('span');
    span.className = 'hl-lens-mark';
    span.textContent = m.text;
    span.style.backgroundColor = m.kwConfig ? (m.kwConfig.color || 'yellow') : 'yellow';
    if (m.kwConfig && m.kwConfig.fgColor) {
      span.style.color = m.kwConfig.fgColor;
    }
    fragment.appendChild(span);
    lastIndex = m.end;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
  }

  if (node.parentNode) {
    node.parentNode.replaceChild(fragment, node);
  }
}

function highlightAllLegacy() {
  if (!keywordsRegex || !document.body) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isHighlightable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  const nodes = [];
  let currentNode;
  while ((currentNode = walker.nextNode())) nodes.push(currentNode);
  nodes.forEach(highlightNodeLegacy);
}

function scanAndHighlightLegacy(root) {
  if (!keywordsRegex || !root || !root.isConnected) return;
  if (!isElementHighlightable(root)) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isHighlightable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  const nodes = [];
  let currentNode;
  while ((currentNode = walker.nextNode())) nodes.push(currentNode);
  nodes.forEach(highlightNodeLegacy);
}

// =============================================================================
// 统一入口：根据当前浏览器能力选择渲染引擎
// =============================================================================

/**
 * 重新计算高亮名称/样式表并对整个页面做一次全量渲染。
 * 在关键词/分组/设置发生变化时调用。
 */
function refreshHighlighting() {
  if (SUPPORTS_CUSTOM_HIGHLIGHT) {
    resetHighlightRegistry();
    assignHighlightNames();
    rebuildHighlightStyles();
    highlightAllModern();
  } else {
    pauseObserving();
    try {
      clearHighlightsLegacy();
      highlightAllLegacy();
    } finally {
      resumeObserving();
    }
  }
}

// ---------------------------------------------------------------------------
// MutationObserver：防抖 + 批处理
// ---------------------------------------------------------------------------
let pendingNodes = new Set();
let mutationTimeout = null;
let lastProcessTime = 0;
const DEBOUNCE_DELAY = 50;
const MAX_WAIT = 250;

function queueNodeForHighlight(node) {
  if (!node) return;
  if (isEditorDocument()) return;

  if (node.nodeType === Node.TEXT_NODE) {
    if (!isHighlightable(node)) return;
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    if (!isElementHighlightable(node)) return;
  } else {
    return;
  }

  pendingNodes.add(node);

  const now = Date.now();
  if (!lastProcessTime) lastProcessTime = now;

  if (mutationTimeout) clearTimeout(mutationTimeout);

  if (now - lastProcessTime >= MAX_WAIT) {
    processPendingNodes();
  } else {
    mutationTimeout = setTimeout(processPendingNodes, DEBOUNCE_DELAY);
  }
}

function clearPendingQueue() {
  if (mutationTimeout) {
    clearTimeout(mutationTimeout);
    mutationTimeout = null;
  }
  pendingNodes.clear();
  lastProcessTime = 0;
}

function processPendingNodes() {
  if (mutationTimeout) {
    clearTimeout(mutationTimeout);
    mutationTimeout = null;
  }
  lastProcessTime = 0;

  if (!keywordsRegex || pendingNodes.size === 0) {
    pendingNodes.clear();
    return;
  }

  const nodesToProcess = Array.from(pendingNodes);
  pendingNodes.clear();

  if (SUPPORTS_CUSTOM_HIGHLIGHT) {
    // 现代模式：不修改 DOM，不需要暂停 observer
    for (const node of nodesToProcess) {
      if (!node.isConnected) {
        clearNodeHighlights(node);
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        highlightNodeModern(node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        scanAndHighlightModern(node);
      }
    }
  } else {
    // 传统模式：处理过程会产生 DOM mutation，必须暂停 observer 防止自触发
    pauseObserving();
    try {
      for (const node of nodesToProcess) {
        if (!node.isConnected) continue;
        if (node.nodeType === Node.TEXT_NODE) {
          highlightNodeLegacy(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          scanAndHighlightLegacy(node);
        }
      }
    } finally {
      resumeObserving();
    }
  }
}

let isObserving = false;

const observer = new MutationObserver((mutations) => {
  if (!keywordsRegex) return;

  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      if (SUPPORTS_CUSTOM_HIGHLIGHT) {
        for (const node of mutation.removedNodes) {
          cleanupRemovedSubtree(node);
        }
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
          queueNodeForHighlight(node);
        }
      }
    } else if (mutation.type === 'characterData') {
      queueNodeForHighlight(mutation.target);
    }
  }
});

function startObserving() {
  if (!document.body || isObserving) return;
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
  isObserving = true;
}

function pauseObserving() {
  if (isObserving) {
    observer.disconnect();
    observer.takeRecords();
    isObserving = false;
  }
}

function resumeObserving() {
  if (!isObserving && document.body) {
    startObserving();
  }
}

function start() {
  if (isEditorDocument()) return;

  if (document.body) {
    refreshHighlighting();
    startObserving();
  } else {
    const bodyObserver = new MutationObserver((mutations, obs) => {
      if (document.body) {
        obs.disconnect();
        if (isEditorDocument()) return;
        refreshHighlighting();
        startObserving();
      }
    });
    bodyObserver.observe(document.documentElement, { childList: true });
  }
}
