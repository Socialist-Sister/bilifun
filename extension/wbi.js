(function (root) {
  "use strict";
  // MD5 is used only for the site's request signature, never password storage.
  function md5(input) {
    const bytes = new TextEncoder().encode(input),
      length = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(length);
    padded.set(bytes);
    padded[bytes.length] = 128;
    const view = new DataView(padded.buffer);
    view.setUint32(length - 8, bytes.length * 8, true);
    view.setUint32(length - 4, Math.floor(bytes.length / 0x20000000), true);
    const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    let a0 = 0x67452301,
      b0 = 0xefcdab89,
      c0 = 0x98badcfe,
      d0 = 0x10325476;
    for (let offset = 0; offset < length; offset += 64) {
      let a = a0,
        b = b0,
        c = c0,
        d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g, shift;
        if (i < 16) {
          f = (b & c) | (~b & d);
          g = i;
          shift = shifts[i % 4];
        } else if (i < 32) {
          f = (d & b) | (~d & c);
          g = (5 * i + 1) % 16;
          shift = shifts[4 + (i % 4)];
        } else if (i < 48) {
          f = b ^ c ^ d;
          g = (3 * i + 5) % 16;
          shift = shifts[8 + (i % 4)];
        } else {
          f = c ^ (b | ~d);
          g = (7 * i) % 16;
          shift = shifts[12 + (i % 4)];
        }
        const sum =
          (a +
            f +
            Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) +
            view.getUint32(offset + g * 4, true)) |
          0;
        const old = d;
        d = c;
        c = b;
        b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
        a = old;
      }
      a0 = (a0 + a) | 0;
      b0 = (b0 + b) | 0;
      c0 = (c0 + c) | 0;
      d0 = (d0 + d) | 0;
    }
    return [a0, b0, c0, d0]
      .map((n) =>
        [0, 8, 16, 24]
          .map((s) => ((n >>> s) & 255).toString(16).padStart(2, "0"))
          .join(""),
      )
      .join("");
  }
  const permutation = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
  ];
  function sign(params, imgKey, subKey, now = Math.floor(Date.now() / 1000)) {
    if (!/^[\da-f]{32}$/.test(imgKey) || !/^[\da-f]{32}$/.test(subKey))
      throw new Error("无法获取 WBI 请求签名信息");
    const source = imgKey + subKey,
      mix = permutation
        .map((i) => source[i])
        .join("")
        .slice(0, 32);
    const values = { ...params, wts: now };
    const encoded = Object.keys(values)
      .sort()
      .map(
        (key) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g, ""))}`,
      )
      .join("&");
    return `${encoded}&w_rid=${md5(encoded + mix)}`;
  }
  const api = { md5, sign };
  root.LensWbi = Object.freeze(api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
