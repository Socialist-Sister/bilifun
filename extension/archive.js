(function (root) {
  "use strict";
  const table = Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes)
      value = table[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }
  function header(size) {
    const bytes = new Uint8Array(size);
    return { bytes, view: new DataView(bytes.buffer) };
  }
  function zip(files) {
    if (!Array.isArray(files) || files.length > 100)
      throw new Error("压缩包文件数量超出范围");
    const encoder = new TextEncoder(),
      parts = [],
      directory = [];
    const names = new Set();
    let offset = 0,
      total = 0;
    for (const file of files) {
      const name = String(file.name);
      if (
        !name ||
        names.has(name) ||
        /[\x00-\x1f:]/.test(name) ||
        name.includes("\\") ||
        name
          .split("/")
          .some((part) => part === ".." || part === "." || part === "") ||
        name.startsWith("/")
      )
        throw new Error("压缩包文件名无效");
      names.add(name);
      const filename = encoder.encode(name),
        data =
          typeof file.data === "string" ? encoder.encode(file.data) : file.data;
      if (!(data instanceof Uint8Array)) throw new Error("文件内容格式错误");
      if (filename.length > 65535) throw new Error("压缩包文件名过长");
      total += data.length;
      if (total > 30 * 1024 * 1024)
        throw new Error("导出超过 30 MB，请减少分 P");
      const checksum = crc(data),
        local = header(30 + filename.length),
        v = local.view;
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 0x800, true);
      v.setUint16(12, 33, true);
      v.setUint32(14, checksum, true);
      v.setUint32(18, data.length, true);
      v.setUint32(22, data.length, true);
      v.setUint16(26, filename.length, true);
      local.bytes.set(filename, 30);
      parts.push(local.bytes, data);
      const central = header(46 + filename.length),
        c = central.view;
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x800, true);
      c.setUint16(14, 33, true);
      c.setUint32(16, checksum, true);
      c.setUint32(20, data.length, true);
      c.setUint32(24, data.length, true);
      c.setUint16(28, filename.length, true);
      c.setUint32(42, offset, true);
      central.bytes.set(filename, 46);
      directory.push(central.bytes);
      offset += local.bytes.length + data.length;
    }
    const directorySize = directory.reduce(
        (sum, bytes) => sum + bytes.length,
        0,
      ),
      end = header(22),
      e = end.view;
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, files.length, true);
    e.setUint16(10, files.length, true);
    e.setUint32(12, directorySize, true);
    e.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end.bytes], {
      type: "application/zip",
    });
  }
  root.LensArchive = Object.freeze({ zip, crc });
  if (typeof module !== "undefined" && module.exports)
    module.exports = root.LensArchive;
})(globalThis);
