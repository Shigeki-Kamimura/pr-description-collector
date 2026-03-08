/* OneDrive APIのエラーメッセージから、エラーコードやユーザーフレンドリーなメッセージを抽出するユーティリティ関数。
  - OneDrive APIのエラーは、HTTPエラーやOAuthトークンエラーなど様々な形式で発生する可能性があるため、これらを正規表現で解析してコードやメッセージを抽出する。
  - これにより、APIレスポンスやUIでユーザーにわかりやすいエラーメッセージを提供できるようになる。
  - 例えば、認証エラーの場合は「OneDrive 認証が有効ではありません。Connect OneDrive から再認証してください。」のような具体的な案内を表示することができる。
  - これらの関数は、OneDrive APIを呼び出す際のエラーハンドリングで活用される。
*/

// OneDrive APIのエラーメッセージから、エラーコードやユーザーフレンドリーなメッセージを抽出する関数
export function extractOneDriveError(rawMessage: string): { code?: string; message?: string } {
  const codeMatch = rawMessage.match(/\[code=([^\]]+)\]/);
  const messageMatch = rawMessage.match(
    /OneDrive API error \(\d+\)(?: \[code=[^\]]+\])?:\s*([^()]+?)(?:\s+\(token|$)/,
  );
  const extractedMessage = messageMatch?.[1]?.trim();
  const sanitizedMessage = extractedMessage?.replace(
    /\s+\[(?=[^\]]*(?:request-id|client-request-id|date)=)[^\]]+\]\s*$/i,
    "",
  ).trim();
  return {
    code: codeMatch?.[1],
    message: sanitizedMessage,
  };
}
// OneDriveの認証エラーと推測されるかどうかを判定する関数
export function isOneDriveAuthLikeError(rawMessage: string): boolean {
  const message = rawMessage.toLowerCase();
  return (
    message.includes("onedrive oauth error") ||
    message.includes("onedrive api error (401)") ||
    message.includes("onedrive api error (403)") ||
    message.includes("[code=invalidauthenticationtoken]") ||
    message.includes("[code=accesstokenhasexpired]") ||
    message.includes("[code=accessdenied]")
  );
}
