"use strict";
document.getElementById("search").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    let keyword = "";
    if (tab?.url) {
      const url = new URL(tab.url);
      if (url.origin === "https://search.bilibili.com")
        keyword = url.searchParams.get("keyword") || "";
    }
    const reply = await chrome.runtime.sendMessage({
      op: "openSearch",
      keyword,
    });
    if (!reply?.ok) throw new Error(reply?.error || "无法打开独立搜索");
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
});
document
  .getElementById("settings")
  .addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("tools").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    tab?.url &&
    /^https:\/\/www\.bilibili\.com\/video\/(BV\w+|av\d+)/.test(tab.url)
  ) {
    const response = await chrome.runtime.sendMessage({
      op: "openTools",
      url: tab.url,
    });
    if (!response?.ok)
      document.getElementById("status").textContent =
        response?.error || "无法打开工具";
  } else await chrome.tabs.create({ url: chrome.runtime.getURL("tools.html") });
});
