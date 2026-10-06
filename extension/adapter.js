(function (root) {
  "use strict";
  // Keep Bilibili-specific selectors here. Unknown layouts are left untouched.
  const CARD_SELECTOR =
    ".video-list-item, .bili-video-card, .video-item.matrix, .video-page-card-small, .small-item";
  const TITLE_SELECTOR =
    ".bili-video-card__info--tit, .bili-video-card__info--title, .title";
  // The all-search page wraps cards in a responsive column without video-list-item.
  // Hide the exclusive layout slot as well, leaving multi-content containers alone.
  function layoutElement(card) {
    let slot = card;
    for (let depth = 0; depth < 3; depth++) {
      const parent = slot.parentElement;
      if (
        !parent ||
        parent.children.length !== 1 ||
        parent.children[0] !== slot
      )
        break;
      const column = [...parent.classList].some((name) =>
        /^col(?:_|-)/.test(name),
      );
      const layout =
        parent.parentElement &&
        /^(?:flex|grid|inline-flex|inline-grid)$/.test(
          card.ownerDocument.defaultView.getComputedStyle(parent.parentElement)
            .display,
        );
      if (column || layout) slot = parent;
      else break;
    }
    return slot;
  }
  function isVideoLink(anchor) {
    try {
      const url = new URL(
        anchor.getAttribute("href"),
        "https://search.bilibili.com",
      );
      return (
        ["www.bilibili.com", "m.bilibili.com"].includes(url.hostname) &&
        /^\/video\/(?:BV[\w]+|av\d+)(?:\/|$)/i.test(url.pathname)
      );
    } catch {
      return false;
    }
  }
  function isPromotedLink(anchor) {
    try {
      const url = new URL(
        anchor.getAttribute("href"),
        "https://search.bilibili.com",
      );
      return (
        url.protocol === "https:" &&
        url.hostname === "cm.bilibili.com" &&
        url.pathname === "/cm/api/fees/pc/sync/v2"
      );
    } catch {
      return false;
    }
  }
  function collectCards(document) {
    const candidates = [...document.querySelectorAll(CARD_SELECTOR)];
    const cards = candidates.filter(
      (card) => !card.parentElement?.closest(CARD_SELECTOR),
    );
    return cards.flatMap((card) => {
      // The caller clears our hide markers before collection so website-hidden
      // cards (including responsive .to_hide_xs entries) stay out of statistics.
      if (
        !card.getClientRects().length ||
        document.defaultView.getComputedStyle(card).visibility === "hidden"
      )
        return [];
      const anchors = [...card.querySelectorAll("a[href]")].filter(isVideoLink);
      const titleNode = card.querySelector(TITLE_SELECTOR);
      const promoted =
        !anchors.length &&
        !!titleNode &&
        [...card.querySelectorAll("a[href]")].some(isPromotedLink);
      if (!anchors.length && !promoted) return [];
      const titleAnchor =
        anchors.find((anchor) =>
          normalizeTitle(anchor.getAttribute("title")),
        ) || anchors.find((anchor) => normalizeTitle(anchor.textContent));
      const title =
        normalizeTitle(titleNode?.getAttribute("title")) ||
        normalizeTitle(titleNode?.textContent) ||
        normalizeTitle(titleAnchor?.getAttribute("title")) ||
        normalizeTitle(titleAnchor?.textContent);
      const descriptionNode = card.querySelector(
        ".bili-video-card__info--desc, .video-descript, .description, .desc",
      );
      const description = normalizeTitle(
        descriptionNode?.getAttribute("title") ||
          descriptionNode?.textContent ||
          card.getAttribute("data-description"),
      ).slice(0, 2000);
      const tags = [
        ...card.querySelectorAll(
          ".bili-video-card__info--tag, .tag, [data-video-tag]",
        ),
      ]
        .slice(0, 20)
        .map((node) =>
          normalizeTitle(
            node.textContent || node.getAttribute("data-video-tag"),
          ).slice(0, 100),
        )
        .filter(Boolean);
      // Do not retain or reproduce promotion tracking URLs in our panel.
      const authorLink = card.querySelector('a[href*="space.bilibili.com/"]');
      const uid = /space\.bilibili\.com\/(\d+)/.exec(
        authorLink?.getAttribute("href") || "",
      )?.[1];
      const author =
        card
          .querySelector(".bili-video-card__info--author, .upname, .up-name")
          ?.textContent?.trim() ||
        authorLink?.textContent?.trim() ||
        "";
      const durationText = card
        .querySelector(".bili-video-card__stats__duration, .duration")
        ?.textContent?.trim();
      const duration = /^\d+:\d{2}(?::\d{2})?$/.test(durationText || "")
        ? durationText.split(":").reduce((sum, n) => sum * 60 + Number(n), 0)
        : undefined;
      const playText = card
        .querySelector(
          ".bili-video-card__stats--item .bili-video-card__stats--text, .play-text",
        )
        ?.textContent?.trim();
      const playMatch = /^(\d+(?:\.\d+)?)\s*(万|亿)?$/.exec(playText || "");
      const views = playMatch
        ? Number(playMatch[1]) *
          (playMatch[2] === "万"
            ? 10000
            : playMatch[2] === "亿"
              ? 100000000
              : 1)
        : undefined;
      return [
        {
          element: card,
          title,
          description,
          tags,
          url: promoted ? null : anchors[0].href,
          videoId: promoted
            ? null
            : /\/video\/(BV\w{8,22}|av\d{1,16})(?:\/|$)/.exec(
                new URL(anchors[0].href).pathname,
              )?.[1],
          promoted,
          uid,
          author,
          duration,
          views,
        },
      ];
    });
  }
  function normalizeTitle(value) {
    return String(value ?? "")
      .replace(/\s+/gu, " ")
      .trim();
  }
  function keywordFromUrl(url) {
    try {
      return new URL(url).searchParams.get("keyword") || "";
    } catch {
      return "";
    }
  }
  root.BiliSearchLensAdapter = Object.freeze({
    collectCards,
    keywordFromUrl,
    layoutElement,
    CARD_SELECTOR,
  });
  if (typeof module !== "undefined" && module.exports)
    module.exports = root.BiliSearchLensAdapter;
})(globalThis);
