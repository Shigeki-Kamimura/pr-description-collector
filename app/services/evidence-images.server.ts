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
  fetchFn?: typeof fetch;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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

export async function downloadImageWithRetry(
  url: string,
  {
    timeoutMs = 180_000,
    maxAttempts = 3,
    fetchFn = fetch,
  }: Partial<DownloadImageOptions> = {},
): Promise<EvidenceDownloadSuccess | EvidenceDownloadFailure> {
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
        if (retryable && attempt < maxAttempts) {
          lastReason = reason;
          continue;
        }
        return { ok: false, errorReason: reason };
      }
      const contentType = response.headers.get("content-type");
      const data = new Uint8Array(await response.arrayBuffer());
      return {
        bytes: data,
        contentType,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        lastReason = "TIMEOUT";
        if (attempt < maxAttempts) continue;
        return { ok: false, errorReason: "TIMEOUT" };
      }
      if (error instanceof TypeError) {
        lastReason = "NETWORK_ERROR";
        if (attempt < maxAttempts) continue;
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
