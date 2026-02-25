document.addEventListener('DOMContentLoaded', () => {
  // Localization logic
  function applyLocalization() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const translation = chrome.i18n.getMessage(key);
      if (translation) el.textContent = translation;
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const translation = chrome.i18n.getMessage(key);
      if (translation) el.placeholder = translation;
    });
  }

  applyLocalization();

  const presetGrid = document.getElementById('preset-grid');
  const keywordInput = document.getElementById('keyword');
  const bgColorInput = document.getElementById('bg-color');
  const fgColorInput = document.getElementById('fg-color');
  const addBtn = document.getElementById('add-btn');
  const keywordList = document.getElementById('keyword-list');
  const schemeToggle = document.getElementById('scheme-toggle');
  const schemeContainer = document.getElementById('scheme-container');
  const customToggle = document.getElementById('custom-toggle');
  const customColorsContainer = document.getElementById('custom-colors-container');
  const addToggle = document.getElementById('add-toggle');
  const stepContainer = document.getElementById('step-container');
  const previewText = document.getElementById('preview-text');

  let currentPresetIndex = 0;
  let isSchemeOpen = false;
  let isCustomOpen = false;
  let isAddOpen = false;
  let isInitialLoad = true; // 标记是否为初次加载

  function updatePreview() {
    const keyword = keywordInput.value.trim() || chrome.i18n.getMessage('keywordPlaceholder').replace('...', '');
    previewText.textContent = keyword;
    previewText.style.backgroundColor = bgColorInput.value;
    previewText.style.color = fgColorInput.value;
  }

  function saveCurrentUIState() {
    Store.saveLastState({
      keyword: keywordInput.value,
      bgColor: bgColorInput.value,
      fgColor: fgColorInput.value,
      presetIndex: currentPresetIndex,
      isSchemeOpen: isSchemeOpen,
      isCustomOpen: isCustomOpen,
      isAddOpen: isAddOpen
    });
  }

  function renderPresets() {
    presetGrid.innerHTML = '';
    PRESETS.forEach((p, index) => {
      const swatch = document.createElement('div');
      swatch.className = 'swatch';
      if (index === currentPresetIndex) swatch.classList.add('active');
      swatch.style.backgroundColor = p.bg;
      swatch.style.color = p.fg;
      swatch.textContent = 'Aa';
      
      swatch.addEventListener('click', () => {
        currentPresetIndex = index;
        updateActiveSwatch();
        saveCurrentUIState();
        updatePreview();
      });
      presetGrid.appendChild(swatch);
    });
  }

  function updateActiveSwatch() {
    const swatches = document.querySelectorAll('.swatch');
    swatches.forEach((s, i) => {
      if (i === currentPresetIndex) {
        s.classList.add('active');
        const p = PRESETS[i];
        bgColorInput.value = p.bg;
        fgColorInput.value = p.fg;
      } else {
        s.classList.remove('active');
      }
    });
  }

  // shouldSave 参数防止 loadAndRenderAll 触发无限循环存储
  function toggleAddSection(open, shouldSave = true) {
    isAddOpen = open !== undefined ? open : !isAddOpen;
    if (isAddOpen) {
      stepContainer.classList.remove('hidden');
      addToggle.classList.add('open');
    } else {
      stepContainer.classList.add('hidden');
      addToggle.classList.remove('open');
    }
    if (shouldSave) saveCurrentUIState();
  }

  function toggleSchemeSection(open, shouldSave = true) {
    isSchemeOpen = open !== undefined ? open : !isSchemeOpen;
    if (isSchemeOpen) {
      schemeContainer.classList.remove('hidden');
      schemeToggle.classList.add('open');
    } else {
      schemeContainer.classList.add('hidden');
      schemeToggle.classList.remove('open');
    }
    if (shouldSave) saveCurrentUIState();
  }

  function toggleCustomSection(open, shouldSave = true) {
    isCustomOpen = open !== undefined ? open : !isCustomOpen;
    if (isCustomOpen) {
      customColorsContainer.classList.remove('hidden');
      customToggle.classList.add('open');
    } else {
      customColorsContainer.classList.add('hidden');
      customToggle.classList.remove('open');
    }
    if (shouldSave) saveCurrentUIState();
  }

  addToggle.addEventListener('click', () => toggleAddSection());
  schemeToggle.addEventListener('click', () => toggleSchemeSection());
  customToggle.addEventListener('click', () => toggleCustomSection());

  const clearActiveSwatches = () => {
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    currentPresetIndex = -1;
    saveCurrentUIState();
    updatePreview();
  };

  bgColorInput.addEventListener('input', clearActiveSwatches);
  fgColorInput.addEventListener('input', clearActiveSwatches);
  keywordInput.addEventListener('input', () => {
    saveCurrentUIState();
    updatePreview();
  });

  async function loadAndRenderAll() {
    const data = await Store.getData();
    
    // 渲染列表
    keywordList.innerHTML = '';
    [...data.keywords].reverse().forEach(item => renderKeyword(item));

    // 渲染 UI 状态
    if (data.lastState) {
      const s = data.lastState;
      keywordInput.value = s.keyword || '';
      bgColorInput.value = s.bgColor || PRESETS[0].bg;
      fgColorInput.value = s.fgColor || PRESETS[0].fg;
      currentPresetIndex = s.presetIndex !== undefined ? s.presetIndex : 0;
      
      // 逻辑：如果列表为空且是初次加载，则强制展开；否则遵循存储的状态
      let shouldOpen = !!s.isAddOpen;
      if (isInitialLoad && data.keywords.length === 0) {
        shouldOpen = true;
      }
      toggleAddSection(shouldOpen, false);
      
      toggleSchemeSection(!!s.isSchemeOpen, false);
      toggleCustomSection(!!s.isCustomOpen, false);
    } else {
      if (data.keywords.length === 0) toggleAddSection(true, false);
      updateActiveSwatch();
    }
    renderPresets();
    updatePreview();
    isInitialLoad = false;
  }

  chrome.storage.onChanged.addListener((changes) => {
    // 只有非本窗口保存 lastState 的变更（如 background 触发的）
    // 或者关键词列表变更时才全量更新，减少抖动
    if (changes.keywords || changes.lastState) {
      loadAndRenderAll();
    }
  });

  loadAndRenderAll();

  function handleAddKeyword() {
    const keyword = keywordInput.value.trim();
    if (!keyword) {
      alert(chrome.i18n.getMessage('emptyKeywordError'));
      return;
    }

    chrome.runtime.sendMessage({
      action: 'addKeyword',
      text: keyword,
      color: bgColorInput.value,
      fgColor: fgColorInput.value
    }, (response) => {
      if (response && response.success) keywordInput.value = '';
    });
  }

  addBtn.addEventListener('click', handleAddKeyword);
  keywordInput.addEventListener('keydown', (e) => e.key === 'Enter' && handleAddKeyword());

  function renderKeyword(item) {
    const li = document.createElement('li');
    const deleteText = chrome.i18n.getMessage('deleteButton') || 'Delete';
    const fgStyle = item.fgColor ? `color: ${item.fgColor};` : '';
    li.innerHTML = `
      <span>
        <span style="background-color: ${item.color}; padding: 2px 4px; border-radius: 2px; ${fgStyle}">
          ${item.text}
        </span>
      </span>
      <button class="delete-btn" data-id="${item.id}">${deleteText}</button>
    `;

    li.querySelector('.delete-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'deleteKeyword', id: item.id });
    });

    keywordList.appendChild(li);
  }

  // Footer links
  document.getElementById('more-tools-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://hugbear.ai' });
  });

  document.getElementById('coffee-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://ko-fi.com/qiyuanyang' });
  });
});
