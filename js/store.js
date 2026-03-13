const Store = {
  DEFAULT_GROUP_ID: 'default',

  // 获取所有数据，包含迁移逻辑
  async getData() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ 
        keywords: [], 
        groups: null,
        currentGroupId: null,
        lastState: null,
        stats: { totalAdded: 0 },
        milestones: { lastShown: 0 }
      }, (data) => {
        let needsUpdate = false;

        // 1. 迁移：确保 groups 存在
        if (!data.groups) {
          data.groups = [{ id: this.DEFAULT_GROUP_ID, name: chrome.i18n.getMessage('defaultGroupName') || 'Default Group' }];
          needsUpdate = true;
        }

        // 2. 迁移：确保 currentGroupId 存在
        if (!data.currentGroupId) {
          data.currentGroupId = this.DEFAULT_GROUP_ID;
          needsUpdate = true;
        }

        // 3. 迁移：确保所有关键词都有 groupId
        data.keywords = data.keywords.map(k => {
          if (!k.groupId) {
            k.groupId = this.DEFAULT_GROUP_ID;
            needsUpdate = true;
          }
          return k;
        });

        if (needsUpdate) {
          this.saveData(data).then(() => resolve(data));
        } else {
          resolve(data);
        }
      });
    });
  },

  // 保存所有数据
  async saveData(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  },

  // 创建新分组
  async createGroup(name) {
    const data = await this.getData();
    const newGroup = {
      id: Date.now().toString(),
      name: name.trim(),
      createdAt: Date.now()
    };
    data.groups.push(newGroup);
    await this.saveData({ groups: data.groups });
    return newGroup;
  },

  // 删除分组及其所有关键词
  async deleteGroup(groupId) {
    if (groupId === this.DEFAULT_GROUP_ID) return;
    const data = await this.getData();
    
    const groups = data.groups.filter(g => g.id !== groupId);
    const keywords = data.keywords.filter(k => k.groupId !== groupId);
    
    const update = { groups, keywords };
    if (data.currentGroupId === groupId) {
      update.currentGroupId = this.DEFAULT_GROUP_ID;
    }
    
    await this.saveData(update);
  },

  // 切换当前激活的分组
  async setCurrentGroup(groupId) {
    await this.saveData({ currentGroupId: groupId });
  },

  // 统一的添加关键词逻辑
  async addKeyword(text, customColor = null, customFgColor = null, groupId = null) {
    const data = await this.getData();
    let keywords = data.keywords;
    const normalizedText = text.trim();
    const targetGroupId = groupId || this.DEFAULT_GROUP_ID;

    // 查重并先删除 (同分组查重)
    keywords = keywords.filter(k => 
      !(k.text.toLowerCase() === normalizedText.toLowerCase() && k.groupId === targetGroupId)
    );

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
      fgColor: customFgColor || preset.fg,
      enabled: true,
      groupId: targetGroupId
    };

    keywords.push(newKeyword);

    // 更新统计
    const stats = data.stats || { totalAdded: 0 };
    stats.totalAdded = (stats.totalAdded || 0) + 1;

    const nextPresetIndex = (currentPresetIndex + 1) % PRESETS.length;
    const newState = {
      ...(data.lastState || {}),
      keyword: '', 
      presetIndex: nextPresetIndex,
      bgColor: PRESETS[nextPresetIndex].bg,
      fgColor: PRESETS[nextPresetIndex].fg
    };

    await this.saveData({ keywords, lastState: newState, stats });
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

  // 切换启用状态
  async toggleKeyword(id, enabled) {
    const data = await this.getData();
    const keywords = data.keywords.map(k => {
      if (k.id === id) {
        return { ...k, enabled };
      }
      return k;
    });
    await this.saveData({ keywords });
  },

  // 保存 UI 状态
  async saveLastState(state) {
    const data = await this.getData();
    await this.saveData({
      lastState: { ...(data.lastState || {}), ...state }
    });
  },

  // 关闭里程碑提示
  async dismissMilestone(id) {
    const data = await this.getData();
    await this.saveData({
      milestones: { ...data.milestones, lastShown: id }
    });
  }
};
