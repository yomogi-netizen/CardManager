import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";

/* =========================================================
    カード管理 (Web版)
   Swift版 ContentView.swift の機能に合わせて整理した実装
   ---------------------------------------------------------
   1. 定数 / ユーティリティ
   2. 色の変換 (Swift版 "r,g,b,a" 形式と互換)
   3. ローカル保存 (IndexedDB) と同期キュー
   4. 画像キャッシュ (Cache API)
   5. 共通UI部品
   6. 各モーダル
   7. App 本体
   ========================================================= */

/* ---------------------------------------------------------
   1. 定数 / ユーティリティ
   --------------------------------------------------------- */

const CATEGORIES = [
  "フルコーデ",
  "トップス",
  "ボトムス",
  "ワンピース",
  "シューズ",
  "アクセ",
  "その他",
];
const DEFAULT_RARITIES = ["PR", "SR", "R", "N", "SP"];
// Swift版のレアリティ順 (タイトルに登録が無いレアリティの並び替えに使用)
const RARITY_ORDER = ["PR", "SR", "R", "N", "SP"];
const MAX_COUNT = 99;
const NEW = "__NEW__";
const MAX_IMAGE_CACHE = 500 * 1024 * 1024;

const CARD_COLUMNS = [
  "id", "title_name", "name", "character_name", "pack_number",
  "card_number", "rarity", "background_color", "image_url",
  "back_image_url", "count", "target_count", "is_owned",
  "is_favorite", "memo", "category", "trade_type", "trade_count",
];
const TITLE_COLUMNS = [
  "id", "name", "packs", "rarities",
  "background_color", "simple_background_color",
];

const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

const uid = () =>
  globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 3) | 8).toString(16);
      });

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const toInt = (v, fallback = 0) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
};
const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const uniq = (list) => Array.from(new Set(list.filter(Boolean)));
const formatBytes = (bytes) => {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

// ---- モデルの正規化 (Swift版 Card / TitleInfo の decodeIfPresent 相当) ----

const normalizeCard = (c) => {
  const count = clamp(toInt(c.count), 0, MAX_COUNT);
  const tradeType = ["求", "譲"].includes(c.trade_type) ? c.trade_type : "なし";
  return {
    ...c,
    id: c.id || uid(),
    title_name: c.title_name || "",
    name: c.name || "",
    character_name: c.character_name || "",
    pack_number: c.pack_number || "",
    card_number: c.card_number || "",
    rarity: c.rarity || "",
    background_color: c.background_color || "default",
    image_url: c.image_url || "",
    back_image_url: c.back_image_url || "",
    count,
    target_count: Math.max(0, toInt(c.target_count)),
    is_owned: count > 0,
    is_favorite: Boolean(c.is_favorite),
    memo: c.memo || "",
    category: c.category || "フルコーデ",
    trade_type: tradeType,
    trade_count: tradeType === "なし" ? 0 : clamp(toInt(c.trade_count), 0, MAX_COUNT),
  };
};

const normalizeTitle = (t) => ({
  ...t,
  id: t.id || uid(),
  name: t.name || "",
  packs: Array.isArray(t.packs) ? t.packs : [],
  rarities: Array.isArray(t.rarities) ? t.rarities : [],
  background_color: t.background_color || "default",
  simple_background_color: t.simple_background_color || "default",
});

// Swift版の初期タイトル
const makeDefaultTitles = () =>
  ["タイトル1", "タイトル2"].map((name) =>
    normalizeTitle({
      name,
      packs: [1, 2, 3, 4, 5].map((n) => `${n}弾`),
      rarities: [...DEFAULT_RARITIES],
    })
  );

const packsOf = (titleInfos, titleName) =>
  titleInfos.find((t) => t.name === titleName)?.packs || [];
const raritiesOf = (titleInfos, titleName) => {
  const list = titleInfos.find((t) => t.name === titleName)?.rarities || [];
  return list.length > 0 ? list : DEFAULT_RARITIES;
};

/* ---------------------------------------------------------
   2. 色の変換
   Swift版は "r,g,b,a" (0〜1) 形式、旧Web版は "#rrggbb" 形式で保存。
   読み込みは両方に対応し、保存は Swift版が読める形式に統一する。
   --------------------------------------------------------- */

const SYSTEM_COLORS = {
  red: "#ff3b30", orange: "#ff9500", yellow: "#ffcc00", green: "#34c759",
  mint: "#00c7be", teal: "#30b0c7", cyan: "#32ade6", blue: "#007aff",
  indigo: "#5856d6", purple: "#af52de", pink: "#ff2d55", brown: "#a2845e",
  gray: "#8e8e93",
};

function parseColor(value) {
  if (!value || value === "default") return null;
  const v = String(value).trim().toLowerCase();
  if (v === "clear") return { r: 0, g: 0, b: 0, a: 0 };
  if (SYSTEM_COLORS[v]) return parseColor(SYSTEM_COLORS[v]);
  if (v.startsWith("#")) {
    let h = v.slice(1);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = parseInt(h.slice(0, 6), 16);
    if (Number.isNaN(n)) return null;
    const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  const m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(",").map(parseFloat);
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) {
      return { r: p[0], g: p[1], b: p[2], a: Number.isFinite(p[3]) ? p[3] : 1 };
    }
    return null;
  }
  const parts = v.split(",").map((s) => Number(s.trim()));
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    return {
      r: Math.round(parts[0] * 255),
      g: Math.round(parts[1] * 255),
      b: Math.round(parts[2] * 255),
      a: parts[3],
    };
  }
  return null;
}

const colorCss = (value, fallback = null) => {
  const c = parseColor(value);
  return c ? `rgba(${c.r},${c.g},${c.b},${+c.a.toFixed(3)})` : fallback;
};
const toHex = (c) =>
  "#" + [c.r, c.g, c.b].map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("");
const serializeColor = ({ hex, alpha }) => {
  const c = parseColor(hex);
  if (!c) return "default";
  const f = (x) => +(x / 255).toFixed(4);
  return `${f(c.r)},${f(c.g)},${f(c.b)},${+Number(alpha).toFixed(2)}`;
};
// 背景色の上に置く文字色 (白背景に白文字にならないようにする)
const readableText = (bg) => {
  const c = parseColor(bg);
  if (!c || c.a < 0.45) return "#1c1c1e";
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 160 ? "#1c1c1e" : "#ffffff";
};

/* ---------------------------------------------------------
   アプリ全体の背景 (設定画面から変更。端末ごとに保存)
   mode: default | color | gradient | image
   --------------------------------------------------------- */

const DEFAULT_UI_THEME = {
  panel: "1,1,1,0.86",
  panelStrong: "1,1,1,0.96",
  control: "0.47,0.47,0.5,0.13",
  controlOn: "1,1,1,0.96",
  line: "0.24,0.24,0.26,0.18",
  text: "0.11,0.11,0.12,1",
  sub: "0.43,0.43,0.45,1",
  cap: "0.45,0.45,0.48,1",
  accent: "0.32,0.32,0.36,0.92",
};

const DEFAULT_BG = {
  mode: "default",
  color: "0.95,0.85,0.9,1",
  from: "1,0.9,0.95,1",
  to: "0.85,0.88,1,1",
  angle: 160,
  imageUrl: "",
  overlay: "light",
  strength: 0.5,
  uiTheme: { ...DEFAULT_UI_THEME },
};

// 背景と共通UI配色をセットで持つプリセット。
// 背景を変更しても、UI色は勝手に変わらず、選んだプリセットの配色だけが適用される。
const BG_PRESETS = [
  {
    name: "さくら",
    from: "1,0.9,0.95,1", to: "0.95,0.8,0.92,1",
    uiTheme: { panel: "1,0.97,0.99,0.88", panelStrong: "1,0.96,0.99,0.97", control: "0.8,0.35,0.58,0.13", controlOn: "1,1,1,0.97", line: "0.65,0.3,0.5,0.18", text: "0.16,0.08,0.12,1", sub: "0.48,0.31,0.4,1", cap: "0.58,0.39,0.5,1", accent: "0.72,0.32,0.58,0.92" }
  },
  {
    name: "そら",
    from: "0.85,0.93,1,1", to: "0.75,0.82,1,1",
    uiTheme: { panel: "0.96,0.99,1,0.88", panelStrong: "0.96,0.99,1,0.97", control: "0.25,0.5,0.85,0.13", controlOn: "1,1,1,0.97", line: "0.25,0.48,0.78,0.18", text: "0.07,0.12,0.2,1", sub: "0.31,0.4,0.5,1", cap: "0.36,0.47,0.6,1", accent: "0.28,0.48,0.78,0.92" }
  },
  {
    name: "ミント",
    from: "0.85,1,0.93,1", to: "0.75,0.93,0.95,1",
    uiTheme: { panel: "0.96,1,0.98,0.88", panelStrong: "0.96,1,0.98,0.97", control: "0.15,0.6,0.5,0.13", controlOn: "1,1,1,0.97", line: "0.18,0.52,0.45,0.18", text: "0.06,0.15,0.13,1", sub: "0.3,0.45,0.42,1", cap: "0.34,0.52,0.48,1", accent: "0.20,0.55,0.48,0.92" }
  },
  {
    name: "ゆうやけ",
    from: "1,0.85,0.75,1", to: "0.95,0.7,0.85,1",
    uiTheme: { panel: "1,0.97,0.94,0.88", panelStrong: "1,0.96,0.93,0.97", control: "0.85,0.45,0.22,0.13", controlOn: "1,1,1,0.97", line: "0.72,0.35,0.2,0.18", text: "0.18,0.1,0.07,1", sub: "0.5,0.35,0.27,1", cap: "0.58,0.4,0.3,1", accent: "0.78,0.40,0.20,0.92" }
  },
  {
    name: "よぞら",
    from: "0.12,0.13,0.3,1", to: "0.3,0.15,0.4,1",
    uiTheme: { panel: "0.10,0.11,0.19,0.82", panelStrong: "0.14,0.15,0.24,0.94", control: "1,1,1,0.10", controlOn: "1,1,1,0.18", line: "1,1,1,0.16", text: "0.96,0.96,0.98,1", sub: "0.72,0.73,0.8,1", cap: "0.62,0.63,0.72,1", accent: "0.34,0.35,0.50,0.94" }
  },
];

