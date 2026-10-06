"use strict";
let settings, importCandidate;
const $ = (id) => document.getElementById(id);
const get = (object, path) =>
  path.split(".").reduce((value, key) => value?.[key], object);
const put = (object, path, value) => {
  const keys = path.split("."),
    last = keys.pop();
  let target = object;
  for (const key of keys) target = target[key];
  target[last] = value;
};
function notice(text, error = false) {
  $("status").className = `status${error ? " error" : ""}`;
  $("status").textContent = text;
}
function fill() {
  document.documentElement.dataset.theme = settings.ui.theme;
  for (const element of document.querySelectorAll("[data-setting]")) {
    const value = get(settings, element.dataset.setting);
    if (element.dataset.value)
      element.checked = value.includes(element.dataset.value);
    else if (element.type === "checkbox") element.checked = value;
    else if (element.dataset.list === "groups")
      element.value = value.map((x) => x.join("|")).join("\n");
    else if (element.dataset.list)
      element.value = value.join(
        element.dataset.list === "numbers" ? "," : "\n",
      );
    else element.value = value;
  }
  $("profiles").value = JSON.stringify(settings.profiles, null, 2);
}
function collect() {
  const value = LensSettings.copy(settings);
  for (const element of document.querySelectorAll("[data-setting]")) {
    const path = element.dataset.setting;
    if (element.dataset.value) {
      const list = get(value, path).filter((x) => x !== element.dataset.value);
      if (element.checked) list.push(element.dataset.value);
      put(value, path, list);
    } else if (element.type === "checkbox") put(value, path, element.checked);
    else if (element.dataset.list === "groups")
      put(
        value,
        path,
        element.value
          .split(/\n/)
          .map((x) =>
            x
              .split("|")
              .map((s) => s.trim())
              .filter(Boolean),
          )
          .filter((x) => x.length > 1),
      );
    else if (element.dataset.list === "numbers")
      put(
        value,
        path,
        element.value
          .split(/[,\s]+/)
          .filter(Boolean)
          .map(Number),
      );
    else if (element.dataset.list)
      put(
        value,
        path,
        element.value
          .split(/\n/)
          .map((x) => x.trim())
          .filter(Boolean),
      );
    else
      put(
        value,
        path,
        element.type === "number" ? Number(element.value) : element.value,
      );
  }
  value.profiles = JSON.parse($("profiles").value || "[]");
  return LensSettings.validate(value);
}
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    settings = await LensSettings.save(collect());
    fill();
    notice("设置已保存；开启原搜索页实验功能后，请刷新 B 站搜索页。");
  } catch (error) {
    notice(error.message, true);
  }
});
$("reset").addEventListener("click", async () => {
  try {
    settings = await LensSettings.save({
      ...LensSettings.copy(LensSettings.defaults),
      bookmarks: settings.bookmarks,
      savedSearches: settings.savedSearches,
    });
    fill();
    notice("已恢复默认设置；书签和保存的查询保留。");
  } catch (error) {
    notice(error.message, true);
  }
});
$("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(settings, null, 2)], {
      type: "application/json",
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = "bilifun-settings.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
$("import").addEventListener("change", async (event) => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 200000) throw new Error("配置超过 200 KB");
    importCandidate = LensSettings.validate(JSON.parse(await file.text()));
    $("import-preview").textContent = JSON.stringify(
      {
        modules: importCandidate.modules,
        search: importCandidate.search,
        danmaku: importCandidate.danmaku,
        profiles: importCandidate.profiles.length,
        bookmarks: importCandidate.bookmarks.length,
      },
      null,
      2,
    );
    $("import-preview").hidden = false;
    $("confirm-import").hidden = false;
    notice("配置校验通过；查看预览后点击应用。");
  } catch (error) {
    importCandidate = null;
    $("confirm-import").hidden = true;
    notice(error.message, true);
  }
});
$("confirm-import").addEventListener("click", async () => {
  if (!importCandidate) return;
  settings = await LensSettings.save(importCandidate);
  fill();
  $("confirm-import").hidden = true;
  $("import-preview").hidden = true;
  notice("配置已导入。");
});
async function request(op) {
  const result = await chrome.runtime.sendMessage({ op });
  if (!result.ok) throw new Error(result.error);
  return result.result;
}
$("diagnostics").addEventListener("click", async () => {
  try {
    $("diagnostic-output").textContent = JSON.stringify(
      await request("diagnostics"),
      null,
      2,
    );
    $("diagnostic-output").hidden = false;
  } catch (error) {
    notice(error.message, true);
  }
});
$("clear-records").addEventListener("click", async () => {
  try {
    await request("clearTasks");
    notice("已清除结束任务的记录，下载文件保留。");
  } catch (error) {
    notice(error.message, true);
  }
});
LensSettings.load()
  .then((value) => {
    settings = value;
    fill();
  })
  .catch((error) => {
    settings = LensSettings.copy(LensSettings.defaults);
    fill();
    notice(error.message, true);
  });
