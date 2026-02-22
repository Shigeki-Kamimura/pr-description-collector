/**
 * PR本文に含まれるエビデンス画像URLの抽出・取得・保存名決定を行うサービス。
 *
 * このファイルを用意した理由:
 * - 画像処理ロジック（重複排除、リトライ、タイムアウト、ファイル名決定）を
 *   ルートから分離し、仕様変更時の影響範囲を小さく保つため。
 *
 * このファイルが使われる場面:
 * - `/api/onedrive/upload` が PR本文から画像URLを処理し、
 *   OneDrive へ保存する前段の判定・ダウンロード処理を実行するとき。
 */
type DownloadImageOptions = {
  timeoutMs: number;
  maxAttempts: number;
  maxBytes: number;
  fetchFn?: typeof fetch;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_MAX_MS = 10_000;
const DEFAULT_ALLOWED_IMAGE_HOSTS = [
  "github.com",
  "user-images.githubusercontent.com",
  "github-production-user-asset-6210df.s3.amazonaws.com",
];

export type EvidenceDownloadSuccess = {
  bytes: Uint8Array;
  contentType: string | null;
};

export type EvidenceDownloadFailure = {
  ok: false;
  errorReason: string;
};

export function extractUniqueImageUrls(markdown: string): string[] {
  if (!markdown) return [];

  const urls: string[] = [];
  const seen = new Set<string>();
  const pushIfNew = (rawUrl: string) => {
    const url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  const markdownUrls = extractMarkdownImageUrls(markdown);
  for (const url of markdownUrls) {
    pushIfNew(url);
  }
  // HTMLの<img>タグからもURLを抽出する。Markdown形式でない画像が貼られている可能性があるため。
  const htmlImgRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let imgMatch: RegExpExecArray | null = null;
  while ((imgMatch = htmlImgRegex.exec(markdown)) !== null) {
    pushIfNew(imgMatch[1] ?? "");
  }
  // Markdown形式やHTMLタグでない、単なるURLとして記載されている画像も抽出する。
  const plainUrls = extractPlainImageUrls(markdown);
  for (const url of plainUrls) {
    pushIfNew(url);
  }

  return urls;
}

// Markdownの画像記法からURLを抽出する。例: ![alt](url "title") など
function extractMarkdownImageUrls(markdown: string): string[] {
  const urls: string[] = [];
  let cursor = 0;

  while (cursor < markdown.length) {
    const imageStart = markdown.indexOf("![", cursor);
    if (imageStart < 0) break;

    const altClose = markdown.indexOf("]", imageStart + 2);
    if (altClose < 0) break;

    let openParen = altClose + 1;
    while (openParen < markdown.length && /\s/.test(markdown[openParen] ?? "")) {
      openParen += 1;
    }
    if (markdown[openParen] !== "(") {
      cursor = altClose + 1;
      continue;
    }

    const destinationStart = openParen + 1;
    const parsed = parseMarkdownDestination(markdown, destinationStart);
    if (!parsed) {
      cursor = destinationStart;
      continue;
    }
    urls.push(parsed.url);
    cursor = parsed.nextIndex;
  }

  return urls;
}

function parseMarkdownDestination(
  markdown: string,
  start: number,
): { url: string; nextIndex: number } | null {
  let i = start;
  while (i < markdown.length && /\s/.test(markdown[i] ?? "")) {
    i += 1;
  }
  if (i >= markdown.length) return null;

  if (markdown[i] === "<") {
    const close = markdown.indexOf(">", i + 1);
    if (close < 0) return null;
    const url = markdown.slice(i + 1, close).trim();
    const end = markdown.indexOf(")", close + 1);
    return { url, nextIndex: end >= 0 ? end + 1 : close + 1 };
  }

  let url = "";
  let depth = 0;
  for (; i < markdown.length; i += 1) {
    const char = markdown[i] ?? "";
    if (char === "\\") {
      const next = markdown[i + 1] ?? "";
      if (next) {
        url += next;
        i += 1;
        continue;
      }
    }
    if (char === "(") {
      depth += 1;
      url += char;
      continue;
    }
    if (char === ")") {
      if (depth === 0) {
        return { url: url.trim(), nextIndex: i + 1 };
      }
      depth -= 1;
      url += char;
      continue;
    }
    if (depth === 0 && /\s/.test(char)) {
      const end = markdown.indexOf(")", i + 1);
      return { url: url.trim(), nextIndex: end >= 0 ? end + 1 : i + 1 };
    }
    url += char;
  }

  return null;
}

function extractPlainImageUrls(markdown: string): string[] {
  const urls: string[] = [];
  const plainUrlRegex = /https?:\/\/[^\s<>"')]+/gi;
  let match: RegExpExecArray | null = null;
  while ((match = plainUrlRegex.exec(markdown)) !== null) {
    const url = (match[0] ?? "").replace(/[.,;:!?]+$/g, "");
    if (!url) continue;
    if (!isLikelyImageUrl(url)) continue;
    urls.push(url);
  }
  return urls;
}

function isLikelyImageUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.toLowerCase();

    if (/\.(png|jpe?g|gif|webp|svg|bmp)(?:$|\?)/i.test(path)) {
      return true;
    }

    // GitHubの添付画像URL（拡張子なしでも画像へリダイレクトされる）。
    if (
      parsed.hostname === "github.com" &&
      path.startsWith("/user-attachments/assets/")
    ) {
      return true;
    }

    if (
      parsed.hostname === "user-images.githubusercontent.com" ||
      parsed.hostname === "github-production-user-asset-6210df.s3.amazonaws.com"
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
// EvidenceDownloadFailure の errorReason 値の例:
// - "INVALID_URL": URLとして不正な文字列だった場合。
// - "UNSUPPORTED_PROTOCOL": http: または https: 以外のスキームだった場合。
// - "BLOCKED_PRIVATE_HOST": localhost やプライベートIPアドレスなど、アクセスがブロックされるホストだった場合。
// - "BLOCKED_UNTRUSTED_HOST": 許可ドメイン以外のホストだった場合。
// - "TIMEOUT": ダウンロードがタイムアウトした場合。abortController を使用して fetch を中断した結果。
// - "NETWORK_ERROR": ネットワークエラーなどで fetch が失敗した場合。
// - "HTTP_404", "HTTP_500" など: HTTPステータスコードが200以外で返ってきた場合。
// - "PAYLOAD_TOO_LARGE": ダウンロードサイズが上限を超えた場合。
// - "UNEXPECTED_ERROR: <message>": 上記以外の予期しないエラーが発生した場合。
export async function downloadImageWithRetry(
  url: string,
  {
    timeoutMs = 180_000,
    maxAttempts = 3,
    maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES,
    fetchFn = fetch,
  }: Partial<DownloadImageOptions> = {},
): Promise<EvidenceDownloadSuccess | EvidenceDownloadFailure> {
  // 事前にURLのホストがブロック対象かどうかをチェックする。
  const blockedReason = getBlockedHostReason(url);
  if (blockedReason) {
    return { ok: false, errorReason: blockedReason };
  }
  let lastReason = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        const reason = `HTTP_${response.status}`;
        const retryable = RETRYABLE_STATUS.has(response.status);
        // リトライ可能で、かつまだリトライ回数が残っている場合は待機してから再試行する。そうでない場合は失敗として返す。
        if (retryable && attempt < maxAttempts) {
          lastReason = reason;
          await waitBeforeRetry(attempt, response.headers.get("retry-after"));
          continue;
        }
        return { ok: false, errorReason: reason };
      }
      const contentLength = getContentLength(response.headers.get("content-length"));
      if (contentLength !== null && contentLength > maxBytes) {
        return { ok: false, errorReason: "PAYLOAD_TOO_LARGE" };
      }
      const contentType = response.headers.get("content-type");
      const data = await readResponseBytesWithLimit(response, maxBytes);
      return {
        bytes: data,
        contentType,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "PAYLOAD_TOO_LARGE") {
        return { ok: false, errorReason: "PAYLOAD_TOO_LARGE" };
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        lastReason = "TIMEOUT";
        if (attempt < maxAttempts) {
          await waitBeforeRetry(attempt);
          continue;
        }
        return { ok: false, errorReason: "TIMEOUT" };
      }
      if (error instanceof TypeError) {
        lastReason = "NETWORK_ERROR";
        if (attempt < maxAttempts) {
          await waitBeforeRetry(attempt);
          continue;
        }
        return { ok: false, errorReason: "NETWORK_ERROR" };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, errorReason: `UNEXPECTED_ERROR: ${message}` };
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return { ok: false, errorReason: lastReason };
}

// リトライの待機時間を計算して待機する。リトライ回数に応じた指数バックオフと、サーバーからの Retry-After ヘッダーの両方を考慮する。
async function waitBeforeRetry(attempt: number, retryAfter: string | null = null): Promise<void> {
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  const backoffMs = Math.min(RETRY_BACKOFF_BASE_MS * attempt, RETRY_BACKOFF_MAX_MS);
  const delayMs = retryAfterMs ?? backoffMs;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

// Retry-After ヘッダーの値を解析して、次のリクエストまで待つべき時間をミリ秒で返す。値が無効な場合は null を返す。
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  const deltaMs = dateMs - Date.now();
  if (deltaMs <= 0) return null;
  return deltaMs;
}

function getContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

async function readResponseBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(await response.arrayBuffer());

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // noop
      }
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

// URLのホストがブロック対象かどうかをチェックする。理由があれば文字列で返し、問題なければ null を返す。
function getBlockedHostReason(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "INVALID_URL";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "UNSUPPORTED_PROTOCOL";
  }

  let host = parsed.hostname.trim().toLowerCase();
  if (!host) return "INVALID_HOST";
  host = stripIpv6Brackets(host);

  if (host === "localhost" || host.endsWith(".localhost")) {
    return "BLOCKED_PRIVATE_HOST";
  }

  if (isPrivateIpv4(host)) {
    return "BLOCKED_PRIVATE_HOST";
  }

  if (isPrivateIpv6(host)) {
    return "BLOCKED_PRIVATE_HOST";
  }

  if (!isAllowedImageHost(host)) {
    return "BLOCKED_UNTRUSTED_HOST";
  }

  return null;
}

// ホストが許可ドメインリストにマッチするかどうかをチェックする。サブドメインも許可する。
function isAllowedImageHost(host: string): boolean {
  const allowedHosts = getAllowedImageHosts();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
// 環境変数から許可ドメインリストを取得する。未設定や空文字の場合はデフォルトリストを返す。
function getAllowedImageHosts(): string[] {
  const raw = process.env.ONEDRIVE_EVIDENCE_IMAGE_ALLOWED_HOSTS;
  if (!raw) return DEFAULT_ALLOWED_IMAGE_HOSTS;
  const parsed = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_IMAGE_HOSTS;
}
// IPv6アドレスはURLで[ ]で括られることがあるため、括弧を取り除いて正規化する。
function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}
// RFC 1918, RFC 3330, RFC 6598 に定義されたプライベートIPv4アドレスを拒否する。
function isPrivateIpv4(host: string): boolean {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;

  // loopback, private, link-local, CGNAT, unspecified を拒否する。
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 0
  );
}
// RFC 4193 の Unique Local Address と RFC 4291 の Link-Local Address を拒否する。
function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (!normalized.includes(":")) return false;

  if (normalized === "::1" || normalized === "::") return true;

  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }

  const firstSegment = normalized.split(":")[0] ?? "";
  const first = Number.parseInt(firstSegment || "0", 16);
  if (Number.isNaN(first)) return false;

  // fc00::/7 (ULA), fe80::/10 (link-local)
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  if (first >= 0xfe80 && first <= 0xfebf) return true;

  return false;
}

function normalizeFileNameSegment(value: string): string {
  const sanitized = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "");
  return sanitized || "image";
}

function inferExtFromContentType(contentType: string | null): string {
  if (!contentType) return "";
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/bmp":
      return ".bmp";
    default:
      return "";
  }
}

export function buildImageBaseName(url: string, contentType: string | null): string {
  let fromUrl = "";
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
    fromUrl = decodeURIComponent(tail);
  } catch {
    fromUrl = "";
  }
  const cleaned = normalizeFileNameSegment(fromUrl.replace(/[#?].*$/, ""));
  const dot = cleaned.lastIndexOf(".");
  if (dot > 0 && dot < cleaned.length - 1) {
    return cleaned;
  }
  const ext = inferExtFromContentType(contentType);
  return ext ? `${cleaned}${ext}` : cleaned;
}
