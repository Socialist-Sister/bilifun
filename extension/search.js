"use strict";
const $ = (id) => document.getElementById(id);
const session = new LensSearch.Session(
  (...args) => LensRpc.request(...args),
  render,
);
let currentPage = 1,
  ready = false,
  note = "";
const tagReads = new Map(),
  tagNotes = new Map();
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function link(text, href, className) {
  const element = node("a", text, className);
  element.href = href;
  element.target = "_blank";
  element.rel = "noopener noreferrer";
  return element;
}
function count(value) {
  return value >= 10000
    ? `${Number((value / 10000).toFixed(1))}万`
    : String(Math.floor(value));
}
function duration(value) {
  const seconds = Math.floor(value);
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function stat(value, label, symbol) {
  const element = node("span", `${symbol} ${count(value)}`);
  element.title = label;
  element.setAttribute("aria-label", `${label} ${count(value)}`);
  return element;
}
function card(row, open) {
  const article = node("article", undefined, "video-card");
  article.dataset.bvid = row.bvid;
  const url = `https://www.bilibili.com/video/${row.bvid}`;
  const cover = link(undefined, url, "cover");
  cover.setAttribute("aria-label", row.title);
  if (row.pic) {
    const image = node("img");
    image.src = row.pic;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    cover.append(image);
  }
  const stats = node("div", undefined, "cover-stats");
  if (Number.isFinite(row.views)) stats.append(stat(row.views, "播放量", "▷"));
  if (Number.isFinite(row.danmaku))
    stats.append(stat(row.danmaku, "弹幕数", "▤"));
  if (Number.isFinite(row.duration))
    stats.append(node("span", duration(row.duration), "duration"));
  cover.append(stats);
  const title = node("h3"),
    titleLink = link(row.title, url);
  titleLink.title = row.title;
  title.append(titleLink);
  const byline = node("p", undefined, "byline");
  if (/^\d+$/.test(row.uid || ""))
    byline.append(
      link(row.author || "UP 主", `https://space.bilibili.com/${row.uid}`),
    );
  else byline.append(document.createTextNode(row.author || "UP 主信息未提供"));
  if (
    Number.isFinite(row.pubdate) &&
    row.pubdate > 0 &&
    row.pubdate <= 4102444800
  )
    byline.append(
      document.createTextNode(
        " · " + new Date(row.pubdate * 1000).toLocaleDateString("zh-CN"),
      ),
    );
  const actions = node("div", undefined, "card-actions"),
    hide = node("button", row.hiddenReason ? "恢复" : "隐藏");
  hide.type = "button";
  hide.addEventListener("click", () => {
    note = "";
    if (row.hiddenReason && !session.hidden.has(row.bvid)) {
      note = "这条结果由排除词隐藏，请清除或修改排除标题词后恢复。";
      render();
    } else session.toggleHidden(row.bvid);
  });
  const clue = node(
    "span",
    row.hiddenReason
      ? "已隐藏"
      : row.clue === "matched"
        ? "有匹配线索"
        : "待确认",
    `clue ${row.clue}`,
  );
  actions.append(
    clue,
    hide,
    link(
      "下载 / 弹幕",
      chrome.runtime.getURL(`tools.html?id=${encodeURIComponent(row.bvid)}`),
    ),
  );
  const evidence = node("details", undefined, "evidence");
  evidence.open = open;
  evidence.append(
    node("summary", "查看线索"),
    node("p", row.hiddenReason || row.reason),
  );
  if (row.description) evidence.append(node("p", row.description));
  const tags = node("div", undefined, "tags");
  for (const tag of row.tags || []) tags.append(node("span", tag));
  evidence.append(tags);
  const lookup = node(
    "button",
    tagReads.has(row.bvid) ? "正在核对…" : "核对视频页标签",
  );
  lookup.type = "button";
  lookup.disabled = tagReads.has(row.bvid);
  lookup.addEventListener("click", () => lookupTags(row.bvid));
  evidence.append(lookup);
  if (tagNotes.has(row.bvid))
    evidence.append(node("p", tagNotes.get(row.bvid)));
  article.append(cover, title, byline, actions, evidence);
  return article;
}
function draftQueries() {
  return [
    ...new Set(
      [$("query").value, ...$("variants").value.split(/\n/)]
        .map((q) => q.trim())
        .filter(Boolean),
    ),
  ];
}
function conditionsChanged() {
  return (
    !!session.keyword &&
    ($("query").value.trim() !== session.keyword ||
      $("order").value !== session.order ||
      JSON.stringify(draftQueries()) !==
        JSON.stringify(session.queries.map((q) => q.keyword)))
  );
}
function render() {
  if (!ready) return;
  $("stop").disabled = !session.loading && !tagReads.size;
  $("more").disabled = session.loading || !session.hasMore;
  let selected,
    exclusionError = "",
    exclusions = $("exclusions").value;
  try {
    selected = session.selected($("filter").value, $("exclusions").value);
  } catch (error) {
    exclusionError = error.message + " 排除词有误，暂不应用；请修正排除词。";
    exclusions = "";
    selected = session.selected($("filter").value, exclusions);
  }
  const pages = Math.max(1, Math.ceil(selected.length / 20));
  currentPage = Math.min(Math.max(1, currentPage), pages);
  const open = new Set(
    [...document.querySelectorAll(".video-card:has(details[open])")].map(
      (el) => el.dataset.bvid,
    ),
  );
  $("results").replaceChildren(
    ...selected
      .slice((currentPage - 1) * 20, currentPage * 20)
      .map((row) => card(row, open.has(row.bvid))),
  );
  $("count").textContent = selected.length;
  $("empty").hidden = selected.length > 0;
  $("empty").querySelector("h3").textContent = !session.keyword
    ? "从一个搜索词开始"
    : session.loading
      ? "正在读取视频"
      : "当前没有可显示的结果";
  $("empty").querySelector("p").textContent = !session.keyword
    ? "视频会汇入同一个列表，翻页不会重复展示。"
    : session.pool.length
      ? "尝试切换显示范围或清除排除词，也可继续读取更多候选。"
      : "可重试读取、添加其他查询写法，或前往 B 站查看。";
  $("previous").disabled = currentPage === 1;
  $("next").disabled = currentPage === pages;
  const dirty = conditionsChanged();
  $("more").disabled = session.loading || !session.hasMore || dirty;
  const orderLabel = {
    totalrank: "综合排序",
    pubdate: "最新发布",
    click: "最多播放",
  };
  $("active-search").textContent = session.keyword
    ? `当前查询：${session.keyword} · 来源排序：${orderLabel[session.order]}${
        session.queries.length > 1
          ? " · 合并写法：" +
            session.queries
              .slice(1)
              .map((q) => q.keyword)
              .join("、")
          : ""
      }${dirty ? " · 条件已修改，请点击搜索后读取" : ""}`
    : "";
  $("more").textContent = session.error ? "重试读取" : "读取更多候选";
  $("stop").disabled = !session.loading && !tagReads.size;
  $("page-label").textContent = `第 ${currentPage} / ${pages} 页`;
  $("status").className = session.error || exclusionError ? "error" : "";
  const hidden = session.selected("hidden", exclusions).length;
  $("status").textContent = session.keyword
    ? `${session.loading ? "正在读取 · " : ""}已读取 ${session.pages} 个来源页 · 去重后 ${session.pool.length} 个视频 · ${hidden} 个已隐藏${!session.hasMore ? (session.pool.length >= LensSearch.LIMIT ? " · 已达 1,000 个候选上限" : " · 已读完或达到每种查询 20 页上限") : ""}${session.error ? " · " + session.error : note ? " · " + note : ""}`
    : note || "输入搜索词开始。首次使用时只申请 B 站数据接口权限。";
  if (exclusionError) $("status").textContent += " · " + exclusionError;
}
async function permission() {
  const request = { origins: ["https://api.bilibili.com/*"] };
  if (
    !(await chrome.permissions.contains(request)) &&
    !(await chrome.permissions.request(request))
  )
    throw new Error(
      "未授权 B 站数据接口。点击搜索可重新授权，也可前往 B 站搜索。",
    );
}
function stopTags() {
  tagReads.forEach((controller) => controller.abort());
  tagReads.clear();
}
async function lookupTags(bvid) {
  if (tagReads.has(bvid)) return;
  const generation = session.generation,
    controller = new AbortController();
  tagReads.set(bvid, controller);
  render();
  try {
    await permission();
    if (controller.signal.aborted || generation !== session.generation) return;
    const tags = await LensRpc.request(
      {
        op: "videoTags",
        id: bvid,
        token: "search-tags:" + crypto.randomUUID(),
      },
      { signal: controller.signal },
    );
    if (generation !== session.generation) return;
    tagNotes.set(
      bvid,
      "已核对视频页标签。标签是关联线索，不是内容相关性的保证。",
    );
    session.updateTags(bvid, tags);
  } catch (error) {
    if (generation === session.generation && error.name !== "AbortError")
      tagNotes.set(bvid, error.message);
  } finally {
    if (tagReads.get(bvid) === controller) tagReads.delete(bvid);
    render();
  }
}
let intent = 0;
$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const ownIntent = ++intent,
    keyword = $("query").value.trim(),
    order = $("order").value;
  const variants = $("variants")
    .value.split(/\n/)
    .map((q) => q.trim())
    .filter(Boolean);
  stopTags();
  session.stop();
  note = "";
  try {
    // Validate before asking permission or replacing the previous candidate pool.
    if (
      !keyword ||
      keyword.length > 200 ||
      variants.length > 2 ||
      variants.some((q) => q.length > 200)
    )
      throw new Error("请输入 1–200 字搜索词，最多添加两种查询写法");
    const rules = BiliSearchLens.compileRules(keyword, "", "related");
    if (rules.error) throw new Error(rules.error);
    await permission();
    if (intent !== ownIntent) return;
    tagNotes.clear();
    currentPage = 1;
    session.start(keyword, variants, order);
    const url = new URL(location.href);
    url.searchParams.set("q", keyword);
    url.searchParams.set("order", order);
    history.replaceState({}, "", url);
    $("original").href =
      "https://search.bilibili.com/video?keyword=" +
      encodeURIComponent(keyword);
    await session.load();
  } catch (error) {
    if (intent === ownIntent) {
      note = error.message;
      render();
    }
  }
});
$("more").addEventListener("click", () => {
  if (conditionsChanged()) return;
  note = "";
  session.load();
});
for (const id of ["query", "order", "variants"])
  $(id).addEventListener(id === "order" ? "change" : "input", render);
$("stop").addEventListener("click", () => {
  intent++;
  stopTags();
  note = "已停止，保留已经读取的结果；可继续读取。";
  session.stop();
});
for (const id of ["filter", "exclusions"])
  $(id).addEventListener(id === "filter" ? "change" : "input", () => {
    currentPage = 1;
    render();
  });
$("previous").addEventListener("click", () => {
  currentPage--;
  render();
  $("count").scrollIntoView({ block: "start" });
});
$("next").addEventListener("click", () => {
  currentPage++;
  render();
  $("count").scrollIntoView({ block: "start" });
});
window.addEventListener("pagehide", () => {
  intent++;
  stopTags();
  session.stop();
});
(async () => {
  try {
    const params = new URL(location.href).searchParams;
    $("query").value = (params.get("q") || "").slice(0, 200);
    if (["totalrank", "pubdate", "click"].includes(params.get("order")))
      $("order").value = params.get("order");
    await LensSettings.load();
  } catch (error) {
    note = error.message;
  }
  ready = true;
  render();
})();
