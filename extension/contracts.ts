/** Shared contracts for contributors; production runtime stays plain JavaScript. */
export interface SearchOptions {
  wordBoundary?: boolean;
  segmentChinese?: boolean;
  synonyms?: string[][];
  blockedUploaders?: string[];
  allowedUploaders?: string[];
  blockedTitles?: string;
  hidePromotions?: boolean;
  minDuration?: number;
  maxDuration?: number;
  minViews?: number;
  afterDate?: string;
  allowedTids?: number[];
  useVideoTags?: boolean;
  fillPages?: boolean;
}
export interface Rules {
  include: string[];
  exclude: string[];
  mode: "all" | "any" | "related";
  error: string | null;
  options?: SearchOptions;
  relevance?: {
    models: { family: string; version: string }[];
    topics: string[];
  };
}
export interface VideoCard {
  title: string;
  description?: string;
  tags?: string[];
  uid?: string | number;
  author?: string;
  promoted?: boolean;
  duration?: number;
  views?: number;
  pubdate?: number;
  tid?: number;
}
export interface FilterDecision {
  keep: boolean;
  reason: string;
  unknown?: boolean;
  relevance?: "relevant" | "uncertain" | "unrelated";
  queryMismatch?: boolean;
}
export interface VideoPage {
  cid: number;
  page: number;
  part: string;
  duration: number;
}
export interface VideoMetadata {
  bvid: string;
  aid?: number;
  title: string;
  pic?: string;
  owner: { mid?: number; name: string };
  pages: VideoPage[];
}
export interface MediaTrack {
  key: string;
  kind: "video" | "audio" | "direct";
  url: string;
  codec: string;
  extension: string;
  label: string;
  bandwidth?: number;
}
export interface DanmakuRow {
  id: string;
  progress: number;
  content: string;
  mode: number;
  color: number;
  fontsize: number;
  midHash: string;
  ctime: number;
  pool?: number;
  weight?: number;
  attr?: number;
  action?: string;
  animation?: string;
}
export type TaskState =
  | "queued"
  | "resolving"
  | "downloading"
  | "paused"
  | "saved"
  | "failed"
  | "cancelled";
export interface DownloadTask {
  id: string;
  bvid: string;
  cid: number;
  trackKey: string;
  kind: MediaTrack["kind"];
  state: TaskState;
  relativeFilename: string;
  filename?: string;
  downloadId?: number;
  bytesReceived?: number;
  totalBytes?: number;
  error?: string;
}
export type Request =
  | MediaRequest
  | { op: "settingsLoad" }
  | { op: "settingsSave"; settings: unknown }
  | { op: "openSearch"; keyword?: string }
  | {
      op: "searchPage";
      keyword: string;
      page: number;
      order: "totalrank" | "pubdate" | "click";
      token: string;
    }
  | { op: "openTools"; url: string }
  | {
      op:
        "openSettings" | "tasks" | "clearTasks" | "diagnostics" | "clearCache";
    }
  | { op: "view"; id: string; token?: string }
  | { op: "tagStatus" }
  | { op: "videoTags"; id: string; token: string }
  | {
      op: "searchPageRecord";
      url: string;
      pageSize: number;
      rule: string;
      ids?: string[];
    }
  | {
      op: "refillPage";
      url: string;
      page: number;
      pageSize: number;
      token: string;
    }
  | { op: "segment"; cid: number; index: number; token?: string }
  | { op: "cancelRequest"; token: string }
  | { op: "seek"; bvid: string; cid?: number; time: number }
  | {
      op: "streams";
      bvid: string;
      cid: number;
      token?: string;
      refresh?: boolean;
    }
  | { op: "playerInfo"; bvid: string; cid: number; token?: string }
  | { op: "subtitle"; url: string }
  | {
      op: "search";
      keyword: string;
      page: number;
      order: "totalrank" | "pubdate" | "click";
    }
  | { op: "enqueue"; bvid: string; cid: number; keys: string[] }
  | {
      op: "taskAction";
      taskId: string;
      action: "pause" | "resume" | "cancel" | "retry" | "show" | "delete";
    };
export type Reply<T> = { ok: true; result: T } | { ok: false; error: string };
export interface MediaJob {
  id: string;
  kind: "merge" | "transcode" | "remux";
  engine?: "browser" | "legacy";
  videoTask?: string;
  audioTask?: string;
  videoKey?: string;
  audioKey?: string;
  downloadId?: number;
  outputBytes?: number;
  codecs?: string[];
  state:
    | "waiting"
    | "processing"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled";
  format: "mp4" | "mkv" | "mp3" | "aac" | "m4a";
  outputFilename?: string;
  progress?: {
    processedMs?: number;
    bytes?: number;
    speed?: string;
    percent?: number;
    phase?: string;
  };
}
export type MediaRequest =
  | {
      op: "enqueueVideo";
      engine?: "browser";
      bvid: string;
      cid: number;
      videoKey: string;
      audioKey: string;
      container: "mp4" | "mkv";
    }
  | { op: "mediaJobs" | "clearMediaJobs" }
  | {
      op: "enqueueAudio";
      bvid: string;
      cid: number;
      audioKey: string;
      format: "mp3" | "aac" | "m4a";
    }
  | {
      op: "enqueueLocal";
      localId: string;
      title: string;
      format: "mp4" | "mkv" | "mp3" | "aac" | "m4a";
    }
  | {
      op: "mediaAction";
      jobId: string;
      action: "cancel" | "retry" | "redownload" | "delete" | "show";
    };
