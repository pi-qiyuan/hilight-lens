let keywords = [];
let groups = [];
let currentGroupId = 'default';
let keywordsRegex = null;

// Load keywords and group state from storage
chrome.storage.local.get({ 
  keywords: [], 
  groups: [{ id: 'default', name: 'Default' }], 
  currentGroupId: 'default' 
}, (result) => {
  groups = result.groups;
  currentGroupId = result.currentGroupId;
  updateKeywords(result.keywords);
  start();
});

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    let shouldUpdate = false;
    
    if (changes.keywords) {
      keywords = changes.keywords.newValue || [];
      shouldUpdate = true;
    }
    
    if (changes.currentGroupId) {
      currentGroupId = changes.currentGroupId.newValue;
      shouldUpdate = true;
    }

    if (shouldUpdate) {
      updateKeywords(keywords);
      clearHighlights();
      highlightAll();
    }
  }
});

/**
 * Updates the local keywords list and pre-compiles a single regex for performance.
 * Only includes keywords from the currently active group.
 */
function updateKeywords(allKeywords) {
  keywords = allKeywords;
  
  // Only highlight keywords in the current group and that are enabled
  const activeKeywords = keywords.filter(k => 
    k.groupId === currentGroupId && k.enabled !== false
  );
  
  if (activeKeywords.length === 0) {
    keywordsRegex = null;
    return;
  }
  // Sort by length descending to ensure "Apple" is matched before "App"
  const sortedTexts = [...activeKeywords]
    .map(k => escapeRegExp(k.text))
    .sort((a, b) => b.length - a.length);
  
  keywordsRegex = new RegExp(`(${sortedTexts.join('|')})`, 'gi');
}

/**
 * Removes all existing highlights from the page.
 */
function clearHighlights() {
  const marks = document.querySelectorAll('.hl-lens-mark');
  marks.forEach(mark => {
    const parent = mark.parentNode;
    if (parent) {
      const textNode = document.createTextNode(mark.textContent);
      parent.replaceChild(textNode, mark);
      parent.normalize();
    }
  });
}

/**
 * Main function to scan the page using a TreeWalker for maximum performance.
 */
function highlightAll() {
  if (!keywordsRegex || !document.body) return;

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentNode;
        if (parent && 
            ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'].indexOf(parent.tagName) === -1 &&
            !parent.classList.contains('hl-lens-mark')) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_REJECT;
      }
    }
  );

  const nodes = [];
  let currentNode;
  while (currentNode = walker.nextNode()) {
    nodes.push(currentNode);
  }

  // Process nodes after walking to avoid issues with live DOM changes
  nodes.forEach(node => highlightNode(node));
}

/**
 * Efficiently highlight a single text node using the pre-compiled regex.
 */
function highlightNode(node) {
  if (!keywordsRegex || node.nodeType !== Node.TEXT_NODE) return;

  const parent = node.parentNode;
  if (!parent || 
      ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'].indexOf(parent.tagName) !== -1 ||
      parent.classList.contains('hl-lens-mark')) {
    return;
  }

  const text = node.nodeValue;
  if (!text.trim()) return;

  // Reset regex lastIndex before starting
  keywordsRegex.lastIndex = 0;
  
  // Use exec() directly to avoid double-testing and lastIndex issues
  let match = keywordsRegex.exec(text);
  if (!match) return;

  const fragment = document.createDocumentFragment();
  let lastIndex = 0;

  do {
    // Add preceding text
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
    }

    // Find the original keyword object to get its specific color
    const matchedText = match[0];
    const kwConfig = keywords.find(k => k.text.toLowerCase() === matchedText.toLowerCase());
    
    const span = document.createElement('span');
    span.className = 'hl-lens-mark';
    span.textContent = matchedText;
    if (kwConfig) {
      span.style.backgroundColor = kwConfig.color;
      if (kwConfig.fgColor) {
        span.style.color = kwConfig.fgColor;
      }
    } else {
      span.style.backgroundColor = 'yellow';
    }
    fragment.appendChild(span);

    lastIndex = keywordsRegex.lastIndex;
  } while ((match = keywordsRegex.exec(text)) !== null);

  // Add remaining text
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
  }

  if (node.parentNode) {
    node.parentNode.replaceChild(fragment, node);
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MutationObserver to detect dynamically loaded or changed content.
 */
const observer = new MutationObserver((mutations) => {
  if (!keywordsRegex) return;
  
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          highlightNode(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          scanAndHighlight(node);
        }
      }
    } else if (mutation.type === 'characterData') {
      highlightNode(mutation.target);
    }
  }
});

/**
 * Scans an element's subtree for text nodes and highlights them.
 */
function scanAndHighlight(root) {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentNode;
        if (parent && 
            ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'].indexOf(parent.tagName) === -1 &&
            !parent.classList.contains('hl-lens-mark')) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_REJECT;
      }
    }
  );

  const nodes = [];
  let currentNode;
  while (currentNode = walker.nextNode()) {
    nodes.push(currentNode);
  }
  nodes.forEach(node => highlightNode(node));
}

/**
 * Starts the highlighting process and observation.
 */
function start() {
  if (document.body) {
    highlightAll();
    startObserving();
  } else {
    const bodyObserver = new MutationObserver((mutations, obs) => {
      if (document.body) {
        highlightAll();
        startObserving();
        obs.disconnect();
      }
    });
    bodyObserver.observe(document.documentElement, { childList: true });
  }
}

/**
 * Starts observing the document for changes.
 */
function startObserving() {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}
