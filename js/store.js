const Store = {
  // 获取所有数据
  async getData() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ keywords: [], lastState: null }, resolve);
    });
  },

  // 保存所有数据
  async saveData(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  },

  // 统一的添加关键词逻辑
  async addKeyword(text, customColor = null, customFgColor = null) {
    const data = await this.getData();
    let keywords = data.keywords;
    const normalizedText = text.trim();

    // 查重并先删除
    keywords = keywords.filter(k => k.text.toLowerCase() !== normalizedText.toLowerCase());

    let currentPresetIndex = 0;
    if (data.lastState && data.lastState.presetIndex !== undefined) {
      currentPresetIndex = data.lastState.presetIndex;
      if (currentPresetIndex < 0) currentPresetIndex = 0;
    }

    const preset = PRESETS[currentPresetIndex];
    const newKeyword = {
      id: Date.now(),
      text: normalizedText,
      color: customColor || preset.bg,
      fgColor: customFgColor || preset.fg
    };

    keywords.push(newKeyword);

    const nextPresetIndex = (currentPresetIndex + 1) % PRESETS.length;
    const newState = {
      ...(data.lastState || {}),
      keyword: '', 
      presetIndex: nextPresetIndex,
      bgColor: PRESETS[nextPresetIndex].bg,
      fgColor: PRESETS[nextPresetIndex].fg
    };

    await this.saveData({ keywords, lastState: newState });
    return newKeyword;
  },

  // 统一的删除逻辑
  async deleteKeyword(id) {
    const data = await this.getData();
    const keywords = data.keywords.filter(k => k.id !== id);
    const update = { keywords };
    
    // 如果删掉了最后一个关键词，自动展开添加面板
    if (keywords.length === 0) {
      update.lastState = { ...(data.lastState || {}), isAddOpen: true };
    }
    
    await this.saveData(update);
  },

  // 保存 UI 状态
  async saveLastState(state) {
    const data = await this.getData();
    await this.saveData({
      lastState: { ...(data.lastState || {}), ...state }
    });
  }
};
