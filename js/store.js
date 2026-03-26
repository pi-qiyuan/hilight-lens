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
  },

  // 导出数据为纯文本
  async exportData() {
    const data = await Store.getData();
    const groupMap = {};
    (data.groups || []).forEach(g => groupMap[g.id] = g.name);

    let content = chrome.i18n.getMessage('exportHeader') || '';

    (data.keywords || []).forEach(k => {
      const groupName = groupMap[k.groupId] || chrome.i18n.getMessage('defaultGroupName');
      content += `${k.text} | ${k.color} | ${k.fgColor} | ${k.enabled} | ${groupName}\n`;
    });

    const now = new Date();
    // 格式化为 YYYY/M/D HH:mm:ss
    const timestamp = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const appName = chrome.i18n.getMessage('appName');

    content += `\n${chrome.i18n.getMessage('exportFooter', [appName, timestamp])}\n`;
    return content;
  },


  // 导入纯文本数据
  async importData(textContent) {
    try {
      const lines = textContent.split(/\r?\n/);
      const newKeywords = [];
      const groupNames = new Set();
      const defaultGroupName = chrome.i18n.getMessage('defaultGroupName') || 'Default Group';

      for (let line of lines) {
        line = line.trim();
        // 忽略空行或以 # 开头的注释行
        if (!line || line.startsWith('#')) continue;

        const parts = line.split('|').map(s => s.trim());
        if (parts.length < 1) continue;

        const text = parts[0];
        if (!text) continue;

        // 如果没有背景色，使用第一个预设
        const color = parts[1] || (typeof PRESETS !== 'undefined' ? PRESETS[0].bg : '#E8F5E9');
        const fgColor = parts[2] || (typeof PRESETS !== 'undefined' ? PRESETS[0].fg : '#2E7D32');
        const enabled = parts[3] !== 'false'; // 默认为 true
        const groupName = parts[4] || defaultGroupName;

        groupNames.add(groupName);
        newKeywords.push({
          text, color, fgColor, enabled, groupName
        });
      }

      if (newKeywords.length === 0) {
        // 允许导入空列表（比如用户清空了文件），但如果格式全错会在此之前 continue 掉
        // 如果这里逻辑上想更严格点可以判断文件内容是否合理
      }

      // 重新生成分组数据
      const newGroups = [];
      const groupNameToId = {};
      
      // 始终确保默认分组存在并放在首位
      groupNameToId[defaultGroupName] = this.DEFAULT_GROUP_ID;
      newGroups.push({ id: this.DEFAULT_GROUP_ID, name: defaultGroupName });

      // 为导入的其他分组生成 ID
      let idCounter = 0;
      for (const name of groupNames) {
        if (name === defaultGroupName) continue;
        // 生成唯一 ID
        const id = (Date.now() + (idCounter++)).toString();
        groupNameToId[name] = id;
        newGroups.push({ id, name, createdAt: Date.now() });
      }

      // 生成关键词数据
      const finalKeywords = newKeywords.map((k, index) => ({
        id: Date.now() + index,
        text: k.text,
        color: k.color,
        fgColor: k.fgColor,
        enabled: k.enabled,
        groupId: groupNameToId[k.groupName] || this.DEFAULT_GROUP_ID
      }));

      // 更新存储
      const stats = { totalAdded: finalKeywords.length };
      await this.saveData({
        keywords: finalKeywords,
        groups: newGroups,
        currentGroupId: this.DEFAULT_GROUP_ID,
        stats
      });
      return true;
    } catch (e) {
      console.error('Import failed:', e);
      return false;
    }
  }
};
