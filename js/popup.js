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
  
  // Group elements
  const groupSelector = document.getElementById('group-selector');
  const deleteGroupBtn = document.getElementById('delete-group-btn');
  const addGroupToggle = document.getElementById('add-group-toggle');
  const newGroupPanel = document.getElementById('new-group-panel');
  const newGroupNameInput = document.getElementById('new-group-name');
  const confirmAddGroupBtn = document.getElementById('confirm-add-group');
  const targetGroupSelect = document.getElementById('target-group-select');

  let currentPresetIndex = 0;
  let isSchemeOpen = false;
  let isCustomOpen = false;
  let isAddOpen = false;
  let isInitialLoad = true; // 标记是否为初次加载
  let currentGroupId = 'default';

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

  async function checkMilestones(data) {
    const banner = document.getElementById('milestone-banner');
    const bannerText = document.getElementById('milestone-text');
    const bannerLink = document.getElementById('milestone-link');
    const bannerClose = document.getElementById('milestone-close');

    const total = (data.stats && data.stats.totalAdded) || 0;
    const lastShown = (data.milestones && data.milestones.lastShown) || 0;

    let milestoneToShow = null;
    
    // 里程碑阈值定义 (从大到小检查)
    if (total >= 100 && lastShown < 100) {
      milestoneToShow = 100;
    } else if (total >= 30 && lastShown < 30) {
      milestoneToShow = 30;
    } else if (total >= 15 && lastShown < 15) {
      milestoneToShow = 15;
    } else if (total >= 5 && lastShown < 5) {
      milestoneToShow = 5;
    }

    if (milestoneToShow) {
      bannerText.textContent = chrome.i18n.getMessage(`milestone_${milestoneToShow}_text`);
      bannerLink.textContent = chrome.i18n.getMessage(`milestone_${milestoneToShow}_action`);
      
      bannerLink.onclick = (e) => {
        e.preventDefault();
        const url = milestoneToShow === 5 
          ? '  https://chromewebstore.google.com/detail/hilight-lens/oihedepnomkjigefdiakfikpncbccimj'
          : 'https://ko-fi.com/qiyuanyang';
        chrome.tabs.create({ url });
        Store.dismissMilestone(milestoneToShow);
        banner.classList.add('hidden');
      };

      bannerClose.onclick = () => {
        Store.dismissMilestone(milestoneToShow);
        banner.classList.add('hidden');
      };

      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  function renderGroupOptions(groups, currentId) {
    groupSelector.innerHTML = '';
    targetGroupSelect.innerHTML = '';
    
    groups.forEach(g => {
      const opt1 = document.createElement('option');
      opt1.value = g.id;
      opt1.textContent = g.name;
      if (g.id === currentId) opt1.selected = true;
      groupSelector.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = g.id;
      opt2.textContent = g.name;
      // 默认添加关键词的分组跟随当前选择的分组
      if (g.id === currentId) opt2.selected = true;
      targetGroupSelect.appendChild(opt2);
    });
  }

  async function loadAndRenderAll() {
    const data = await Store.getData();
    
    // 检查里程碑
    checkMilestones(data);

    currentGroupId = data.currentGroupId || 'default';
    renderGroupOptions(data.groups, currentGroupId);

    // 控制删除按钮显示逻辑：默认分组不能删
    if (currentGroupId === 'default') {
      deleteGroupBtn.classList.add('hidden');
    } else {
      deleteGroupBtn.classList.remove('hidden');
    }

    // 渲染列表 (仅当前分组)
    keywordList.innerHTML = '';
    const filteredKeywords = data.keywords.filter(k => k.groupId === currentGroupId);
    [...filteredKeywords].reverse().forEach(item => renderKeyword(item));

    // 渲染 UI 状态
    if (data.lastState) {
      const s = data.lastState;
      keywordInput.value = s.keyword || '';
      bgColorInput.value = s.bgColor || PRESETS[0].bg;
      fgColorInput.value = s.fgColor || PRESETS[0].fg;
      currentPresetIndex = s.presetIndex !== undefined ? s.presetIndex : 0;
      
      // 逻辑：如果列表为空且是初次加载，则强制展开；否则遵循存储的状态
      let shouldOpen = !!s.isAddOpen;
      if (isInitialLoad && filteredKeywords.length === 0) {
        shouldOpen = true;
      }
      toggleAddSection(shouldOpen, false);
      
      toggleSchemeSection(!!s.isSchemeOpen, false);
      toggleCustomSection(!!s.isCustomOpen, false);
    } else {
      if (filteredKeywords.length === 0) toggleAddSection(true, false);
      updateActiveSwatch();
    }
    renderPresets();
    updatePreview();
    isInitialLoad = false;
  }

  // Event Listeners for Groups
  groupSelector.addEventListener('change', () => {
    const newId = groupSelector.value;
    chrome.runtime.sendMessage({ action: 'setCurrentGroup', groupId: newId });
  });

  deleteGroupBtn.addEventListener('click', () => {
    if (currentGroupId === 'default') return;
    
    // 二次确认，防止誤删
    const groupName = groupSelector.options[groupSelector.selectedIndex].text;
    const confirmMsg = chrome.i18n.getMessage('deleteGroupConfirm') || `Are you sure you want to delete group "${groupName}" and all its keywords?`;
    if (confirm(confirmMsg.replace('%s', groupName))) {
      chrome.runtime.sendMessage({ action: 'deleteGroup', groupId: currentGroupId });
    }
  });

  addGroupToggle.addEventListener('click', () => {
    newGroupPanel.classList.toggle('hidden');
    if (!newGroupPanel.classList.contains('hidden')) newGroupNameInput.focus();
  });

  confirmAddGroupBtn.addEventListener('click', () => {
    const name = newGroupNameInput.value.trim();
    if (!name) return;
    chrome.runtime.sendMessage({ action: 'createGroup', name }, (res) => {
      if (res.success) {
        newGroupNameInput.value = '';
        newGroupPanel.classList.add('hidden');
        // 创建完自动切换到新分组
        chrome.runtime.sendMessage({ action: 'setCurrentGroup', groupId: res.newGroup.id });
      }
    });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.keywords || changes.lastState || changes.currentGroupId || changes.groups) {
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
      fgColor: fgColorInput.value,
      groupId: targetGroupSelect.value
    }, (response) => {
      if (response && response.success) keywordInput.value = '';
    });
  }

  addBtn.addEventListener('click', handleAddKeyword);
  keywordInput.addEventListener('keydown', (e) => e.key === 'Enter' && handleAddKeyword());

  function renderKeyword(item) {
    const li = document.createElement('li');
    if (item.enabled === false) li.classList.add('disabled');
    
    const fgStyle = item.fgColor ? `color: ${item.fgColor};` : '';
    const isEnabled = item.enabled !== false;
    
    // Icons
    const eyeIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    const eyeOffIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
    const trashIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;

    li.innerHTML = `
      <span class="keyword-text">
        <span style="background-color: ${item.color}; padding: 2px 4px; border-radius: 2px; ${fgStyle}">
          ${item.text}
        </span>
      </span>
      <div class="action-group">
        <button class="icon-btn toggle-btn ${isEnabled ? 'enabled' : 'disabled'}" title="${chrome.i18n.getMessage(isEnabled ? 'hideLabel' : 'showLabel') || (isEnabled ? 'Hide' : 'Show')}">
          ${isEnabled ? eyeIcon : eyeOffIcon}
        </button>
        <button class="icon-btn delete-btn" title="${chrome.i18n.getMessage('deleteButton') || 'Delete'}">
          ${trashIcon}
        </button>
      </div>
    `;

    li.querySelector('.delete-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'deleteKeyword', id: item.id });
    });

    li.querySelector('.toggle-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ 
        action: 'toggleKeyword', 
        id: item.id, 
        enabled: !isEnabled 
      });
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
