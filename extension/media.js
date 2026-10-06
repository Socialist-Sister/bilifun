(function (root) {
  "use strict";
  const MEDIA_HOST =
    /(^|\.)(bilivideo\.com|bilivideo\.cn|bilivideo\.net|hdslb\.com|biliapi\.net)$/;
  function safeUrl(value, image = false) {
    const url = new URL(
      String(value).startsWith("//") ? `https:${value}` : value,
    );
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !MEDIA_HOST.test(url.hostname) ||
      (!image && /\.(png|jpe?g|webp)(?:$|\?)/i.test(url.pathname))
    )
      throw new Error("资源地址不属于已支持的 B 站 CDN");
    return url.href;
  }
  function videoFromUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      !["www.bilibili.com", "m.bilibili.com"].includes(url.hostname)
    )
      return null;
    const id = /^\/video\/(BV\w+|av\d+)(?:\/|$)/i.exec(url.pathname)?.[1];
    if (!id) return null;
    return {
      id,
      page: Math.max(
        1,
        Math.min(
          1000,
          Number.parseInt(url.searchParams.get("p") || "1", 10) || 1,
        ),
      ),
    };
  }
  function cleanName(value) {
    const text = String(value ?? "")
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .slice(0, 100)
      .replace(/[. ]+$/g, "");
    return !text || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(text)
      ? `_${text || "untitled"}`
      : text;
  }
  function filename(template, video, page, kind, extension) {
    const values = {
      title: video.title,
      bvid: video.bvid,
      user: video.owner?.name || "",
      page: String(page.page).padStart(2, "0"),
      part: page.part,
      kind,
    };
    const effectiveTemplate = template || "{title}/P{page}-{part}-{kind}";
    const pieces = String(effectiveTemplate)
      .split("/")
      .filter(Boolean)
      .slice(0, 3);
    const name = pieces
      .map((piece) =>
        cleanName(
          piece.replace(/\{(title|bvid|user|page|part|kind)\}/g, (_, key) =>
            cleanName(values[key]),
          ),
        ),
      )
      .join("/");
    return `${name}${String(effectiveTemplate).includes("{kind}") ? "" : "-" + cleanName(kind)}.${/^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin"}`;
  }
  function normalizeView(data) {
    if (
      !data ||
      !/^BV\w{8,22}$/.test(data.bvid) ||
      !Array.isArray(data.pages) ||
      !data.pages.length ||
      data.pages.some(
        (p) => !Number.isSafeInteger(Number(p.cid)) || Number(p.cid) <= 0,
      )
    )
      throw new Error("视频元数据结构不支持");
    return {
      bvid: data.bvid,
      aid: data.aid,
      title: String(data.title || data.bvid),
      pic: data.pic,
      duration: data.duration,
      pubdate: data.pubdate,
      tid: data.tid,
      owner: { mid: data.owner?.mid, name: String(data.owner?.name || "") },
      pages: data.pages
        .map((p, i) => ({
          cid: Number(p.cid),
          page: Number(p.page) || i + 1,
          part: String(p.part || `P${i + 1}`),
          duration: Number(p.duration) || 0,
        }))
        .filter((p) => Number.isSafeInteger(p.cid) && p.cid > 0),
    };
  }
  function normalizeStreams(data) {
    if (!data || data.is_drm || data.drm_tech_type > 0)
      throw new Error("不支持加密或受保护的媒体资源");
    const video = [],
      audio = [],
      direct = [];
    const formats = Array.isArray(data.support_formats)
      ? data.support_formats
      : [];
    // MCDN primaries can use unsupported ports or hosts while the same track
    // still has a conventional HTTPS CDN backup. Validate each candidate;
    // never drop a track just because its first address is unusable.
    function streamUrl(item) {
      const candidates = [
        item.baseUrl,
        item.base_url,
        item.url,
        ...(Array.isArray(item.backupUrl) ? item.backupUrl.slice(0, 8) : []),
        ...(Array.isArray(item.backup_url) ? item.backup_url.slice(0, 8) : []),
      ];
      for (const candidate of candidates) {
        if (typeof candidate !== "string" || !candidate) continue;
        try {
          return safeUrl(candidate);
        } catch {}
      }
      throw new Error("该轨道没有符合域名和 HTTPS 要求的地址");
    }
    function track(item, kind) {
      let url;
      try {
        url = streamUrl(item);
      } catch {
        return null;
      }
      const codec = String(item.codecs || item.codecid || "unknown");
      return {
        key: `${kind}:${item.id}:${codec}`,
        id: Number(item.id),
        kind,
        url,
        codec,
        bandwidth: Number(item.bandwidth) || 0,
        width: item.width,
        height: item.height,
        frameRate: item.frameRate || item.frame_rate,
        mime: item.mimeType || item.mime_type || "",
        extension: "m4s",
        label:
          kind === "video"
            ? `${formats.find((f) => f.quality === item.id)?.new_description || `${item.height || item.id}P`} · ${codec} · ${item.frameRate || item.frame_rate || "未知"} FPS`
            : `${Math.round((Number(item.bandwidth) || 0) / 1000)} kbps · ${codec}`,
      };
    }
    for (const item of data.dash?.video || []) {
      const value = track(item, "video");
      if (value) video.push(value);
    }
    for (const item of [
      ...(data.dash?.audio || []),
      ...(data.dash?.flac?.audio ? [data.dash.flac.audio] : []),
      ...(data.dash?.dolby?.audio || []),
    ]) {
      const value = track(item, "audio");
      if (value) audio.push(value);
    }
    for (const [index, item] of (data.durl || []).entries()) {
      let url;
      try {
        url = streamUrl(item);
      } catch {
        continue;
      }
      direct.push({
        key: `direct:${index}`,
        id: index,
        kind: "direct",
        url,
        extension: /flv/i.test(data.format) ? "flv" : "mp4",
        size: item.size || 0,
        label: `${data.durl.length > 1 ? "直连片段" : "直连视频"} ${index + 1}/${data.durl.length} · ${data.quality || ""}`,
        codec: String(data.video_codecid || "unknown"),
      });
    }
    if (!video.length && !audio.length && !direct.length)
      throw new Error("当前账号未获取到可下载轨道，或接口结构已经变化");
    return {
      video: video.sort(
        (a, b) =>
          (b.height || b.id) - (a.height || a.id) || b.bandwidth - a.bandwidth,
      ),
      audio: audio.sort((a, b) => b.bandwidth - a.bandwidth),
      direct,
      duration: (data.timelength || 0) / 1000,
      unavailableQualities: formats
        .filter(
          (f) =>
            Number.isInteger(Number(f.quality)) &&
            Number(f.quality) > 0 &&
            !video.some((t) => t.id === Number(f.quality)) &&
            !(direct.length && Number(data.quality) === Number(f.quality)),
        )
        .slice(0, 20)
        .map((f) => ({
          quality: Number(f.quality),
          label: String(f.new_description || f.display_desc || f.quality).slice(
            0,
            100,
          ),
        })),
    };
  }
  function subtitle(data, format = "srt") {
    if (!data || !Array.isArray(data.body)) throw new Error("字幕格式不支持");
    if (
      data.body.some(
        (item) =>
          !Number.isFinite(Number(item.from)) ||
          !Number.isFinite(Number(item.to)) ||
          Number(item.from) < 0 ||
          Number(item.to) < Number(item.from) ||
          typeof item.content !== "string",
      )
    )
      throw new Error("字幕时间或内容格式错误");
    if (format === "json") return JSON.stringify(data, null, 2);
    const timestamp = (seconds) => {
      const ms = Math.max(0, Math.round(Number(seconds) * 1000));
      return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${format === "vtt" ? "." : ","}${String(ms % 1000).padStart(3, "0")}`;
    };
    return (
      (format === "vtt" ? "WEBVTT\n\n" : "") +
      data.body
        .map(
          (item, i) =>
            `${i + 1}\n${timestamp(item.from)} --> ${timestamp(item.to)}\n${String(item.content).replace(/\r/g, "").replace(/-->/g, "→")}\n`,
        )
        .join("\n")
    );
  }
  function estimatedBytes(tracks, duration) {
    if (!Array.isArray(tracks)) return null;
    let total = 0;
    for (const track of tracks) {
      const size = Number(track.size),
        bandwidth = Number(track.bandwidth);
      if (Number.isFinite(size) && size > 0) total += size;
      else if (
        Number.isFinite(bandwidth) &&
        bandwidth > 0 &&
        Number.isFinite(duration) &&
        duration > 0
      )
        total += (bandwidth * duration) / 8;
      else return null;
    }
    return total > 0 ? Math.round(total) : null;
  }
  const api = {
    safeUrl,
    videoFromUrl,
    cleanName,
    filename,
    normalizeView,
    normalizeStreams,
    subtitle,
    estimatedBytes,
  };
  root.LensMedia = Object.freeze(api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
