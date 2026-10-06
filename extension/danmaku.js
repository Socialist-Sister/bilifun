(function (root) {
  "use strict";
  const normalize = (value) =>
    String(value ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  class Reader {
    constructor(bytes) {
      this.bytes = bytes;
      this.pos = 0;
    }
    varint() {
      let result = 0n;
      for (let i = 0; i < 10; i++) {
        if (this.pos >= this.bytes.length) throw new Error("弹幕分包截断");
        const byte = this.bytes[this.pos++];
        if (i === 9 && byte > 1) throw new Error("弹幕整数超过 64 位");
        result |= BigInt(byte & 127) << BigInt(i * 7);
        if (!(byte & 128)) return result;
      }
      throw new Error("弹幕整数格式错误");
    }
    chunk() {
      const length = Number(this.varint());
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > this.bytes.length - this.pos
      )
        throw new Error("弹幕字段长度错误");
      const result = this.bytes.subarray(this.pos, this.pos + length);
      this.pos += length;
      return result;
    }
    skip(wire) {
      if (wire === 0) this.varint();
      else if (wire === 2) this.chunk();
      else if (wire === 1 || wire === 5) {
        this.pos += wire === 1 ? 8 : 4;
        if (this.pos > this.bytes.length) throw new Error("弹幕字段截断");
      } else throw new Error("未知弹幕字段编码");
    }
  }
  function decode(bytes) {
    const reader = new Reader(new Uint8Array(bytes)),
      rows = [];
    while (reader.pos < reader.bytes.length) {
      const tag = Number(reader.varint());
      if (tag !== 10) {
        reader.skip(tag & 7);
        continue;
      }
      const item = new Reader(reader.chunk()),
        row = {
          id: "",
          progress: 0,
          mode: 1,
          fontsize: 25,
          color: 0xffffff,
          content: "",
          midHash: "",
          ctime: 0,
        };
      while (item.pos < item.bytes.length) {
        const field = Number(item.varint()),
          key = field >>> 3,
          wire = field & 7;
        const names = {
          1: "id",
          2: "progress",
          3: "mode",
          4: "fontsize",
          5: "color",
          8: "ctime",
          9: "weight",
          11: "pool",
          13: "attr",
        };
        if (wire === 0 && names[key]) {
          const value = item.varint();
          row[names[key]] = key === 1 ? value.toString() : Number(value);
        } else if (wire === 2 && [6, 7, 10, 12, 14].includes(key)) {
          const value = new TextDecoder().decode(item.chunk());
          row[
            {
              6: "midHash",
              7: "content",
              10: "action",
              12: "idStr",
              14: "animation",
            }[key]
          ] = value;
        } else item.skip(wire);
      }
      row.id = row.idStr || row.id;
      delete row.idStr;
      rows.push(row);
      if (rows.length > 100000) throw new Error("弹幕分包超过处理上限");
    }
    return rows;
  }
  function validateRows(rows) {
    if (!Array.isArray(rows) || rows.length > 200000)
      throw new Error("弹幕列表格式错误或超过 20 万条");
    return rows.map((r, i) => {
      if (
        !r ||
        !Number.isFinite(Number(r.progress)) ||
        Number(r.progress) < 0 ||
        typeof r.content !== "string" ||
        r.content.length > 20000 ||
        (typeof r.id === "number" && !Number.isSafeInteger(r.id))
      )
        throw new Error(`第 ${i + 1} 条弹幕格式错误`);
      return {
        id: String(r.id || `local-${i}`),
        progress: Number(r.progress),
        content: r.content,
        mode: Number(r.mode) || 1,
        fontsize: Number(r.fontsize) || 25,
        color: Math.max(0, Math.min(0xffffff, Number(r.color) || 0)),
        midHash: String(r.midHash || ""),
        ctime: Number(r.ctime) || 0,
        pool: Number(r.pool) || 0,
        weight: Number(r.weight) || 0,
        attr: Number(r.attr) || 0,
        ...(typeof r.action === "string" ? { action: r.action } : {}),
        ...(typeof r.animation === "string" ? { animation: r.animation } : {}),
      };
    });
  }
  function dedupe(rows) {
    const ids = new Set();
    return rows
      .filter((r) => {
        const key = r.id || `${r.progress}:${r.mode}:${r.content}`;
        if (ids.has(key)) return false;
        ids.add(key);
        return true;
      })
      .sort((a, b) => a.progress - b.progress);
  }
  function terms(value) {
    const parsed = root.BiliSearchLens?.parseQuery(value);
    if (parsed) {
      if (parsed.error) throw new Error(parsed.error);
      return [...parsed.include, ...parsed.exclude].map(normalize);
    }
    return String(value || "")
      .split(/\n+/)
      .map(normalize)
      .filter(Boolean);
  }
  function filter(rows, options = {}) {
    if (
      !Array.isArray(options.regex || []) ||
      (options.regex || []).length > 100
    )
      throw new Error("正则规则最多 100 条");
    const blacklist = terms(options.exclusions),
      whitelist = terms(options.whitelist),
      windows = new Map(),
      kept = [],
      rejected = [];
    const regex = (options.regex || []).map((pattern) => {
      if (typeof pattern !== "string" || pattern.length > 200)
        throw new Error("正则表达式超过 200 字符");
      try {
        return new RegExp(pattern, "iu");
      } catch {
        throw new Error(`正则表达式无效：${pattern}`);
      }
    });
    for (const row of [...rows].sort((a, b) => a.progress - b.progress)) {
      const text = normalize(row.content);
      let reason = "";
      if (!whitelist.some((term) => text.includes(term))) {
        const hit = blacklist.find((term) => text.includes(term));
        if (hit) reason = `命中关键词：${hit}`;
        else if (regex.some((r) => r.test(row.content)))
          reason = "命中正则规则";
        else if ((options.blockedModes || []).includes(row.mode))
          reason = `弹幕类型：${row.mode}`;
        else if ((options.blockedColors || []).includes(row.color))
          reason = "命中颜色规则";
        else if (
          row.midHash &&
          (options.blockedSenders || []).includes(row.midHash)
        )
          reason = "命中发送者散列规则";
        else if (
          options.maxLength > 0 &&
          [...row.content].length > options.maxLength
        )
          reason = "超过长度限制";
        else if (options.duplicateLimit > 0 && options.duplicateWindow > 0) {
          const entries = (windows.get(text) || []).filter(
            (t) => row.progress - t <= options.duplicateWindow * 1000,
          );
          entries.push(row.progress);
          windows.set(text, entries);
          if (entries.length > options.duplicateLimit) reason = "重复刷屏";
        }
      }
      if (reason) rejected.push({ ...row, reason });
      else kept.push(row);
    }
    return { kept, rejected, total: rows.length };
  }
  const escapeXml = (text) =>
    String(text)
      .replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&apos;",
          })[c],
      )
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  function xml(rows, cid = "") {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<i><chatserver>chat.bilibili.com</chatserver><chatid>${escapeXml(cid)}</chatid>${rows.map((r) => `<d p="${[r.progress / 1000, r.mode, r.fontsize, r.color, r.ctime, r.pool || 0, r.midHash, r.id].map(escapeXml).join(",")}">${escapeXml(r.content)}</d>`).join("\n")}</i>`;
  }
  const assTime = (seconds) => {
    const n = Math.max(0, Math.round(seconds * 100));
    return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, "0")}:${String(Math.floor(n / 100) % 60).padStart(2, "0")}.${String(n % 100).padStart(2, "0")}`;
  };
  function ass(rows, options = {}) {
    const width = 1920,
      height = 1080,
      fontSize = Math.max(12, Math.min(72, Number(options.fontSize) || 25)),
      area = Math.max(0.1, Math.min(1, Number(options.area) || 0.5));
    const duration = 8 / (Number(options.speed) || 1),
      lanes = Math.max(1, Math.floor((height * area) / (fontSize * 1.5))),
      occupied = {
        1: Array(lanes).fill(-Infinity),
        4: Array(lanes).fill(-Infinity),
        5: Array(lanes).fill(-Infinity),
      };
    const opacity = Math.max(0, Math.min(1, Number(options.opacity) || 0.75)),
      alpha = Math.round((1 - opacity) * 255)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase();
    const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${fontSize},&H${alpha}FFFFFF,&H${alpha}FFFFFF,&H66000000,&HFF000000,0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
    let unsupported = 0,
      dropped = 0;
    const events = [];
    for (const row of [...rows].sort((a, b) => a.progress - b.progress)) {
      if (![1, 2, 3, 4, 5, 6].includes(row.mode)) {
        unsupported++;
        continue;
      }
      const kind = [4, 5].includes(row.mode) ? row.mode : 1,
        start = row.progress / 1000,
        length = [...row.content].length * fontSize * 0.7;
      const lane = occupied[kind].findIndex((t) => t <= start);
      if (lane < 0) {
        dropped++;
        continue;
      }
      // Keep the lane until the earlier comment leaves: conservative collision avoidance.
      occupied[kind][lane] = start + duration;
      const y =
        kind === 4
          ? height - (lane + 1) * fontSize * 1.5
          : lane * fontSize * 1.5 + fontSize;
      const color = Math.max(0, Math.min(0xffffff, row.color || 0))
        .toString(16)
        .padStart(6, "0");
      const bgr = color.slice(4, 6) + color.slice(2, 4) + color.slice(0, 2);
      const move =
        kind === 1
          ? row.mode === 6
            ? `\\move(${-length},${y},${width},${y})`
            : `\\move(${width},${y},${-length},${y})`
          : `\\an8\\pos(${width / 2},${y})`;
      const text = row.content
        .replace(/\\/g, "＼")
        .replace(/[{}]/g, (c) => (c === "{" ? "｛" : "｝"))
        .replace(/[\r\n]/g, "\\N")
        .replace(/[\x00-\x1f]/g, "");
      events.push(
        `Dialogue: 0,${assTime(start)},${assTime(start + duration)},Default,,0,0,0,,{${move}\\c&H${bgr}&}${text}`,
      );
    }
    return { text: header + events.join("\n"), unsupported, dropped };
  }
  function parseXml(text) {
    if (typeof DOMParser === "undefined")
      throw new Error("XML 导入需要浏览器环境");
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("XML 文件格式错误");
    return validateRows(
      [...doc.querySelectorAll("d[p]")].map((el, i) => {
        const p = el.getAttribute("p").split(",");
        return {
          id: p[7] || `xml-${i}`,
          progress: Number(p[0]) * 1000,
          mode: Number(p[1]),
          fontsize: Number(p[2]),
          color: Number(p[3]),
          ctime: Number(p[4]),
          pool: Number(p[5]) || 0,
          midHash: p[6] || "",
          content: el.textContent,
        };
      }),
    );
  }
  function parseAss(text) {
    const rows = [];
    const time = (value) => {
      const match = /^(\d+):(\d{2}):(\d{2})\.(\d{1,3})$/.exec(value.trim());
      if (!match) throw new Error("ASS 时间格式错误");
      return (
        (Number(match[1]) * 3600 +
          Number(match[2]) * 60 +
          Number(match[3]) +
          Number("0." + match[4])) *
        1000
      );
    };
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.startsWith("Dialogue:")) continue;
      const pieces = line.slice(9).split(",");
      if (pieces.length < 10) throw new Error("ASS 对话行格式错误");
      const content = pieces.slice(9).join(",");
      if (/\\p[1-9]/.test(content)) continue;
      const mode = /\\(?:pos|an[28])/.test(content) ? 5 : 1;
      rows.push({
        id: `ass-${rows.length}`,
        progress: time(pieces[1]),
        mode,
        fontsize: 25,
        color: 0xffffff,
        midHash: "",
        ctime: 0,
        content: content
          .replace(/\{[^}]*\}/g, "")
          .replace(/\\[Nn]/g, "\n")
          .replace(/\\h/g, " "),
      });
    }
    if (!rows.length)
      throw new Error("ASS 中没有可导入的普通文字对话；绘图及样式不参与转换");
    return validateRows(rows);
  }
  const api = {
    decode,
    validateRows,
    dedupe,
    filter,
    xml,
    ass,
    assTime,
    parseXml,
    parseAss,
  };
  root.LensDanmaku = Object.freeze(api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
