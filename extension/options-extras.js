"use strict";
const syncSection = document.createElement("section");
syncSection.className = "card";
syncSection.innerHTML =
  '<h2>手动浏览器同步（可选）</h2><p class="muted">选中的规则会交给浏览器账户的同步服务。书签、视频专用规则、下载记录、标签缓存、Cookie 和媒体资源不会同步。单次最多 6 KB，不会自动上传。</p><div id="sync-fields"></div><div class="actions"><button id="sync-upload">上传所选设置</button><button id="sync-preview">下载并预览</button><button id="clear-cache">清理弹幕与标签缓存</button><button id="export-diagnostics">导出诊断 JSON</button></div>';
document.querySelector("main").append(syncSection);
for (const [field, label] of Object.entries({
  modules: "模块开关",
  search: "搜索规则",
  danmaku: "全局弹幕规则",
  player: "播放器设置",
  ui: "外观设置",
})) {
  const control = document.createElement("label"),
    input = document.createElement("input");
  input.type = "checkbox";
  input.value = field;
  input.checked = ["modules", "ui"].includes(field);
  control.append(input, document.createTextNode(label));
  $("sync-fields").append(control);
}
const syncKey = "lensUserSelectedSettings";
function extraAction(id, action) {
  $(id).addEventListener("click", async () => {
    try {
      if (!settings) throw new Error("设置尚未读取");
      await action();
    } catch (error) {
      notice(error.message, true);
    }
  });
}
extraAction("sync-upload", async () => {
  const fields = {};
  for (const checkbox of document.querySelectorAll(
    "#sync-fields input:checked",
  ))
    fields[checkbox.value] = settings[checkbox.value];
  if (!Object.keys(fields).length) throw new Error("请选择同步范围");
  const payload = { version: 1, fields };
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 6000)
    throw new Error("所选设置超过 6 KB，请减少规则或取消部分同步范围");
  await chrome.storage.sync.set({ [syncKey]: payload });
  settings.syncEnabled = true;
  settings = await LensSettings.save(settings);
  notice("所选设置已写入浏览器同步；不会自动上传后续修改。");
});
extraAction("sync-preview", async () => {
  const payload = (await chrome.storage.sync.get(syncKey))[syncKey];
  if (!payload || payload.version !== 1 || !payload.fields)
    throw new Error("没有可用的同步备份");
  const merged = LensSettings.copy(settings);
  for (const key of ["modules", "search", "danmaku", "player", "ui"])
    if (payload.fields[key]) merged[key] = payload.fields[key];
  importCandidate = LensSettings.validate(merged);
  $("import-preview").textContent = JSON.stringify(payload.fields, null, 2);
  $("import-preview").hidden = false;
  $("confirm-import").hidden = false;
  $("import-preview").scrollIntoView({ block: "center" });
  notice("已下载同步配置；预览后点击应用导入配置。");
});
extraAction("clear-cache", async () => {
  await request("clearCache");
  notice("已清理弹幕与标签缓存，刷新搜索页后会重新查询标签。");
});
extraAction("export-diagnostics", async () => {
  const data = await request("diagnostics"),
    url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    ),
    link = document.createElement("a");
  link.href = url;
  link.download = "bilifun-diagnostics.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
async function showTagPermission() {
  const allowed = await chrome.permissions.contains({
    origins: ["https://api.bilibili.com/*"],
  });
  $("tag-permission").textContent = allowed
    ? "数据接口已授权，搜索页可核对真实视频标签。"
    : "尚未授权；这里只申请 B 站数据接口访问，下载权限会在开始下载时申请。";
}
$("grant-tags").addEventListener("click", async () => {
  try {
    const allowed = await chrome.permissions.request({
      origins: ["https://api.bilibili.com/*"],
    });
    await showTagPermission();
    notice(
      allowed
        ? "视频标签查询已授权；返回搜索页会自动检查，也可刷新搜索页。"
        : "未授权标签查询，无法核对的结果继续保留。",
    );
  } catch (error) {
    notice(error.message, true);
  }
});
showTagPermission().catch(() => {});
