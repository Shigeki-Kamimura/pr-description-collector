/**
 * パス生成ユーティリティ
 *
 * このファイルを用意した理由:
 * - OneDrive保存先パスで使用するスラッグ化ロジックを1箇所に集約し、
 *   upload/archive 間の実装乖離による保存先不一致を防ぐため。
 *
 * このファイルが使われる場面:
 * - PRタイトルから OneDrive フォルダ名を生成するとき。
 */
export function slugifyForPath(value: string): string {
  const normalized = value
    .normalize("NFC")
    // OneDrive/Windowsで禁止される文字だけ除去し、日本語は保持する。
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "");

  // サロゲートペアを壊さず、かつ過度に長いマルチバイト文字列を避けるため、
  // コードポイント数と UTF-8 バイト長の両方で上限を適用する。
  const maxCodePoints = 80;
  const maxUtf8Bytes = 160;
  const encoder = new TextEncoder();
  let result = "";
  let codePointCount = 0;
  let utf8ByteCount = 0;

  for (const char of normalized) {
    const charBytes = encoder.encode(char).length;
    if (codePointCount + 1 > maxCodePoints || utf8ByteCount + charBytes > maxUtf8Bytes) {
      break;
    }
    result += char;
    codePointCount += 1;
    utf8ByteCount += charBytes;
  }

  return result;
}