// 背景レイヤーのスタイルと、背景が暗いか(=背景に直接置く文字を白にするか)を返す
function computeBg(input) {
  const bg = { ...DEFAULT_BG, ...(input || {}) };
  const lum = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  if (bg.mode === "color") {
    const c = parseColor(bg.color);
    if (c) return { layer: { background: colorCss(bg.color) }, dark: c.a >= 0.45 && lum(c) <= 160 };
  }
  if (bg.mode === "gradient") {
    const a = parseColor(bg.from);
    const b = parseColor(bg.to);
    if (a && b) {
      const angle = clamp(toInt(bg.angle, 160), 0, 360);
      return {
        layer: { background: `linear-gradient(${angle}deg, ${colorCss(bg.from)}, ${colorCss(bg.to)})` },
        dark: (lum(a) + lum(b)) / 2 <= 160,
      };
    }
  }
  if (bg.mode === "image") {
    const url = normalizeImageSrc(bg.imageUrl);
    if (url) {
      const dark = bg.overlay === "dark";
      const k = clamp(Number(bg.strength) || 0, 0, 0.9);
      const veil = dark ? `rgba(0,0,0,${k})` : `rgba(255,255,255,${k})`;
      const safe = url.replace(/["\\\n\r]/g, (ch) => encodeURIComponent(ch));
      return {
        layer: {
          backgroundImage: `linear-gradient(${veil}, ${veil}), url("${safe}")`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundColor: "#8e8e93",
        },
        dark,
      };
    }
  }
  return { layer: { background: "#f2f2f7" }, dark: false };
}

function resolveUiTheme(input) {
  const t = { ...DEFAULT_UI_THEME, ...(input || {}) };
  return {
    "--panel": colorCss(t.panel, "rgba(255,255,255,.86)"),
    "--panel-strong": colorCss(t.panelStrong, "rgba(255,255,255,.96)"),
    "--control": colorCss(t.control, "rgba(120,120,128,.13)"),
    "--control-on": colorCss(t.controlOn, "rgba(255,255,255,.96)"),
    "--line": colorCss(t.line, "rgba(60,60,67,.18)"),
    "--text": colorCss(t.text, "#1c1c1e"),
    "--sub": colorCss(t.sub, "#6e6e73"),
    "--cap": colorCss(t.cap, "#73737a"),
    "--accent-ui": colorCss(t.accent, "rgba(50,50,55,.92)"),
    colorScheme: (() => {
      const c = parseColor(t.panelStrong);
      return c && (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) < 160 ? "dark" : "light";
    })(),
  };
}

/* ---------------------------------------------------------
   3. ローカル保存 (IndexedDB) と同期キュー
   snapshots : スコープ(guest / user:<id>)ごとの cards, titleInfos
   sync_queue: 未同期の変更 (オフライン時・通信失敗時)
   --------------------------------------------------------- */

const DB_NAME = "aipri-card-manager";
const DB_VERSION = 4;
let dbPromise = null;

const getDB = () => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // 旧バージョンのストアは互換のため残す
        ["cards", "title_infos", "characters"].forEach((s) => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
        });
        if (!db.objectStoreNames.contains("sync_queue")) {
          db.createObjectStore("sync_queue", { keyPath: "queue_id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("snapshots")) {
          db.createObjectStore("snapshots", { keyPath: "scope" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // 別タブでのDB更新・削除を妨げないよう、要求されたら接続を閉じる
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
};

const idb = async (store, mode, run) => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let req;
    try {
      req = run(t.objectStore(store));
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};

const loadSnapshot = (scope) =>
  idb("snapshots", "readonly", (s) => s.get(scope)).then((r) => r || null).catch(() => null);
const saveSnapshot = (scope, data) =>
  idb("snapshots", "readwrite", (s) => s.put({ scope, ...data, saved_at: Date.now() })).catch((e) =>
    console.error("ローカル保存エラー:", e)
  );
const queueAll = () =>
  idb("sync_queue", "readonly", (s) => s.getAll()).then((r) => r || []).catch(() => []);
const queueDelete = (id) => idb("sync_queue", "readwrite", (s) => s.delete(id));
const queueAddMany = (items) =>
  idb("sync_queue", "readwrite", (s) => {
    let last;
    items.forEach((item) => {
      last = s.add(item);
    });
    return last;
  });

// 設定値を localStorage に保存する state
function useStoredState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return initial;
      const saved = { ...initial, ...JSON.parse(raw) };
      // 一括登録の画像URLは「URLの頭 + カードナンバリング + 末尾」に統一。
      if (key === "aipri.batchUrl") {
        if (typeof saved.frontHead === "string") saved.frontHead = saved.frontHead.replace(/abc-$/i, "");
        if (typeof saved.backHead === "string") saved.backHead = saved.backHead.replace(/abc-$/i, "");
      }
      return saved;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 保存できなくても動作は継続 */
    }
  }, [key, value]);
  return [value, setValue];
}

/* ---------------------------------------------------------
   4. 画像キャッシュ (Swift版 ImageCacheManager 相当)
   CORSで取得できた画像は Cache API に保存し、最大500MBを超えたら
   古いものから削除。取得できない場合はブラウザ標準の読み込みに任せる。
   --------------------------------------------------------- */

const IMAGE_CACHE = "card-image-cache-v1";

const imageCache = {
  supported: () => typeof caches !== "undefined",

  async get(url) {
    if (!this.supported()) return null;
    try {
      const cache = await caches.open(IMAGE_CACHE);
      const res = await cache.match(url);
      if (!res) return null;
      const blob = await res.blob();
      // 1日以上前のものは「最近使った」扱いに更新 (LRU)
      const cachedAt = Number(res.headers.get("x-cached-at") || 0);
      if (Date.now() - cachedAt > 86400000) this.put(url, blob, false);
      return blob;
    } catch {
      return null;
    }
  },

  async put(url, blob, trim = true) {
    if (!this.supported()) return;
    try {
      const cache = await caches.open(IMAGE_CACHE);
      await cache.put(
        url,
        new Response(blob, {
          headers: {
            "Content-Type": blob.type || "image/webp",
            "x-cached-at": String(Date.now()),
            "x-size": String(blob.size),
          },
        })
      );
      if (trim) this.trim();
    } catch {
      /* キャッシュ保存に失敗しても表示は継続 */
    }
  },

  async entries() {
    const cache = await caches.open(IMAGE_CACHE);
    const requests = await cache.keys();
    const rows = await Promise.all(
      requests.map(async (req) => {
        const res = await cache.match(req);
        return {
          req,
          size: Number(res?.headers.get("x-size") || 0),
          at: Number(res?.headers.get("x-cached-at") || 0),
        };
      })
    );
    return { cache, rows };
  },

  async size() {
    if (!this.supported()) return 0;
    try {
      const { rows } = await this.entries();
      return rows.reduce((sum, r) => sum + r.size, 0);
    } catch {
      return 0;
    }
  },

  async trim() {
    try {
      const { cache, rows } = await this.entries();
      let total = rows.reduce((sum, r) => sum + r.size, 0);
      if (total <= MAX_IMAGE_CACHE) return;
      for (const row of rows.sort((a, b) => a.at - b.at)) {
        if (total <= MAX_IMAGE_CACHE) break;
        await cache.delete(row.req);
        total -= row.size;
      }
    } catch {
      /* 無視 */
    }
  },

  async clear() {
    if (this.supported()) await caches.delete(IMAGE_CACHE);
  },
};

// Swift版と同じく、Base64文字列・dataURLも画像として扱う
const normalizeImageSrc = (value) => {
  const t = (value || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t) || t.startsWith("data:image/")) return t;
  if (/^[A-Za-z0-9+/=\s]{100,}$/.test(t)) return `data:image/png;base64,${t.replace(/\s/g, "")}`;
  return "";
};

/* ---------------------------------------------------------
   5. 共通UI部品
   --------------------------------------------------------- */

// 画像は常に横幅いっぱいに表示する (左右に余白を作らない)。
// natural=true: 縦横比のまま高さを自動調整 (見切れなし・左右余白なし) / それ以外: 枠いっぱいに表示 (トリミングあり)
function CachedImage({ src, alt = "", contain = false, natural = false }) {
  const source = normalizeImageSrc(src);
  const boxRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState({ url: null, failed: false });

  // 画面に近づいてから読み込む (大量のカードでも軽く動くように)
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    setState({ url: null, failed: false });
    if (!visible || !source) return undefined;
    if (source.startsWith("data:")) {
      setState({ url: source, failed: false });
      return undefined;
    }
    let cancelled = false;
    let objectUrl = null;
    (async () => {
      const cached = await imageCache.get(source);
      if (cached) {
        objectUrl = URL.createObjectURL(cached);
        if (!cancelled) setState({ url: objectUrl, failed: false });
        return;
      }
      try {
        const res = await fetch(source, { mode: "cors" });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) throw new Error("not image");
        imageCache.put(source, blob);
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setState({ url: objectUrl, failed: false });
      } catch {
        // CORS等で取得できない場合は通常の <img> で表示 (ブラウザのHTTPキャッシュを利用)
        if (!cancelled) setState({ url: source, failed: false });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, source]);

  return (
    <div ref={boxRef} className={`cimg${natural ? " natural" : ""}`}>
      {state.url && !state.failed ? (
        <img
          src={state.url}
          alt={alt}
          style={natural ? undefined : { objectFit: contain ? "contain" : "cover" }}
          onError={() => setState((s) => ({ ...s, failed: true }))}
        />
      ) : (
        <div className="cimg-empty">
          {!source ? "画像なし" : state.failed ? "読み込み失敗" : visible ? "…" : ""}
        </div>
      )}
    </div>
  );
}

// 最前面のモーダルだけが Esc で閉じるようにする
const modalStack = [];

