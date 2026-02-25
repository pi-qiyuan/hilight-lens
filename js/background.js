importScripts('constants.js', 'store.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "highlightSelection",
    title: chrome.i18n.getMessage("contextMenuHighlight"),
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "highlightSelection") {
    const keywordText = info.selectionText.trim();
    if (keywordText) await Store.addKeyword(keywordText);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'addKeyword') {
    Store.addKeyword(request.text, request.color, request.fgColor).then(newKeyword => {
      sendResponse({ success: true, newKeyword });
    });
    return true;
  } else if (request.action === 'deleteKeyword') {
    Store.deleteKeyword(request.id).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
});