function Modal({ title, onClose, children, footer, action, level = 0, size = "md" }) {
  const token = useRef({});
  useEffect(() => {
    const t = token.current;
    modalStack.push(t);
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape" && modalStack[modalStack.length - 1] === t) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      modalStack.splice(modalStack.indexOf(t), 1);
      if (modalStack.length === 0) document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="overlay" style={{ zIndex: 100 + level * 10 }} onMouseDown={onClose}>
      <div
        className={`modal ${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <button type="button" className="link" onClick={onClose}>
            閉じる
          </button>
          <h2>{title}</h2>
          <div className="modal-action">{action}</div>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

function Segmented({ options, value, onChange, className = "" }) {
  return (
    <div className={`seg ${className}`} role="tablist">
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={value === v}
            className={value === v ? "on" : ""}
            onClick={() => onChange(v)}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

const Field = ({ label, children, hint }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="hint">{hint}</span>}
  </label>
);

const TradeBadge = ({ card, big = false }) =>
  card.trade_type !== "なし" && card.trade_count > 0 ? (
    <span className={`trade ${card.trade_type === "求" ? "want" : "give"} ${big ? "big" : ""}`}>
      {card.trade_type} {card.trade_count}
    </span>
  ) : null;

function ColorField({ value, onChange, label }) {
  const c = parseColor(value);
  const isDefault = !c;
  const hex = c ? toHex(c) : "#ffffff";
  const alpha = c ? c.a : 1;
  return (
    <div className="colorfield">
      <div className="colorfield-main">
        {/* 角丸の四角そのものを押して色を選ぶ (ブラウザ標準の入力欄は透明にして重ねる) */}
        <span className="swatch-btn" style={{ background: colorCss(value, "#ffffff") }}>
          <input
            type="color"
            value={hex}
            aria-label={`${label}の色を選ぶ`}
            onChange={(e) => onChange(serializeColor({ hex: e.target.value, alpha }))}
          />
        </span>
        <span className="colorfield-name">{label}</span>
      </div>
      <div className="colorfield-alpha">
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(alpha * 100)}
          disabled={isDefault}
          aria-label={`${label}の不透明度`}
          onChange={(e) => onChange(serializeColor({ hex, alpha: Number(e.target.value) / 100 }))}
        />
        <span className="hint">{isDefault ? "デフォルト" : `不透明度 ${Math.round(alpha * 100)}%`}</span>
      </div>
      <button type="button" className="ghost" disabled={isDefault} onClick={() => onChange("default")}>
        デフォルトに戻す
      </button>
    </div>
  );
}

/* ---------------------------------------------------------
   6. 各モーダル
   --------------------------------------------------------- */

// ---- ログイン / 新規登録 ----
function LoginModal({ onClose, onNotice }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("メールアドレスとパスワードを入力してください");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") {
        const { error: err } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (err) throw err;
        onClose();
      } else {
        if (password.length < 6) throw new Error("パスワードは6文字以上にしてください");
        const { data, error: err } = await supabase.auth.signUp({ email: email.trim(), password });
        if (err) throw err;
        if (data.session) {
          onClose();
        } else {
          onNotice("確認メールを送信しました。メール内のリンクを開いてからログインしてください");
          setMode("login");
        }
      }
    } catch (err) {
      setError(
        /invalid login/i.test(err.message)
          ? "メールアドレスまたはパスワードが正しくありません"
          : err.message || "ログインに失敗しました"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={mode === "login" ? "ログイン" : "新規登録"} onClose={onClose} size="sm">
      <form className="stack" onSubmit={submit}>
        <p className="hint">
          ログインすると、カード情報がクラウドに保存され、複数の端末で共有できます。
        </p>
        <Field label="メールアドレス">
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="パスワード">
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "処理中…" : mode === "login" ? "ログイン" : "登録する"}
        </button>
        <button
          type="button"
          className="link center"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError("");
          }}
        >
          {mode === "login" ? "アカウントを作成する" : "ログインに戻る"}
        </button>
      </form>
    </Modal>
  );
}

// ---- カード追加 / 編集フォーム ----
function CardForm({
  mode, initial, titleInfos, knownCharacters, template, onTemplateChange,
  onSubmit, onDelete, onClose, onManage, onBatch,
}) {
  const [f, setF] = useState(() => {
    const titleName = initial?.title_name || titleInfos[0]?.name || "";
    const packs = packsOf(titleInfos, titleName);
    const rars = raritiesOf(titleInfos, titleName);
    const bg = parseColor(initial?.background_color);
    return {
      title_name: titleName,
      pack: initial ? initial.pack_number : packs[0] || "",
      customPack: "",
      rarity: initial ? initial.rarity : rars[0] || NEW,
      customRarity: "",
      name: initial?.name || "",
      character_name: initial?.character_name || "",
      card_number: initial?.card_number || "",
      category: initial?.category || "フルコーデ",
      count: initial ? initial.count : 1,
      target_count: initial ? initial.target_count : 1,
      trade_type: initial?.trade_type || "なし",
      trade_count: initial?.trade_count || 0,
      is_favorite: Boolean(initial?.is_favorite),
      background_color: initial?.background_color || "default",
      memo: initial?.memo || "",
      image_url: initial?.image_url || "",
      back_image_url: initial?.back_image_url || "",
    };
  });
  const [error, setError] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  // タイトルが後から読み込まれた場合は、先頭のタイトルを自動で選ぶ
  useEffect(() => {
    if (!f.title_name && titleInfos[0]) {
      setF((p) => ({
        ...p,
        title_name: titleInfos[0].name,
        pack: packsOf(titleInfos, titleInfos[0].name)[0] || "",
        rarity: raritiesOf(titleInfos, titleInfos[0].name)[0] || NEW,
      }));
    }
  }, [f.title_name, titleInfos]);

  const packs = packsOf(titleInfos, f.title_name);
  const rarities = raritiesOf(titleInfos, f.title_name);
  const packChoices = uniq([...packs, f.pack !== NEW ? f.pack : ""]);
  const rarityChoices = uniq([...rarities, f.rarity !== NEW ? f.rarity : ""]);

  const changeTitle = (name) =>
    setF((p) => {
      const np = packsOf(titleInfos, name);
      const nr = raritiesOf(titleInfos, name);
      return {
        ...p,
        title_name: name,
        pack: np.includes(p.pack) ? p.pack : np[0] || "",
        customPack: "",
        rarity: nr.includes(p.rarity) ? p.rarity : nr[0] || NEW,
        customRarity: "",
      };
    });

  const generateURLs = () => {
    const number = f.card_number.trim();
    if (!number) {
      setError("先にカード番号を入力してください");
      return;
    }
    setError("");
    setF((p) => ({
      ...p,
      image_url: template.frontHead + number + template.frontTail,
      back_image_url: template.backHead + number + template.backTail,
    }));
  };

  const submit = () => {
    const name = f.name.trim();
    if (!f.title_name) return setError("タイトルを選択してください（先にタイトルを追加してください）");
    if (!name) return setError("カード名を入力してください");

    let pack = f.pack;
    let newPack = null;
    if (pack === NEW) {
      pack = f.customPack.trim();
      if (!pack) return setError("新しい弾名を入力してください");
      if (!packs.includes(pack)) newPack = pack;
    }
    let rarity = f.rarity;
    let newRarity = null;
    if (rarity === NEW) {
      rarity = f.customRarity.trim();
      if (!rarity) return setError("新しいレアリティ名を入力してください");
      if (!rarities.includes(rarity)) newRarity = rarity;
    }

    onSubmit(
      {
        ...(initial || {}),
        id: initial?.id || uid(),
        title_name: f.title_name,
        name,
        character_name: f.character_name.trim(),
        pack_number: pack,
        card_number: f.card_number.trim(),
        rarity,
        count: clamp(toInt(f.count), 0, MAX_COUNT),
        target_count: Math.max(0, toInt(f.target_count)),
        is_favorite: f.is_favorite,
        memo: f.memo,
        category: f.category,
        trade_type: f.trade_type,
        trade_count: f.trade_type === "なし" ? 0 : clamp(toInt(f.trade_count), 0, MAX_COUNT),
        background_color: f.background_color,
        image_url: f.image_url.trim(),
        back_image_url: f.back_image_url.trim(),
      },
      { newPack, newRarity }
    );
  };

  return (
    <Modal
      title={mode === "add" ? "カード追加" : "カード編集"}
      onClose={onClose}
      level={1}
      action={
        <button type="button" className="link strong" onClick={submit}>
          {mode === "add" ? "追加" : "保存"}
        </button>
      }
    >
      <div className="stack">
        {error && <div className="error">{error}</div>}

        <section className="group-box">
          <h3>画像URL設定</h3>
          <Field label="表面画像URL">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              placeholder="https://..."
              value={f.image_url}
              onChange={(e) => set("image_url", e.target.value)}
            />
          </Field>
          <Field label="裏面画像URL">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              placeholder="https://..."
              value={f.back_image_url}
              onChange={(e) => set("back_image_url", e.target.value)}
            />
          </Field>
          <div className="preview-row">
            <div className="thumb-preview">
              <CachedImage natural src={f.image_url} alt="表面プレビュー" />
            </div>
            <div className="thumb-preview">
              <CachedImage natural src={f.back_image_url} alt="裏面プレビュー" />
            </div>
          </div>
          <details className="details">
            <summary>カード番号からURLを自動生成</summary>
            <div className="stack">
              <p className="hint">「URLの頭 + カード番号 + URLの末尾」で作成します。設定は保存されます。</p>
              <Field label="表面：URLの頭">
                <input
                  value={template.frontHead}
                  autoCapitalize="none"
                  onChange={(e) => onTemplateChange({ ...template, frontHead: e.target.value })}
                />
              </Field>
              <Field label="表面：URLの末尾">
                <input
                  value={template.frontTail}
                  autoCapitalize="none"
                  onChange={(e) => onTemplateChange({ ...template, frontTail: e.target.value })}
                />
              </Field>
              <Field label="裏面：URLの頭">
                <input
                  value={template.backHead}
                  autoCapitalize="none"
                  onChange={(e) => onTemplateChange({ ...template, backHead: e.target.value })}
                />
              </Field>
              <Field label="裏面：URLの末尾">
                <input
                  value={template.backTail}
                  autoCapitalize="none"
                  onChange={(e) => onTemplateChange({ ...template, backTail: e.target.value })}
                />
              </Field>
              <button type="button" className="secondary" onClick={generateURLs}>
                URLを生成して入力
              </button>
            </div>
          </details>
        </section>

        <section className="group-box">
          <h3>タイトル &amp; 弾数設定</h3>
          <Field label="タイトル">
            <select value={f.title_name} onChange={(e) => changeTitle(e.target.value)}>
              {titleInfos.length === 0 && <option value="">タイトルがありません</option>}
              {titleInfos.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="弾数">
            <select value={f.pack} onChange={(e) => set("pack", e.target.value)}>
              <option value="">未設定</option>
              {packChoices.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              <option value={NEW}>＋ 新しく追加</option>
            </select>
          </Field>
          {f.pack === NEW && (
            <Field label="新しい弾数名">
              <input
                value={f.customPack}
                placeholder="例：7弾、プロモ"
                onChange={(e) => set("customPack", e.target.value)}
              />
            </Field>
          )}
          <button type="button" className="link" onClick={() => onManage(f.title_name, "packs")}>
            弾数を整理 ›
          </button>
        </section>

        <section className="group-box">
          <h3>カード情報</h3>
          <Field label="カード名">
            <input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="カード名" />
          </Field>
          <Field label="キャラクター名">
            <input
              list="character-list"
              value={f.character_name}
              onChange={(e) => set("character_name", e.target.value)}
              placeholder="キャラクター名"
            />
            <datalist id="character-list">
              {knownCharacters.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="カード番号">
            <input
              value={f.card_number}
              autoCapitalize="characters"
              autoCorrect="off"
              onChange={(e) => set("card_number", e.target.value)}
              placeholder="例：ABC-001"
            />
          </Field>
          <Field label="コーデ部位">
            <select value={f.category} onChange={(e) => set("category", e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="レアリティ">
            <select value={f.rarity} onChange={(e) => set("rarity", e.target.value)}>
              <option value="">未設定</option>
              {rarityChoices.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value={NEW}>＋ 新しく追加</option>
            </select>
          </Field>
          {f.rarity === NEW && (
            <Field label="新しいレアリティ名">
              <input value={f.customRarity} onChange={(e) => set("customRarity", e.target.value)} />
            </Field>
          )}
          <button type="button" className="link" onClick={() => onManage(f.title_name, "rarities")}>
            レアリティを整理 ›
          </button>
        </section>

        <section className="group-box">
          <h3>枚数</h3>
          <div className="row2">
            <Field label="所持枚数">
              <input
                type="number"
                inputMode="numeric"
                min="0"
                max={MAX_COUNT}
                value={f.count}
                onChange={(e) => set("count", e.target.value)}
              />
            </Field>
            <Field label="目標枚数">
              <input
                type="number"
                inputMode="numeric"
                min="0"
                value={f.target_count}
                onChange={(e) => set("target_count", e.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="group-box">
          <h3>交換</h3>
          <Segmented
            options={["なし", "求", "譲"]}
            value={f.trade_type}
            onChange={(v) =>
              setF((p) => ({
                ...p,
                trade_type: v,
                trade_count: v === "なし" ? 0 : p.trade_count || 1,
              }))
            }
          />
          {f.trade_type !== "なし" && (
            <Field label={`${f.trade_type} の枚数`}>
              <input
                type="number"
                inputMode="numeric"
                min="0"
                max={MAX_COUNT}
                value={f.trade_count}
                onChange={(e) => set("trade_count", e.target.value)}
              />
            </Field>
          )}
        </section>

        <section className="group-box">
          <h3>その他</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={f.is_favorite}
              onChange={(e) => set("is_favorite", e.target.checked)}
            />
            お気に入りに追加
          </label>
          <Field label="カード背景色">
            <ColorField
              label="カード背景色"
              value={f.background_color}
              onChange={(v) => set("background_color", v)}
            />
          </Field>
          <Field label="メモ">
            <textarea
              rows={4}
              value={f.memo}
              onChange={(e) => set("memo", e.target.value)}
              placeholder="補足情報など"
            />
          </Field>
        </section>

        {mode === "add" && (
          <button type="button" className="secondary" onClick={() => onBatch(f.title_name)}>
            連番でまとめて登録する（一括登録）
          </button>
        )}
        {mode === "edit" && (
          <button type="button" className="danger" onClick={onDelete}>
            このカードを削除
          </button>
        )}
      </div>
    </Modal>
  );
}

// ---- カード一括登録 (Swift版 BatchAddCardView) ----
function BatchAddModal({ titleInfos, cards, initialTitle, knownCharacters, onSubmit, onClose, onManage }) {
  const [title, setTitle] = useState(initialTitle || titleInfos[0]?.name || "");
  const [url, setUrl] = useStoredState("aipri.batchUrl", {
    frontHead: "https://...", frontTail: ".webp", backHead: "https://...", backTail: ".webp",
  });
  const packs = packsOf(titleInfos, title);
  const rarities = raritiesOf(titleInfos, title);
  const [pack, setPack] = useState(packs[0] || "");
  const [rarity, setRarity] = useState(rarities[0] || "");
  const [head, setHead] = useState("");
  const [tail, setTail] = useState("");
  const [start, setStart] = useState("001");
  const [end, setEnd] = useState("010");
  const [character, setCharacter] = useState("");
  const [category, setCategory] = useState("その他");
  const [error, setError] = useState("");

  const changeTitle = (name) => {
    setTitle(name);
    setPack(packsOf(titleInfos, name)[0] || "");
    setRarity(raritiesOf(titleInfos, name)[0] || "");
  };

  // 01〜09 のような2桁、001〜010 のような3桁の両方に対応。
  // 入力した桁数をそのままカードナンバリングの桁数として使用する。
  const startText = start.trim();
  const endText = end.trim();
  const digits = Math.max(startText.length, endText.length, 1);
  const isNumberText = (value) => /^\d+$/.test(value);
  const pad = (n) => String(n).padStart(digits, "0");
  const startN = isNumberText(startText) ? Number(startText) : Number.NaN;
  const endN = isNumberText(endText) ? Number(endText) : Number.NaN;
  const valid = Number.isFinite(startN) && Number.isFinite(endN) && startN <= endN;

  const submit = () => {
    if (!title) return setError("タイトルを選択してください");
    if (!isNumberText(startText)) return setError("開始番号を数字で入力してください。例：01 または 001");
    if (!isNumberText(endText)) return setError("終了番号を数字で入力してください。例：09 または 010");
    if (startN > endN) return setError("開始番号は終了番号以下にしてください。");
    if (endN - startN + 1 > 500) return setError("一度に登録できるのは500枚までです。");

    const existing = new Set(
      cards.filter((c) => c.title_name === title).map((c) => c.card_number)
    );
    const list = [];
    let skipped = 0;
    for (let n = startN; n <= endN; n += 1) {
      const numberText = pad(n);
      const cardNumber = `${head}${numberText}${tail}`;
      if (existing.has(cardNumber)) {
        skipped += 1;
        continue;
      }
      existing.add(cardNumber);
      list.push({
        id: uid(),
        title_name: title,
        name: cardNumber,
        character_name: character.trim(),
        pack_number: pack || packs[0] || "1弾",
        card_number: cardNumber,
        rarity,
        count: 0,
        target_count: 0,
        is_favorite: false,
        image_url: url.frontHead + cardNumber + url.frontTail,
        back_image_url: url.backHead + cardNumber + url.backTail,
        memo: "",
        category,
        trade_type: "なし",
        trade_count: 0,
        background_color: "default",
      });
    }
    onSubmit(list, skipped);
  };

  return (
    <Modal title="カード一括登録" onClose={onClose} level={2}>
      <div className="stack">
        {error && <div className="error">{error}</div>}
        <section className="group-box">
          <h3>登録先</h3>
          <Field label="タイトル">
            <select value={title} onChange={(e) => changeTitle(e.target.value)}>
              {titleInfos.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="弾数">
            <select value={pack} onChange={(e) => setPack(e.target.value)}>
              {packs.length === 0 && <option value="">（弾がありません）</option>}
              {packs.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <button type="button" className="link" onClick={() => onManage(title, "packs")}>
            弾数を整理 ›
          </button>
        </section>

        <section className="group-box">
          <h3>カードナンバリング</h3>
          <Field label="番号の頭">
            <input value={head} placeholder="例：abc-" autoCapitalize="characters" onChange={(e) => setHead(e.target.value)} />
          </Field>
          <div className="row2">
            <Field label="開始番号">
              <input value={start} inputMode="numeric" onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="終了番号">
              <input value={end} inputMode="numeric" onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <Field label="番号の末尾（任意）">
            <input value={tail} autoCapitalize="characters" onChange={(e) => setTail(e.target.value)} />
          </Field>
          <p className="hint">
            完成例：{head}
            {valid ? pad(startN) : start}
            {tail}
            {valid && endN > startN ? ` 〜 ${head}${pad(endN)}${tail}（${endN - startN + 1}枚）` : ""}
          </p>
        </section>

        <section className="group-box">
          <h3>画像URL（頭 + カードナンバリング + 末尾）</h3>
          <Field label="表面：URLの頭">
            <input value={url.frontHead} autoCapitalize="none" onChange={(e) => setUrl({ ...url, frontHead: e.target.value })} />
          </Field>
          <Field label="表面：URLの末尾">
            <input value={url.frontTail} autoCapitalize="none" onChange={(e) => setUrl({ ...url, frontTail: e.target.value })} />
          </Field>
          <Field label="裏面：URLの頭">
            <input value={url.backHead} autoCapitalize="none" onChange={(e) => setUrl({ ...url, backHead: e.target.value })} />
          </Field>
          <Field label="裏面：URLの末尾">
            <input value={url.backTail} autoCapitalize="none" onChange={(e) => setUrl({ ...url, backTail: e.target.value })} />
          </Field>
          <p className="hint">完成例：{url.frontHead}{valid ? `${head}${pad(startN)}${tail}` : `${head || "abc-"}001${tail}`}{url.frontTail}</p>
        </section>

        <section className="group-box">
          <h3>カード情報（共通）</h3>
          <Field label="キャラ名">
            <input list="character-list-batch" value={character} onChange={(e) => setCharacter(e.target.value)} />
            <datalist id="character-list-batch">
              {knownCharacters.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="コーデ部位">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="レアリティ">
            <select value={rarity} onChange={(e) => setRarity(e.target.value)}>
              {uniq([...rarities, rarity]).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
        </section>

        <button type="button" className="primary" onClick={submit}>
          一括登録
        </button>
      </div>
    </Modal>
  );
}

// ---- 弾数・レアリティの整理 (Swift版 ManageItemsView + BatchAddPackView) ----
function ManageModal({ titleInfos, initialTitleId, initialTab, onChangeTitle, onClose, level = 2 }) {
  const [titleId, setTitleId] = useState(initialTitleId || titleInfos[0]?.id || "");
  const [tab, setTab] = useState(initialTab || "packs");
  const [item, setItem] = useState("");
  const [range, setRange] = useState({ start: 1, end: 10, suffix: "弾" });
  const [error, setError] = useState("");

  const title = titleInfos.find((t) => t.id === titleId);
  const isPacks = tab === "packs";
  const list = title ? (isPacks ? title.packs : title.rarities) : [];
  const usingDefault = !isPacks && title && list.length === 0;
  const label = isPacks ? "弾" : "レアリティ";

  const update = (next) => onChangeTitle(titleId, { [tab]: next });

  const add = () => {
    const name = item.trim();
    if (!name) return;
    if (list.includes(name)) return setError(`同じ${label}がすでにあります`);
    setError("");
    update([...(usingDefault ? DEFAULT_RARITIES : list), name].filter((v, i, a) => a.indexOf(v) === i));
    setItem("");
  };

  const remove = (name) => {
    if (window.confirm(`「${title.name}」の「${name}」を削除しますか？\n（登録済みのカードは削除されません）`)) {
      update(list.filter((v) => v !== name));
    }
  };

  const move = (index, dir) => {
    const next = [...list];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    update(next);
  };

  const generate = () => {
    const s = toInt(range.start, 1);
    const e = toInt(range.end, 1);
    if (s > e) return setError("開始番号は終了番号以下にしてください");
    if (e - s > 200) return setError("一度に生成できるのは200件までです");
    const names = [];
    for (let n = s; n <= e; n += 1) names.push(`${n}${range.suffix}`);
    setError("");
    update([...list, ...names.filter((n) => !list.includes(n))]);
  };

  return (
    <Modal title={`${label}の管理`} onClose={onClose} level={level}>
      <div className="stack">
        {error && <div className="error">{error}</div>}
        <Field label="タイトル">
          <select value={titleId} onChange={(e) => setTitleId(e.target.value)}>
            {titleInfos.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Segmented
          options={[
            { value: "packs", label: "弾数" },
            { value: "rarities", label: "レアリティ" },
          ]}
          value={tab}
          onChange={(v) => {
            setTab(v);
            setError("");
          }}
        />

        {!title ? (
          <p className="hint">タイトルがありません。先にタイトルを追加してください。</p>
        ) : (
          <>
            <div className="inline-add">
              <input
                value={item}
                placeholder={isPacks ? "弾数名（例：プロモ、SP）" : "新しいレアリティ"}
                onChange={(e) => setItem(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
              <button type="button" className="secondary" onClick={add}>
                追加
              </button>
            </div>

            {isPacks && (
              <details className="details">
                <summary>番号を指定してまとめて生成</summary>
                <div className="stack">
                  <div className="row3">
                    <Field label="開始">
                      <input type="number" min="1" value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} />
                    </Field>
                    <Field label="終了">
                      <input type="number" min="1" value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} />
                    </Field>
                    <Field label="単位">
                      <input value={range.suffix} onChange={(e) => setRange({ ...range, suffix: e.target.value })} />
                    </Field>
                  </div>
                  <button type="button" className="secondary" onClick={generate}>
                    一括生成して追加
                  </button>
                </div>
              </details>
            )}

            {usingDefault && (
              <div className="hint box">
                このタイトルにはレアリティが登録されていないため、既定の一覧
                （{DEFAULT_RARITIES.join(" / ")}）を使用しています。
                <button type="button" className="ghost" onClick={() => update([...DEFAULT_RARITIES])}>
                  既定の一覧を登録して編集する
                </button>
              </div>
            )}

            {list.length === 0 && !usingDefault ? (
              <p className="hint">{label}がありません</p>
            ) : (
              <ul className="manage-list">
                {list.map((name, i) => (
                  <li key={name}>
                    <span>{name}</span>
                    <span className="manage-actions">
                      <button type="button" className="icon" aria-label="上へ" disabled={i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </button>
                      <button type="button" className="icon" aria-label="下へ" disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                        ↓
                      </button>
                      <button type="button" className="icon red" aria-label={`${name}を削除`} onClick={() => remove(name)}>
                        🗑
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!isPacks && <p className="hint">レアリティ順の並び替えは、ここでの並び順が使われます。</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---- タイトル背景色 (Swift版 TitleColorPickerView) ----
function TitleColorModal({ title, onSave, onClose }) {
  const [detail, setDetail] = useState(title.background_color);
  const [simple, setSimple] = useState(title.simple_background_color);
  const previewBg = colorCss(detail, "#ffffff");
  return (
    <Modal
      title="背景色"
      onClose={onClose}
      level={1}
      action={
        <button
          type="button"
          className="link strong"
          onClick={() => onSave({ background_color: detail, simple_background_color: simple })}
        >
          完了
        </button>
      }
    >
      <div className="stack">
        <h3 className="center">{title.name}</h3>
        <section className="group-box">
          <h3>詳細表示のタイトル背景</h3>
          <ColorField label="詳細表示の背景色" value={detail} onChange={setDetail} />
          <div className="preview-box" style={{ background: previewBg, color: readableText(detail) }}>
            <strong>{title.name}</strong>
            <span>タイトル背景のイメージ</span>
          </div>
        </section>
        <section className="group-box">
          <h3>一覧表示（写真と名前）のカード背景</h3>
          <p className="hint">カード個別の背景色が未設定のカードに使われます。</p>
          <ColorField label="一覧表示の背景色" value={simple} onChange={setSimple} />
          <div className="preview-box small" style={{ background: colorCss(simple, "#ffffff"), color: readableText(simple) }}>
            カード背景のイメージ
          </div>
        </section>
      </div>
    </Modal>
  );
}

// 選んだ写真を縮小してdataURLにする (端末内に保存できるサイズに収める)
async function fileToDataUrl(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("画像を読み込めませんでした"));
      el.src = objectUrl;
    });
    for (const [max, quality] of [[1600, 0.82], [1280, 0.7], [960, 0.6]]) {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", quality);
      if (data.length < 2000000) return data;
    }
    throw new Error("画像が大きすぎます。別の画像を選んでください");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function BackgroundSettings({ bg, onChange, onNotice }) {
  const b = { ...DEFAULT_BG, ...bg, uiTheme: { ...DEFAULT_UI_THEME, ...(bg?.uiTheme || {}) } };
  const set = (patch) => onChange({ ...b, ...patch });
  const { layer } = computeBg(b);
  const fileRef = useRef(null);
  const isData = b.imageUrl.startsWith("data:");

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = await fileToDataUrl(file);
      try {
        localStorage.setItem("aipri.bgtest", data);
        localStorage.removeItem("aipri.bgtest");
      } catch {
        throw new Error("この端末に保存できませんでした。画像URLを使ってください");
      }
      set({ mode: "image", imageUrl: data });
    } catch (err) {
      onNotice(err.message || "画像を設定できませんでした", "error");
    }
  };

  return (
    <section className="group-box">
      <h3>アプリの背景</h3>
      <div className="bg-preview" style={layer} aria-hidden="true" />
      <Segmented
        options={[
          { value: "default", label: "標準" },
          { value: "color", label: "単色" },
          { value: "gradient", label: "グラデ" },
          { value: "image", label: "画像" },
        ]}
        value={b.mode}
        onChange={(mode) => set({ mode })}
      />

      {b.mode === "color" && (
        <ColorField label="背景色" value={b.color} onChange={(color) => set({ color })} />
      )}

      {b.mode === "gradient" && (
        <>
          <div className="preset-row">
            {BG_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                className="preset"
                title={p.name}
                aria-label={`${p.name}のグラデーションにする`}
                style={{ background: `linear-gradient(135deg, ${colorCss(p.from)}, ${colorCss(p.to)})` }}
                onClick={() => set({ mode: "gradient", from: p.from, to: p.to, uiTheme: { ...p.uiTheme } })}
              >
                <span>{p.name}</span>
              </button>
            ))}
          </div>
          <Field>
            <ColorField label="開始の色" value={b.from} onChange={(from) => set({ from })} />
          </Field>
          <Field>
            <ColorField label="終了の色" value={b.to} onChange={(to) => set({ to })} />
          </Field>
          <Field label={`向き：${clamp(toInt(b.angle, 160), 0, 360)}°`}>
            <input
              type="range"
              min="0"
              max="360"
              value={clamp(toInt(b.angle, 160), 0, 360)}
              onChange={(e) => set({ angle: Number(e.target.value) })}
            />
          </Field>
        </>
      )}

      {b.mode === "image" && (
        <>
          <Field label="画像URL" hint="URLを入れるか、下のボタンで端末の写真を選べます。">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              placeholder="https://..."
              value={isData ? "（この端末に保存した画像）" : b.imageUrl}
              readOnly={isData}
              onChange={(e) => set({ imageUrl: e.target.value })}
            />
          </Field>
          <div className="row2">
            <button type="button" className="secondary" onClick={() => fileRef.current?.click()}>
              写真を選ぶ
            </button>
            <button type="button" className="secondary" disabled={!b.imageUrl} onClick={() => set({ imageUrl: "" })}>
              画像を外す
            </button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickFile} />
          <Field label="画像の上に重ねる色（文字を読みやすくします）">
            <Segmented
              options={[
                { value: "light", label: "明るく" },
                { value: "dark", label: "暗く" },
              ]}
              value={b.overlay}
              onChange={(overlay) => set({ overlay })}
            />
          </Field>
          <Field label={`濃さ：${Math.round(clamp(Number(b.strength) || 0, 0, 0.9) * 100)}%`}>
            <input
              type="range"
              min="0"
              max="90"
              value={Math.round(clamp(Number(b.strength) || 0, 0, 0.9) * 100)}
              onChange={(e) => set({ strength: Number(e.target.value) / 100 })}
            />
          </Field>
          {!normalizeImageSrc(b.imageUrl) && (
            <p className="hint">画像が未設定のため、標準の背景で表示しています。</p>
          )}
        </>
      )}

      <div className="settings-reset-row">
        <span className="settings-reset-label"></span>
        <button type="button" className="ghost reset-button" onClick={() => onChange({ ...b, ...DEFAULT_BG, uiTheme: { ...b.uiTheme } })}>
          背景をデフォルトに戻す
        </button>
      </div>

      <section className="group-box theme-settings">
        <h3>共通UIの色</h3>
        <ColorField label="パネル" value={b.uiTheme.panel} onChange={(panel) => set({ uiTheme: { ...b.uiTheme, panel } })} />
        <ColorField label="強調パネル・入力欄" value={b.uiTheme.panelStrong} onChange={(panelStrong) => set({ uiTheme: { ...b.uiTheme, panelStrong } })} />
        <ColorField label="ボタン・背景" value={b.uiTheme.control} onChange={(control) => set({ uiTheme: { ...b.uiTheme, control } })} />
        <ColorField label="選択中のボタン" value={b.uiTheme.controlOn} onChange={(controlOn) => set({ uiTheme: { ...b.uiTheme, controlOn } })} />
        <ColorField label="境界線" value={b.uiTheme.line} onChange={(line) => set({ uiTheme: { ...b.uiTheme, line } })} />
        <ColorField label="文字" value={b.uiTheme.text} onChange={(text) => set({ uiTheme: { ...b.uiTheme, text } })} />
        <ColorField label="補助文字" value={b.uiTheme.sub} onChange={(sub) => set({ uiTheme: { ...b.uiTheme, sub } })} />
        <ColorField label="詳細・交換・枚数" value={b.uiTheme.accent} onChange={(accent) => set({ uiTheme: { ...b.uiTheme, accent } })} />
        <ColorField label="カード情報ラベル" value={b.uiTheme.cap} onChange={(cap) => set({ uiTheme: { ...b.uiTheme, cap } })} />

        <div className="settings-reset-row">
          <span className="settings-reset-label"></span>
          <button type="button" className="ghost reset-button" onClick={() => set({ uiTheme: { ...DEFAULT_UI_THEME } })}>
            共通UIの色をデフォルトに戻す
          </button>
        </div>
      </section>
    </section>
  );
}

// ---- 設定 (Swift版 ImageCacheSettingsView + 同期状態) ----
function SettingsModal({ session, pending, syncError, online, bg, onBgChange, onSyncNow, onReload, onClose, onNotice }) {
  const [size, setSize] = useState(null);
  const refresh = useCallback(() => imageCache.size().then(setSize), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const clear = async () => {
    if (!window.confirm("保存されている画像キャッシュだけを削除します。カード情報は削除されません。")) return;
    await imageCache.clear();
    await refresh();
    onNotice("画像キャッシュを削除しました");
  };

  return (
    <Modal title="設定" onClose={onClose} size="sm">
      <div className="stack">
        <BackgroundSettings bg={bg} onChange={onBgChange} onNotice={onNotice} />

        <section className="group-box">
          <h3>画像キャッシュ</h3>
          <div className="kv">
            <span>使用容量</span>
            <span>{size === null ? "…" : formatBytes(size)}</span>
          </div>
          <button type="button" className="danger" onClick={clear}>
            画像キャッシュを削除
          </button>
          <p className="hint">
            画像はカード情報とは別に保存されます。キャッシュを削除しても、登録したカード・URL・タイトル・弾数などのデータは削除されません。
            上限は500MBで、超えると古い画像から削除されます。
          </p>
        </section>

        <section className="group-box">
          <h3>データの保存先</h3>
          <div className="kv">
            <span>アカウント</span>
            <span>{session ? session.user.email : "ゲスト（この端末のみ）"}</span>
          </div>
          <div className="kv">
            <span>通信状態</span>
            <span>{online ? "オンライン" : "オフライン"}</span>
          </div>
          {session && (
            <>
              <div className="kv">
                <span>未同期の変更</span>
                <span>{pending}件</span>
              </div>
              {syncError && <div className="error">{syncError}</div>}
              <div className="row2">
                <button type="button" className="secondary" onClick={onSyncNow} disabled={!online || pending === 0}>
                  今すぐ同期
                </button>
                <button type="button" className="secondary" onClick={onReload} disabled={!online}>
                  クラウドから再読み込み
                </button>
              </div>
            </>
          )}
          {!session && (
            <p className="hint">
              ゲストのデータはこのブラウザ内にだけ保存されます。ログインするとクラウドに保存し、他の端末と共有できます。
            </p>
          )}
        </section>
      </div>
    </Modal>
  );
}

// ---- 画像の拡大表示 (Swift版 画像拡大スワイプ画面) ----
function ImageViewer({ images, index, onIndex, onClose }) {
  const touchX = useRef(null);
  const go = useCallback(
    (d) => onIndex((i) => clamp(i + d, 0, images.length - 1)),
    [images.length, onIndex]
  );
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  return (
    <Modal title="画像" onClose={onClose} level={3} size="viewer">
      <div
        className="viewer-body"
        onTouchStart={(e) => {
          touchX.current = e.touches[0].clientX;
        }}
        onTouchEnd={(e) => {
          if (touchX.current === null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
          touchX.current = null;
        }}
      >
        {images.length === 0 ? (
          <p>画像がありません</p>
        ) : (
          <div className="viewer-scroll">
            <CachedImage natural key={images[index].src} src={images[index].src} alt={images[index].label} />
          </div>
        )}
        {images.length > 1 && (
          <div className="viewer-nav">
            <button type="button" onClick={() => go(-1)} disabled={index === 0}>
              ‹
            </button>
            <span>{images[index].label}</span>
            <button type="button" onClick={() => go(1)} disabled={index === images.length - 1}>
              ›
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---- カード詳細 (Swift版 CardDetailView) ----
function DetailModal({ card, onClose, onEdit, onCount, onFavorite, onOpenViewer }) {
  const images = [
    { label: "表面", src: card.image_url },
    { label: "裏面", src: card.back_image_url },
  ].filter((i) => normalizeImageSrc(i.src));
  const [side, setSide] = useState(0);
  const current = images[Math.min(side, images.length - 1)];

  return (
    <Modal
      title="カード詳細"
      onClose={onClose}
      level={0}
      action={
        <button type="button" className="link strong" onClick={onEdit}>
          編集
        </button>
      }
    >
      <div className="stack">
        <div className={`detail-image ${images.length > 1 ? "has-both" : ""}`}>
          {images.length > 0 ? (
            <div className="detail-image-grid">
              {images.map((im, i) => (
                <button
                  key={im.src}
                  type="button"
                  className={`detail-image-btn ${side === i ? "active" : ""}`}
                  onClick={() => onOpenViewer(i)}
                >
                  <CachedImage natural src={im.src} alt={`${card.name} ${im.label}`} />
                  <span className="detail-image-label">{im.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="cimg-empty tall">画像なし</div>
          )}
          {images.length > 1 && (
            <div className="detail-image-mobile-switch">
              <Segmented
                options={images.map((im, i) => ({ value: i, label: im.label }))}
                value={Math.min(side, images.length - 1)}
                onChange={setSide}
              />
            </div>
          )}
          {images.length > 0 && <p className="hint center">画像をタップすると拡大できます</p>}
        </div>

        <h3 className="detail-name">{card.name || "名前なし"}</h3>
        <dl className="info">
          {card.character_name && (<><dt>キャラ</dt><dd>{card.character_name}</dd></>)}
          <dt>タイトル</dt><dd>{card.title_name}</dd>
          <dt>弾数</dt><dd>{card.pack_number || "-"}</dd>
          <dt>カード番号</dt><dd>{card.card_number || "-"}</dd>
          <dt>レアリティ</dt><dd>{card.rarity || "-"}</dd>
          <dt>カテゴリ</dt><dd>{card.category}</dd>
        </dl>

        <div className="kv">
          <span>所持状況</span>
          <strong style={{ color: card.is_owned ? "#34c759" : "#ff3b30" }}>
            {card.is_owned ? "✓ 所持" : "○ 未所持"}
          </strong>
        </div>
        <div className="kv">
          <span>所持枚数</span>
          <strong>
            {card.count} / {card.target_count}枚
          </strong>
        </div>
        <Counter count={card.count} onChange={(d) => onCount(card.id, d)} />

        <div className="row-wrap">
          <button type="button" className="secondary" onClick={() => onFavorite(card.id)}>
            {card.is_favorite ? "★ お気に入り登録済み" : "☆ お気に入りに追加"}
          </button>
          <TradeBadge card={card} big />
        </div>

        {card.memo && (
          <section className="group-box">
            <h3>メモ</h3>
            <p className="memo">{card.memo}</p>
          </section>
        )}
      </div>
    </Modal>
  );
}

function Counter({ count, onChange, compact = false }) {
  return (
    <div className={`counter ${compact ? "compact" : ""}`}>
      <button type="button" aria-label="1枚減らす" disabled={count <= 0} onClick={() => onChange(-1)}>
        −
      </button>
      <span>{count}枚</span>
      <button type="button" aria-label="1枚増やす" disabled={count >= MAX_COUNT} onClick={() => onChange(1)}>
        ＋
      </button>
    </div>
  );
}

// ---- サイドバー (Swift版 sidebarView) ----
function Sidebar({
  titleInfos, selectedTitle, selectedPack, onSelect, onColor, onManage,
  onDeleteTitle, onDeletePack, onAddTitle, onClose,
}) {
  const [expanded, setExpanded] = useState(() => new Set(selectedTitle ? [selectedTitle] : []));
  const [newTitle, setNewTitle] = useState("");
  const toggle = (name) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const add = () => {
    if (onAddTitle(newTitle)) setNewTitle("");
  };

  return (
    <div className="drawer-wrap" onMouseDown={onClose}>
      <nav className="drawer" aria-label="タイトル" onMouseDown={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <strong>タイトル</strong>
          <button type="button" className="link" onClick={onClose}>閉じる</button>
        </div>

        <button
          type="button"
          className={`drawer-item ${selectedTitle === null ? "on" : ""}`}
          onClick={() => onSelect(null, null)}
        >
          {selectedTitle === null ? "●" : "○"} すべて
        </button>

        {titleInfos.map((t) => (
          <div key={t.id} className="drawer-title">
            <div className="drawer-row">
              <button
                type="button"
                className={`drawer-item grow ${selectedTitle === t.name && !selectedPack ? "on" : ""}`}
                onClick={() => {
                  onSelect(t.name, null, false);
                  toggle(t.name);
                }}
              >
                <span className="chev">{expanded.has(t.name) ? "▾" : "▸"}</span> {t.name}
              </button>
              <button type="button" className="icon" aria-label={`${t.name}の背景色`} onClick={() => onColor(t.id)}>🎨</button>
              <button type="button" className="icon red" aria-label={`${t.name}を削除`} onClick={() => onDeleteTitle(t)}>🗑</button>
            </div>
            {expanded.has(t.name) && (
              <div className="drawer-packs">
                {t.packs.length === 0 && <p className="hint">弾がありません</p>}
                {t.packs.map((p) => (
                  <div key={p} className="drawer-row">
                    <button
                      type="button"
                      className={`drawer-item grow sub ${selectedTitle === t.name && selectedPack === p ? "on" : ""}`}
                      onClick={() => onSelect(t.name, p)}
                    >
                      └ {p}
                    </button>
                    <button type="button" className="icon red small" aria-label={`${p}を削除`} onClick={() => onDeletePack(t, p)}>🗑</button>
                  </div>
                ))}
                <div className="drawer-row">
                  <button type="button" className="link sub" onClick={() => onManage(t.id, "packs")}>＋ 弾を追加・整理</button>
                  <button type="button" className="link sub" onClick={() => onManage(t.id, "rarities")}>レアリティ</button>
                </div>
              </div>
            )}
          </div>
        ))}

        <div className="drawer-add">
          <input
            value={newTitle}
            placeholder="新しいタイトル名"
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button type="button" className="secondary" onClick={add}>追加</button>
        </div>
      </nav>
    </div>
  );
}

/* ---------------------------------------------------------
   カード表示 (詳細 / 一覧)
   --------------------------------------------------------- */

function DetailCard({ card, onOpen, onFavorite, onCount }) {
  const bg = colorCss(card.background_color, "#ffffff");
  return (
    <article className="dcard">
      <div className="dcard-head" style={{ background: bg, color: readableText(card.background_color) }}>
        <span className="cap">{card.title_name}</span>
        <span className="spacer" />
        <TradeBadge card={card} />
        <button
          type="button"
          className={`star ${card.is_favorite ? "on" : ""}`}
          aria-pressed={card.is_favorite}
          aria-label="お気に入り"
          onClick={() => onFavorite(card.id)}
        >
          {card.is_favorite ? "★" : "☆"}
        </button>
      </div>
      <div className="dcard-body">
        <button type="button" className="thumb" aria-label={`${card.name}の詳細`} onClick={() => onOpen(card.id)}>
          <CachedImage natural src={card.image_url} alt={card.name} />
        </button>
        <div className="dcard-info">
          <button type="button" className="dcard-text" onClick={() => onOpen(card.id)}>
            <h3>{card.name || "名前なし"}</h3>
            <div className="caps">
              {card.character_name && <span className="cap sm">{card.character_name}</span>}
              {card.rarity && <span className="cap sm bold">{card.rarity}</span>}
              {card.card_number && <span className="cap sm">{card.card_number}</span>}
            </div>
          </button>
          <Counter compact count={card.count} onChange={(d) => onCount(card.id, d)} />
        </div>
      </div>
    </article>
  );
}

function GridTile({ card, titleInfo, columns, onOpen }) {
  const bg = colorCss(card.background_color) || colorCss(titleInfo?.simple_background_color, "#ffffff");
  const pad = columns <= 2 ? 10 : columns <= 4 ? 8 : columns === 5 ? 6 : columns === 6 ? 4 : 2;
  const font = columns <= 3 ? 12 : columns <= 5 ? 10 : columns === 6 ? 9 : 8;
  const hasTrade = card.trade_type !== "なし" && card.trade_count > 0;
  return (
    <button
      type="button"
      className="tile"
      style={{ background: bg, padding: 0 }}
      aria-label={card.name || card.card_number}
      onClick={() => onOpen(card.id)}
    >
      <div className="tile-img">
        <CachedImage natural src={card.image_url} alt={card.name} />
        {card.is_favorite && <span className="tile-fav" style={{ fontSize: font + 4 }}>★</span>}
        {card.count > 0 && <span className="tile-count" style={{ fontSize: font }}>×{card.count}</span>}
      </div>
      <div className="tile-badge" style={{ minHeight: font + 8 }}>
        {hasTrade && (
          <span className={`trade ${card.trade_type === "求" ? "want" : "give"}`} style={{ fontSize: font }}>
            {card.trade_type} {card.trade_count}
          </span>
        )}
      </div>
    </button>
  );
}

/* ---------------------------------------------------------
   7. App 本体
   --------------------------------------------------------- */

export default function App() {
  // ---- 認証 ----
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const userId = session?.user?.id ?? null;
  const scope = userId ? `user:${userId}` : "guest";
  const userIdRef = useRef(null);
  userIdRef.current = userId;

  // ---- データ ----
  const [cards, setCards] = useState([]);
  const [titleInfos, setTitleInfos] = useState([]);
  const cardsRef = useRef([]);
  const titlesRef = useRef([]);
  const [dataScope, setDataScope] = useState(null);
  const [loading, setLoading] = useState(true);

  // ---- 同期状態 ----
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [pending, setPending] = useState(0);
  const [syncError, setSyncError] = useState("");
  const [notice, setNotice] = useState(null);
  const noticeTimer = useRef(null);
  const flushTimer = useRef(null);
  const flushing = useRef(false);

  // ---- 表示設定 ----
  const [prefs, setPrefs] = useStoredState("aipri.prefs", {
    displayMode: "詳細",
    gridColumns: 3,
    sortOption: "ナンバリング順",
    sortAsc: true,
  });
  const { displayMode, gridColumns, sortOption, sortAsc } = prefs;
  const setPref = (k, v) => setPrefs((p) => ({ ...p, [k]: v }));
  const [urlTemplate, setUrlTemplate] = useStoredState("aipri.urlTemplate", {
    frontHead: "https://...",
    frontTail: "webp",
    backHead: "https://...",
    backTail: "webp",
  });

  const [appBg, setAppBg] = useStoredState("aipri.appBg", DEFAULT_BG);
  const bgView = useMemo(() => computeBg(appBg), [appBg]);
  const uiTheme = useMemo(() => resolveUiTheme(appBg?.uiTheme), [appBg?.uiTheme]);

  const [tab, setTab] = useState("list"); // list | favorites
  const [searchText, setSearchText] = useState("");
  const [ownership, setOwnership] = useState("すべて");
  const [tradeFilter, setTradeFilter] = useState("すべて");
  const [selectedTitle, setSelectedTitle] = useState(null);
  const [selectedPack, setSelectedPack] = useState(null);

  // ---- 画面 ----
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [form, setForm] = useState(null); // { mode, cardId }
  const [batch, setBatch] = useState(null); // { title }
  const [manage, setManage] = useState(null); // { titleId, tab }
  const [colorTitleId, setColorTitleId] = useState(null);
  const [viewer, setViewer] = useState(null); // { cardId, index }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  const showNotice = useCallback((text, tone = "info") => {
    setNotice({ text, tone });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), tone === "error" ? 6000 : 3500);
  }, []);

  const commitCards = useCallback((next) => {
    cardsRef.current = next;
    setCards(next);
  }, []);
  const commitTitles = useCallback((next) => {
    titlesRef.current = next;
    setTitleInfos(next);
  }, []);

  /* ---------- 同期キュー ---------- */

  const refreshPending = useCallback(async () => {
    const id = userIdRef.current;
    if (!id) return setPending(0);
    const q = await queueAll();
    setPending(q.filter((i) => !i.scope || i.scope === `user:${id}`).length);
  }, []);

  const flushQueue = useCallback(async () => {
    const id = userIdRef.current;
    if (!id || flushing.current || !navigator.onLine) return;
    flushing.current = true;
    const myScope = `user:${id}`;
    try {
      for (;;) {
        const items = (await queueAll())
          .filter((i) => !i.scope || i.scope === myScope)
          .sort((a, b) => a.queue_id - b.queue_id);
        if (items.length === 0) break;

        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          // 同じデータへの後続の操作がある upsert は、実行せず破棄する
          const superseded =
            item.action === "upsert" &&
            items.slice(i + 1).some((o) => o.table === item.table && o.id === item.id);

          if (!superseded) {
            let res;
            if (item.action === "upsert") {
              const cols = item.table === "cards" ? CARD_COLUMNS : TITLE_COLUMNS;
              res = await supabase
                .from(item.table)
                .upsert({ ...pick(item.data || {}, cols), user_id: id });
            } else {
              res = await supabase.from(item.table).delete().eq("id", item.id);
            }
            if (res.error) {
              const code = String(res.error.code || "");
              const retryable = !code || code.startsWith("PGRST3") || res.status >= 500;
              if (retryable) throw res.error;
              // 再試行しても直らない変更は破棄して、残りの同期を続ける
              console.error("同期エラー(破棄):", res.error);
              setSyncError(`一部の変更を同期できませんでした：${res.error.message}`);
            }
          }
          await queueDelete(item.queue_id);
        }
      }
      setSyncError((e) => (e.startsWith("一部") ? e : ""));
    } catch (e) {
      console.error("同期失敗:", e);
      setSyncError("サーバーに接続できません。接続が戻ると自動で同期します");
    } finally {
      flushing.current = false;
      refreshPending();
    }
  }, [refreshPending]);

  const scheduleFlush = useCallback(
    (delay = 400) => {
      clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(flushQueue, delay);
    },
    [flushQueue]
  );

  // 変更を同期キューへ (ログイン中のみ。ゲストはローカル保存のみ)
  const enqueue = useCallback(
    async (ops) => {
      const id = userIdRef.current;
      if (!id) return;
      const list = Array.isArray(ops) ? ops : [ops];
      try {
        await queueAddMany(
          list.map((o) => ({ ...o, scope: `user:${id}`, created_at: Date.now() }))
        );
      } catch (e) {
        console.error(e);
        showNotice("変更の保存に失敗しました", "error");
      }
      refreshPending();
      scheduleFlush();
    },
    [refreshPending, scheduleFlush, showNotice]
  );

  /* ---------- データ変更 ---------- */

  const upsertCard = useCallback(
    (card) => {
      const c = normalizeCard(card);
      const list = cardsRef.current;
      commitCards(list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c]);
      enqueue({ table: "cards", action: "upsert", data: c, id: c.id });
      return c;
    },
    [commitCards, enqueue]
  );

  const patchCard = useCallback(
    (id, patch) => {
      const cur = cardsRef.current.find((c) => c.id === id);
      if (!cur) return null;
      return upsertCard({ ...cur, ...(typeof patch === "function" ? patch(cur) : patch) });
    },
    [upsertCard]
  );

  const removeCard = useCallback(
    (id) => {
      commitCards(cardsRef.current.filter((c) => c.id !== id));
      enqueue({ table: "cards", action: "delete", id });
    },
    [commitCards, enqueue]
  );

  const upsertTitle = useCallback(
    (title) => {
      const t = normalizeTitle(title);
      const list = titlesRef.current;
      commitTitles(list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t]);
      enqueue({ table: "title_infos", action: "upsert", data: t, id: t.id });
      return t;
    },
    [commitTitles, enqueue]
  );

  const patchTitle = useCallback(
    (id, patch) => {
      const cur = titlesRef.current.find((t) => t.id === id);
      if (!cur) return null;
      return upsertTitle({ ...cur, ...patch });
    },
    [upsertTitle]
  );

  const removeTitle = useCallback(
    (id) => {
      commitTitles(titlesRef.current.filter((t) => t.id !== id));
      enqueue({ table: "title_infos", action: "delete", id });
    },
    [commitTitles, enqueue]
  );

  /* ---------- 読み込み (Swift版 loadCloudData 相当) ---------- */

  const loadData = useCallback(async () => {
    const id = userIdRef.current;
    const sc = id ? `user:${id}` : "guest";
    setLoading(true);

    const snap = await loadSnapshot(sc);
    let localCards = (snap?.cards || []).map(normalizeCard);
    let localTitles = (snap?.titleInfos || []).map(normalizeTitle);
    const apply = (c, t) => {
      commitCards(c);
      commitTitles(t);
      setDataScope(sc);
    };

    // ゲスト：この端末のデータだけ
    if (!id) {
      apply(localCards, localTitles.length > 0 ? localTitles : makeDefaultTitles());
      setLoading(false);
      return;
    }

    // ログイン中：まず端末のデータを表示
    apply(localCards, localTitles);
    refreshPending();

    if (!navigator.onLine) {
      setLoading(false);
      showNotice("オフラインです。保存済みのデータを表示しています");
      return;
    }

    // 未同期の変更を先に送信 (クラウドの内容で上書きして失わないため)
    await flushQueue();
    const stillPending = (await queueAll()).filter(
      (i) => !i.scope || i.scope === `user:${id}`
    ).length;
    if (stillPending > 0) {
      setLoading(false);
      showNotice("未同期の変更があるため、この端末のデータを表示しています", "error");
      return;
    }

    try {
      const [cr, tr] = await Promise.all([
        supabase.from("cards").select("*"),
        supabase.from("title_infos").select("*"),
      ]);
      if (cr.error) throw cr.error;
      if (tr.error) throw tr.error;
      if (userIdRef.current !== id) return; // 読み込み中にログアウトした

      const cloudCards = (cr.data || []).map(normalizeCard);
      const cloudTitles = (tr.data || []).map(normalizeTitle);
      let nextCards = cloudCards;
      let nextTitles = cloudTitles;
      const uploads = [];

      // 初回：ゲストで作ったデータを移行するか確認
      if (
        cloudCards.length === 0 &&
        cloudTitles.length === 0 &&
        localCards.length === 0 &&
        localTitles.length === 0
      ) {
        const guest = await loadSnapshot("guest");
        if (
          guest &&
          ((guest.cards || []).length > 0 || (guest.titleInfos || []).length > 0) &&
          window.confirm("ゲストで作成したデータをこのアカウントに移行しますか？")
        ) {
          localCards = (guest.cards || []).map(normalizeCard);
          localTitles = (guest.titleInfos || []).map(normalizeTitle);
        }
      }

      // クラウドが空なら端末のデータ(または初期タイトル)を移行、あればクラウドを正とする
      if (cloudTitles.length === 0) {
        nextTitles = localTitles.length > 0 ? localTitles : makeDefaultTitles();
        uploads.push(...nextTitles.map((t) => ({ table: "title_infos", action: "upsert", data: t, id: t.id })));
      }
      if (cloudCards.length === 0 && localCards.length > 0) {
        nextCards = localCards;
        uploads.push(...localCards.map((c) => ({ table: "cards", action: "upsert", data: c, id: c.id })));
      }

      apply(nextCards, nextTitles);
      if (uploads.length > 0) await enqueue(uploads);
      setSyncError("");
    } catch (e) {
      console.error(e);
      showNotice("サーバーに接続できないため、保存済みのデータを表示しています", "error");
    } finally {
      setLoading(false);
    }
  }, [commitCards, commitTitles, enqueue, flushQueue, refreshPending, showNotice]);

  /* ---------- 副作用 ---------- */

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      setAuthReady(true);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);

  // ログイン状態が変わったら、そのスコープのデータを読み込む
  useEffect(() => {
    if (!authReady) return;
    setSelectedTitle(null);
    setSelectedPack(null);
    setDetailId(null);
    setForm(null);
    loadData();
  }, [authReady, userId, loadData]);

  // 端末への保存 (読み込み済みのスコープにだけ書き込む)
  useEffect(() => {
    if (dataScope !== scope) return undefined;
    const t = setTimeout(() => saveSnapshot(scope, { cards, titleInfos }), 200);
    return () => clearTimeout(t);
  }, [cards, titleInfos, dataScope, scope]);

  // オンライン復帰・定期的な再送
  useEffect(() => {
    const on = () => {
      setOnline(true);
      flushQueue();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const iv = setInterval(() => {
      if (navigator.onLine) flushQueue();
    }, 30000);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      clearInterval(iv);
    };
  }, [flushQueue]);

  /* ---------- 絞り込み・並び替え ---------- */

  const filtered = useMemo(() => {
    const kw = searchText.trim().toLowerCase();
    return cards.filter((c) => {
      if (tab === "favorites" && !c.is_favorite) return false;
      if (ownership === "所持" && !c.is_owned) return false;
      if (ownership === "未所持" && c.is_owned) return false;
      if (tradeFilter !== "すべて" && c.trade_type !== tradeFilter) return false;
      if (selectedTitle && c.title_name !== selectedTitle) return false;
      if (selectedPack && c.pack_number !== selectedPack) return false;
      if (kw) {
        const hit = [c.name, c.character_name, c.card_number, c.rarity, c.pack_number, c.title_name, c.category]
          .some((v) => String(v || "").toLowerCase().includes(kw));
        if (!hit) return false;
      }
      return true;
    });
  }, [cards, tab, ownership, tradeFilter, selectedTitle, selectedPack, searchText]);

  const sorted = useMemo(() => {
    const rank = (c) => {
      const own = titleInfos.find((t) => t.name === c.title_name)?.rarities || [];
      const i = own.indexOf(c.rarity);
      if (i !== -1) return i;
      const g = RARITY_ORDER.indexOf(c.rarity);
      return g !== -1 ? 1000 + g : 2000;
    };
    const dir = sortAsc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let r;
      if (sortOption === "名前順") r = collator.compare(a.name, b.name);
      else if (sortOption === "レアリティ順") r = rank(a) - rank(b);
      else if (sortOption === "枚数順") r = a.count - b.count;
      else r = collator.compare(a.card_number, b.card_number);
      return r * dir || collator.compare(a.card_number, b.card_number);
    });
  }, [filtered, sortOption, sortAsc, titleInfos]);

  // 詳細表示：タイトルごとにまとめる (枚数順のときは並べ替えを優先してまとめない)
  const groups = useMemo(() => {
    const map = new Map();
    sorted.forEach((c) => {
      if (!map.has(c.title_name)) map.set(c.title_name, []);
      map.get(c.title_name).push(c);
    });
    const order = titleInfos.map((t) => t.name);
    return [...map.keys()]
      .sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return collator.compare(a, b);
      })
      .map((name) => ({ name, cards: map.get(name) }));
  }, [sorted, titleInfos]);

  const knownCharacters = useMemo(
    () => uniq(cards.map((c) => c.character_name)).sort(collator.compare),
    [cards]
  );

  const navTitle =
    tab === "favorites"
      ? "お気に入り"
      : selectedTitle
        ? selectedPack
          ? `${selectedTitle} - ${selectedPack}`
          : selectedTitle
        : "カード一覧";

  /* ---------- 操作 ---------- */

  const selectFilter = (title, pack, close = true) => {
    setSelectedTitle(title);
    setSelectedPack(pack);
    if (close) setSidebarOpen(false);
  };

  const changeCount = (id, delta) =>
    patchCard(id, (c) => ({ count: clamp(c.count + delta, 0, MAX_COUNT) }));
  const toggleFavorite = (id) => patchCard(id, (c) => ({ is_favorite: !c.is_favorite }));

  const addTitle = (rawName) => {
    const name = rawName.trim();
    if (!name) {
      showNotice("タイトル名を入力してください", "error");
      return false;
    }
    if (titlesRef.current.some((t) => t.name === name)) {
      showNotice("同じタイトルがすでにあります", "error");
      return false;
    }
    upsertTitle({ name });
    showNotice("タイトルを追加しました");
    return true;
  };

  const deleteTitle = (t) => {
    if (!window.confirm(`「${t.name}」を削除します。\n登録済みのカードは削除されません。`)) return;
    if (selectedTitle === t.name) selectFilter(null, null, false);
    removeTitle(t.id);
  };

  const deletePack = (t, pack) => {
    if (!window.confirm(`「${t.name}」の「${pack}」を削除します。\n登録済みのカードは削除されません。`)) return;
    patchTitle(t.id, { packs: t.packs.filter((p) => p !== pack) });
    if (selectedTitle === t.name && selectedPack === pack) setSelectedPack(null);
  };

  const submitForm = (card, { newPack, newRarity }) => {
    const t = titlesRef.current.find((x) => x.name === card.title_name);
    if (t && (newPack || newRarity)) {
      const patch = {};
      if (newPack) patch.packs = [...t.packs, newPack];
      if (newRarity) {
        patch.rarities = [...(t.rarities.length > 0 ? t.rarities : DEFAULT_RARITIES), newRarity];
      }
      patchTitle(t.id, patch);
    }
    upsertCard(card);
    showNotice(form.mode === "add" ? "カードを追加しました" : "保存しました");
    setForm(null);
  };

  const deleteCard = (id) => {
    if (!window.confirm("このカードを削除してもよろしいですか？")) return;
    removeCard(id);
    setForm(null);
    setDetailId(null);
    showNotice("カードを削除しました");
  };

  const submitBatch = (list, skipped) => {
    if (list.length > 0) {
      commitCards([...cardsRef.current, ...list.map(normalizeCard)]);
      enqueue(list.map((c) => ({ table: "cards", action: "upsert", data: normalizeCard(c), id: c.id })));
    }
    setBatch(null);
    setForm(null);
    showNotice(
      list.length === 0
        ? `新しく追加できるカードがありませんでした（${skipped}枚は登録済み）`
        : `${list.length}枚を登録しました${skipped ? `（${skipped}枚は登録済みのためスキップ）` : ""}`
    );
  };

  const logout = async () => {
    const msg =
      pending > 0
        ? `未同期の変更が${pending}件あります。次回ログインしたときに同期されます。ログアウトしますか？`
        : "ログアウトしますか？";
    if (!window.confirm(msg)) return;
    const { error } = await supabase.auth.signOut();
    if (error) await supabase.auth.signOut({ scope: "local" });
  };

  const detailCard = cards.find((c) => c.id === detailId) || null;
  const formCard = form?.mode === "edit" ? cards.find((c) => c.id === form.cardId) : null;
  const colorTitle = titleInfos.find((t) => t.id === colorTitleId) || null;
  const viewerCard = viewer ? cards.find((c) => c.id === viewer.cardId) : null;
  const viewerImages = viewerCard
    ? [
        { label: "表面", src: viewerCard.image_url },
        { label: "裏面", src: viewerCard.back_image_url },
      ].filter((i) => normalizeImageSrc(i.src))
    : [];
  const openManage = (titleId, tabName) => setManage({ titleId, tab: tabName });
  const openManageByName = (titleName, tabName) =>
    openManage(titleInfos.find((t) => t.name === titleName)?.id, tabName);
  const titleInfoByName = (name) => titleInfos.find((t) => t.name === name);

  /* ---------- 画面 ---------- */

  return (
    <div className="app" style={uiTheme}>
      <style>{CSS}</style>
      <div className="app-bg" style={bgView.layer} aria-hidden="true" />

      <header className="topbar">
        <button type="button" className="icon big" aria-label="タイトル一覧を開く" onClick={() => setSidebarOpen(true)}>
          ☰
        </button>
        <div className="topbar-title">
          <h1>{navTitle}</h1>
          <p>
            <span>{session ? "ログイン中" : "ゲストモード"}</span>
            {" · "}
            <button type="button" className="topbar-action" onClick={session ? logout : () => setLoginOpen(true)}>
              {session ? "ログアウト" : "ログイン"}
            </button>
          </p>
        </div>
        {session && (pending > 0 || syncError || !online) && (
          <button
            type="button"
            className={`badge ${syncError ? "warn" : ""}`}
            onClick={() => setSettingsOpen(true)}
            title={syncError || "未同期の変更があります"}
          >
            {!online ? "オフライン" : syncError ? "同期エラー" : "同期待ち"}
            {pending > 0 ? ` ${pending}` : ""}
          </button>
        )}
        {!session && !online && <span className="badge">オフライン</span>}
        <button type="button" className="icon big" aria-label="設定" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        <button
          type="button"
          className="icon big blue"
          aria-label="カード追加"
          disabled={dataScope !== scope}
          onClick={() => setForm({ mode: "add" })}
        >
          ＋
        </button>
      </header>

      <main className="main">
        <div className="search">
          <span aria-hidden="true">🔍</span>
          <input
            type="search"
            placeholder="カード名やレアリティを検索"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            aria-label="検索"
          />
        </div>

        <div className="controls">
          <div className="row-controls">
            <Segmented
              className="fixed"
              options={["詳細", "一覧"]}
              value={displayMode}
              onChange={(v) => setPref("displayMode", v)}
            />
            <Segmented
              className="grow"
              options={["すべて", "所持", "未所持"]}
              value={ownership}
              onChange={setOwnership}
            />
          </div>
          <div className="row-controls right">
            {displayMode === "一覧" && (
              <div className="stepper" role="group" aria-label="表示列数">
                <button type="button" aria-label="列を減らす" disabled={gridColumns <= 1} onClick={() => setPref("gridColumns", gridColumns - 1)}>−</button>
                <span>{gridColumns}列</span>
                <button type="button" aria-label="列を増やす" disabled={gridColumns >= 7} onClick={() => setPref("gridColumns", gridColumns + 1)}>＋</button>
              </div>
            )}
            <span className="spacer" />
            <select value={sortOption} aria-label="並び順" onChange={(e) => setPref("sortOption", e.target.value)}>
              {["ナンバリング順", "名前順", "レアリティ順", "枚数順"].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <button
              type="button"
              className="circle"
              aria-label={sortAsc ? "昇順（タップで降順）" : "降順（タップで昇順）"}
              onClick={() => setPref("sortAsc", !sortAsc)}
            >
              {sortAsc ? "↑" : "↓"}
            </button>
          </div>
          <div className="row-controls right">
            <span className="trade-filter-label">交換</span>
            <button
              type="button"
              className={`circle ${tradeFilter === "求" ? "want" : ""}`}
              aria-pressed={tradeFilter === "求"}
              aria-label="求のカードだけ表示"
              onClick={() => setTradeFilter(tradeFilter === "求" ? "すべて" : "求")}
            >
              求
            </button>
            <button
              type="button"
              className={`circle ${tradeFilter === "譲" ? "give" : ""}`}
              aria-pressed={tradeFilter === "譲"}
              aria-label="譲のカードだけ表示"
              onClick={() => setTradeFilter(tradeFilter === "譲" ? "すべて" : "譲")}
            >
              譲
            </button>
          </div>
        </div>

        <div className="count-line">
          {sorted.length}枚
          {(selectedTitle || selectedPack || ownership !== "すべて" || tradeFilter !== "すべて" || searchText) && (
            <button
              type="button"
              className="link tiny"
              onClick={() => {
                selectFilter(null, null, false);
                setOwnership("すべて");
                setTradeFilter("すべて");
                setSearchText("");
              }}
            >
              絞り込みを解除
            </button>
          )}
        </div>

        {loading && dataScope !== scope ? (
          <div className="empty">クラウドデータを読み込み中…</div>
        ) : sorted.length === 0 ? (
          <div className="empty">
            <div className="empty-mark">♢</div>
            {cards.length === 0
              ? "カードがまだありません。右上の「＋」から追加してください。"
              : tab === "favorites" && !cards.some((c) => c.is_favorite)
                ? "お気に入りのカードがありません。カードの☆をタップして追加できます。"
                : "条件に一致するカードがありません。"}
          </div>
        ) : displayMode === "詳細" ? (
          sortOption === "枚数順" ? (
            <div className="cards-grid">
              {sorted.map((c) => (
                <DetailCard key={c.id} card={c} onOpen={setDetailId} onFavorite={toggleFavorite} onCount={changeCount} />
              ))}
            </div>
          ) : (
            <div className="list">
              {groups.map((g) => {
                const info = titleInfoByName(g.name);
                const bg = colorCss(info?.background_color, "#ffffff");
                const fg = readableText(info?.background_color);
                const owned = g.cards.filter((c) => c.count > 0).length;
                return (
                  <section key={g.name} className="group" style={{ background: bg }}>
                    <header style={{ color: fg }}>
                      <h2>{g.name || "（タイトルなし）"}</h2>
                      <span className="ratio">
                        {owned}/{g.cards.length}
                      </span>
                    </header>
                    {g.cards.map((c) => (
                      <DetailCard key={c.id} card={c} onOpen={setDetailId} onFavorite={toggleFavorite} onCount={changeCount} />
                    ))}
                  </section>
                );
              })}
            </div>
          )
        ) : (
          <div className="grid" style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }}>
            {sorted.map((c) => (
              <GridTile
                key={c.id}
                card={c}
                titleInfo={titleInfoByName(c.title_name)}
                columns={gridColumns}
                onOpen={setDetailId}
              />
            ))}
          </div>
        )}
      </main>

      <nav className="tabbar" aria-label="表示切り替え">
        <button type="button" className={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>
          <span aria-hidden="true">▤</span>カード一覧
        </button>
        <button type="button" className={tab === "favorites" ? "on" : ""} onClick={() => setTab("favorites")}>
          <span aria-hidden="true">★</span>お気に入り
        </button>
      </nav>

      {notice && (
        <div className={`toast ${notice.tone}`} role="status">
          {notice.text}
        </div>
      )}

      {sidebarOpen && (
        <Sidebar
          titleInfos={titleInfos}
          selectedTitle={selectedTitle}
          selectedPack={selectedPack}
          onSelect={selectFilter}
          onColor={setColorTitleId}
          onManage={openManage}
          onDeleteTitle={deleteTitle}
          onDeletePack={deletePack}
          onAddTitle={addTitle}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      {detailCard && (
        <DetailModal
          card={detailCard}
          onClose={() => setDetailId(null)}
          onEdit={() => setForm({ mode: "edit", cardId: detailCard.id })}
          onCount={changeCount}
          onFavorite={toggleFavorite}
          onOpenViewer={(index) => setViewer({ cardId: detailCard.id, index })}
        />
      )}

      {form && (form.mode === "add" || formCard) && (
        <CardForm
          mode={form.mode}
          initial={formCard}
          titleInfos={titleInfos}
          knownCharacters={knownCharacters}
          template={urlTemplate}
          onTemplateChange={setUrlTemplate}
          onSubmit={submitForm}
          onDelete={() => deleteCard(formCard.id)}
          onClose={() => setForm(null)}
          onManage={openManageByName}
          onBatch={(title) => setBatch({ title })}
        />
      )}

      {batch && (
        <BatchAddModal
          titleInfos={titleInfos}
          cards={cards}
          initialTitle={batch.title}
          knownCharacters={knownCharacters}
          onSubmit={submitBatch}
          onClose={() => setBatch(null)}
          onManage={openManageByName}
        />
      )}

      {manage && (
        <ManageModal
          titleInfos={titleInfos}
          initialTitleId={manage.titleId}
          initialTab={manage.tab}
          level={5}
          onChangeTitle={patchTitle}
          onClose={() => setManage(null)}
        />
      )}

      {colorTitle && (
        <TitleColorModal
          title={colorTitle}
          onSave={(patch) => {
            patchTitle(colorTitle.id, patch);
            setColorTitleId(null);
            showNotice("背景色を保存しました");
          }}
          onClose={() => setColorTitleId(null)}
        />
      )}

      {viewer && viewerCard && (
        <ImageViewer
          images={viewerImages}
          index={Math.min(viewer.index, Math.max(0, viewerImages.length - 1))}
          onIndex={(fn) =>
            setViewer((v) => ({ ...v, index: typeof fn === "function" ? fn(v.index) : fn }))
          }
          onClose={() => setViewer(null)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          session={session}
          pending={pending}
          syncError={syncError}
          online={online}
          bg={appBg}
          onBgChange={setAppBg}
          onSyncNow={flushQueue}
          onReload={loadData}
          onClose={() => setSettingsOpen(false)}
          onNotice={showNotice}
        />
      )}

      {loginOpen && !session && <LoginModal onClose={() => setLoginOpen(false)} onNotice={showNotice} />}
    </div>
  );
}

/* ---------------------------------------------------------
   スタイル
   --------------------------------------------------------- */

const CSS = `
.app{position:relative;isolation:isolate;--bg:#f2f2f7;--panel:#fff;--panel-strong:#fff;--control:rgba(120,120,128,.13);--control-on:#fff;--text:#1c1c1e;--sub:#6e6e73;--line:#e5e5ea;--blue:#007aff;--red:#ff3b30;--orange:#ff9500;--cap:#8e8e93;--accent-ui:rgba(50,50,55,.92);
  min-height:100vh;background:transparent;color:var(--text);color-scheme:light;padding-bottom:76px;
  font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;font-size:15px;line-height:1.5}
.app *{box-sizing:border-box}
.app-bg{position:fixed;inset:0;z-index:-1}
.bg-preview{height:72px;border-radius:12px;border:1px solid var(--line)}
.preset-row{display:flex;flex-wrap:wrap;gap:8px}
.preset{border:1px solid rgba(0,0,0,.12);border-radius:10px;width:64px;height:40px;padding:0;display:flex;align-items:flex-end;justify-content:center;overflow:hidden}
.preset span{font-size:10px;background:var(--panel-strong);width:100%;text-align:center;line-height:1.5;color:var(--text)}
.app button{font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.app button:disabled{cursor:default;opacity:.4}
.app input,.app select,.app textarea{font:inherit;color:var(--text);background:var(--panel-strong);border:1px solid var(--line);border-radius:10px;padding:9px 11px;width:100%;min-width:0}
.app input[type=checkbox]{width:auto}
.app input[type=color]{width:44px;height:36px;padding:2px;flex:none}
.app input[type=range]{padding:0;border:0;background:none;flex:none;width:min(200px,100%);min-width:80px;align-self:flex-start;margin:0}
.app :focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.app h1,.app h2,.app h3,.app p{margin:0}
.spacer{flex:1}
.center{text-align:center}

.topbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--panel);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.topbar-title{flex:1;min-width:0}
.topbar-title h1{font-size:18px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-title p{font-size:12px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{border:0;background:var(--control);border-radius:99px;padding:3px 10px;font-size:12px;font-weight:600;white-space:nowrap}
.badge.warn{background:#ffe5e3;color:#c4241b}

.icon{border:0;background:none;padding:6px 8px;border-radius:8px;line-height:1}
.icon.big{font-size:26px;width:44px;height:44px;padding:0}.icon.big[aria-label="設定"]{font-size:30px}
.icon.blue{color:var(--blue);font-weight:700}
.icon.red{color:var(--red)}
.icon.small{font-size:12px}
.link{border:0;background:none;color:var(--blue);padding:4px 2px}
.topbar-action{border:1px solid var(--line);background:var(--control);color:var(--text);border-radius:9px;padding:5px 10px;font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer}
.topbar-action:hover{filter:brightness(.97)}
.link.strong{font-weight:700}.link.tiny{font-size:12px;padding:0}.link.sub{font-size:13px}
.primary,.secondary,.danger,.ghost{border-radius:12px;padding:11px 16px;font-weight:600;border:1px solid transparent}
.primary{background:var(--blue);color:#fff!important}
.secondary{background:var(--panel-strong);border-color:var(--line)}
.danger{background:var(--panel-strong);border-color:#ffc9c5;color:var(--red)!important}
.ghost{background:var(--control);color:var(--text);padding:8px 12px;font-size:13px;border-radius:9px;border:1px solid var(--line);cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.ghost:hover:not(:disabled){filter:brightness(.97)}
.ghost:disabled{opacity:.5;cursor:default}

.main{max-width:1280px;margin:0 auto;padding:12px}
.search{display:flex;align-items:center;gap:8px;background:var(--control);border-radius:12px;padding:0 12px}
.search input{border:0;background:none;padding:10px 0}
.controls{display:flex;flex-direction:column;gap:8px;margin:12px 0 4px}
.row-controls{display:flex;align-items:center;gap:8px}
.row-controls .hint{font-size:12px}
.trade-filter-label{font-size:16px;font-weight:700;color:var(--text)}
.seg{display:flex;background:var(--control);border-radius:10px;padding:2px;gap:2px}
.seg.fixed{width:150px;flex:none}.seg.grow{flex:1}
.seg button{flex:1;border:0;background:none;border-radius:8px;padding:6px 10px;font-size:14px;white-space:nowrap}
.seg button.on{background:var(--accent-ui);color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.15);font-weight:600}
.stepper{display:flex;align-items:center;gap:2px;background:var(--control);border-radius:10px;padding:2px}
.stepper button{border:0;background:var(--accent-ui);color:#fff;width:32px;height:30px;border-radius:8px}
.stepper span{min-width:44px;text-align:center;font-size:14px}
.row-controls select{width:auto;flex:none}
.circle{width:40px;height:40px;border-radius:50%;border:1px solid var(--line);background:var(--control);font-weight:700;font-size:17px;padding:0;flex:none;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.circle.want{background:var(--blue);color:#fff}.circle.give{background:var(--orange);color:#fff}
.count-line{display:flex;align-items:center;gap:12px;font-size:17px;font-weight:700;color:var(--text);padding:7px 2px}

.empty{text-align:center;color:var(--sub);padding:48px 16px}
.empty-mark{font-size:40px;margin-bottom:8px}

.list{display:flex;flex-direction:column;gap:14px}
.cards-grid,.group{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
@media (min-width:720px){.cards-grid,.group{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:1080px){.cards-grid,.group{grid-template-columns:repeat(3,minmax(0,1fr))}}
.group{border-radius:18px;padding:0 0 10px;border:1px solid var(--line);overflow:hidden}
.group>header{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding:10px 14px 0}
.group h2{font-size:18px}
.ratio{font-weight:700;padding:3px 10px;border-radius:99px;background:var(--accent-ui);color:#fff}
.dcard{background:var(--panel);border-radius:18px;overflow:hidden;border:1px solid var(--line)}
.dcard-head{display:flex;align-items:center;gap:8px;padding:7px 12px}
.cap{background:var(--cap);color:#fff;border-radius:99px;padding:2px 10px;font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70%}
.cap.sm{font-size:12px;font-weight:400;padding:1px 9px}.cap.bold{font-weight:700}
.caps{display:flex;flex-wrap:wrap;gap:6px}
.star{border:0;background:var(--control);width:34px;height:34px;border-radius:50%;font-size:17px;color:var(--cap);padding:0}
.star.on{background:rgba(255,204,0,.2);color:#f5b800}
.trade{color:#fff;border-radius:99px;padding:3px 10px;font-weight:700;font-size:16px;white-space:nowrap;background:var(--accent-ui)}
.trade.want,.trade.give{background:var(--accent-ui)}.trade.big{font-size:17px;padding:5px 13px}
.dcard-body{display:flex;gap:12px;padding:12px}
.thumb{border:0;padding:0;width:72px;height:auto;align-self:flex-start;flex:none;border-radius:10px;overflow:hidden;background:var(--panel);border:1px solid var(--line)}
.dcard-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;justify-content:space-between}
.dcard-text{border:0;background:none;text-align:left;padding:0;display:flex;flex-direction:column;gap:8px}
.dcard-text h3{font-size:16px;font-weight:700;overflow-wrap:anywhere}
.counter{display:inline-flex;align-items:center;gap:10px;background:var(--control);border-radius:99px;padding:4px 8px;align-self:flex-start}
.counter button{width:32px;height:32px;border-radius:50%;border:0;background:var(--control-on);box-shadow:0 1px 2px rgba(0,0,0,.15);font-size:16px;font-weight:700;padding:0}
.counter span{min-width:48px;text-align:center;font-weight:700}
.counter.compact button{width:30px;height:30px}

.grid{display:grid;gap:14px 10px}
.tile{border:0;border-radius:0;display:flex;flex-direction:column;gap:6px;text-align:center;background:var(--panel);padding:0;width:100%;min-width:0}
.tile-img{position:relative;border-radius:0;overflow:hidden;width:100%;box-shadow:inset 0 0 0 1px var(--line);box-sizing:border-box}
.tile-fav{position:absolute;top:3px;left:4px;color:#ffcc00;text-shadow:0 0 3px rgba(0,0,0,.6)}
.tile-count{position:absolute;right:3px;bottom:3px;background:var(--accent-ui);color:#fff;border-radius:99px;padding:0 6px;font-weight:700}
.tile-badge{display:flex;align-items:center;justify-content:center}

.cimg{position:relative;width:100%;height:100%;background:var(--panel-strong)}
.cimg img{width:100%;height:100%;display:block}
.cimg-empty{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--cap);font-size:12px;text-align:center;padding:4px}
.cimg-empty.tall{min-height:220px}
.cimg.natural{height:auto}
.cimg.natural img{height:auto}
.cimg.natural .cimg-empty{min-height:160px}
.thumb .cimg.natural .cimg-empty,.thumb-preview .cimg.natural .cimg-empty,.tile-img .cimg.natural .cimg-empty{min-height:0;height:auto;aspect-ratio:.7}

.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:30;display:flex;background:var(--panel);backdrop-filter:blur(14px);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom,0)}
.tabbar button{flex:1;border:0;background:none;padding:8px 0 10px;display:flex;flex-direction:column;align-items:center;font-size:11px;color:var(--cap)}
.tabbar button span{font-size:20px;line-height:1.2}
.tabbar button.on{color:var(--blue);font-weight:700}

.toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:300;background:rgba(28,28,30,.92);color:#fff;padding:10px 18px;border-radius:12px;max-width:90vw;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.toast.error{background:#c4241b}

.overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:flex-end;justify-content:center}
.modal{background:var(--panel);width:100%;max-width:560px;max-height:94vh;border-radius:18px 18px 0 0;display:flex;flex-direction:column;overflow:hidden}
.modal.sm{max-width:440px}.modal.viewer{max-width:720px;height:90vh;background:#000;color:#fff}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--panel);border-bottom:1px solid var(--line);gap:8px}
.modal-head h2{font-size:16px;text-align:center;flex:1}
.modal-head>*:first-child,.modal-action{min-width:56px}
.modal-action{text-align:right}
.viewer-modal .modal-head{background:#111}
.modal.viewer .modal-head{background:#111;border-color:#222}.modal.viewer .modal-head h2{color:#fff}
.modal-body{overflow-y:auto;padding:14px;flex:1;-webkit-overflow-scrolling:touch}
.modal.viewer .modal-body{padding:0;display:flex}
.modal-foot{padding:12px 14px;background:var(--panel);border-top:1px solid var(--line)}
@media (min-width:700px){.overlay{align-items:center}.modal{border-radius:18px}}

.stack{display:flex;flex-direction:column;gap:14px}
.group-box{background:var(--panel);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;border:1px solid var(--line)}
.group-box h3{font-size:13px;color:var(--sub);font-weight:600}
.field{display:flex;flex-direction:column;gap:4px}
.field-label{font-size:13px;color:var(--sub)}
.hint{font-size:12px;color:var(--sub)}
.hint.box{background:#fff8e1;border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.error{background:#ffe5e3;color:#a1160e;border-radius:10px;padding:9px 12px;font-size:14px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.row-wrap{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.check{display:flex;align-items:center;gap:8px}
.preview-row{display:flex;gap:10px}
.thumb-preview{width:72px;height:auto;align-self:flex-start;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.details summary{cursor:pointer;color:var(--blue);font-size:14px;padding:4px 0}
.details[open] summary{margin-bottom:8px}
.inline-add{display:flex;gap:8px}.inline-add button{flex:none}

.colorfield{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:10px 0}.theme-settings .colorfield{border-bottom:1px dashed var(--line)}.theme-settings .colorfield:last-of-type{border-bottom:0}
.colorfield-main{display:flex;align-items:center;gap:10px;min-width:0}
.colorfield-alpha{display:flex;align-items:center;justify-content:flex-start;gap:8px;max-width:100%}
.colorfield-alpha .hint{white-space:nowrap}
.colorfield-labels{display:flex;flex-direction:column;gap:1px;min-width:0}
.colorfield-name{font-size:13px;font-weight:600;color:var(--text)}
.colorfield-location{display:none;font-size:11px;line-height:1.35;color:var(--sub)}
.settings-reset-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 0 2px;border-top:1px dashed var(--line)}
.settings-reset-label{font-size:12px;color:var(--sub);font-weight:600}
.reset-button{white-space:nowrap}
.swatch-btn{position:relative;display:block;width:36px;height:36px;border-radius:10px;border:1px solid #d2d2d7;flex:none;cursor:pointer;overflow:hidden}
.swatch-btn:focus-within{outline:2px solid var(--blue);outline-offset:2px}
.app .swatch-btn input[type=color]{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;padding:0;border:0}
.preview-box{border-radius:14px;height:110px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:1px solid var(--line)}
.preview-box.small{height:56px}

.detail-image{display:flex;flex-direction:column;gap:8px}
.detail-image-grid{display:grid;grid-template-columns:1fr;gap:10px;width:100%;align-items:start}
.detail-image-btn{position:relative;border:1px solid var(--line);padding:0;background:var(--panel);display:block;width:100%;border-radius:12px;overflow:hidden;min-width:0}
.detail-image-btn.active{box-shadow:inset 0 0 0 2px var(--accent-ui)}
@media (max-width:699px){.detail-image.has-both .detail-image-btn:not(.active){display:none}}
.detail-image-label{position:absolute;left:8px;top:8px;background:rgba(0,0,0,.6);color:#fff;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:700}
.detail-image-mobile-switch{display:block}
@media (min-width:700px){
  .detail-image.has-both .detail-image-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .detail-image.has-both .detail-image-mobile-switch{display:none}
}
.detail-name{font-size:20px}
.info{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0}
.info dt{color:var(--sub)}.info dd{margin:0;overflow-wrap:anywhere}
.kv{display:flex;justify-content:flex-start;gap:20px;align-items:center}
.kv>span:first-child{color:var(--sub)}
.memo{white-space:pre-wrap;color:var(--sub)}

.manage-list{list-style:none;margin:0;padding:0;background:var(--panel);border-radius:12px;border:1px solid var(--line)}
.manage-list li{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--line)}
.manage-list li:last-child{border-bottom:0}
.manage-actions{display:flex;gap:2px}

.viewer-body{position:relative;flex:1;display:flex;align-items:center;justify-content:center;width:100%;min-width:0;color:#fff}
.viewer-scroll{position:absolute;inset:0;overflow-y:auto;display:flex;flex-direction:column}
.viewer-scroll .cimg{background:#000;margin:auto 0;flex:none}
.viewer-nav{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;background:rgba(0,0,0,.6);border-radius:99px;padding:4px 10px}
.viewer-nav button{border:0;background:none;color:#fff;font-size:26px;padding:0 10px}

.drawer-wrap{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.25);display:flex}
.drawer{width:min(300px,86vw);background:var(--panel);height:100%;overflow-y:auto;box-shadow:4px 0 20px rgba(0,0,0,.2);padding:8px 0 24px}
.drawer-head{display:flex;justify-content:space-between;align-items:center;padding:8px 16px}
.drawer-item{border:0;background:none;text-align:left;padding:9px 16px;width:100%;border-radius:0}
.drawer-item.on{color:var(--blue);font-weight:700}
.drawer-item.sub{padding-left:34px;font-size:14px}
.drawer-item.grow{flex:1}
.drawer-row{display:flex;align-items:center;padding-right:8px}
.drawer-packs{padding-bottom:6px}
.drawer-packs .hint{padding:4px 34px}
.drawer-packs .drawer-row{padding-left:30px;gap:8px}
.drawer-packs .drawer-row .drawer-item.sub{padding-left:4px}
.chev{display:inline-block;width:14px}
.drawer-add{display:flex;gap:8px;padding:16px;border-top:1px solid var(--line);margin-top:8px}
.drawer-add button{flex:none}

@media (prefers-reduced-motion:no-preference){.modal{animation:up .18s ease-out}.drawer{animation:in .18s ease-out}}
@keyframes up{from{transform:translateY(24px);opacity:.5}to{transform:none;opacity:1}}
@keyframes in{from{transform:translateX(-24px);opacity:.5}to{transform:none;opacity:1}}
`;