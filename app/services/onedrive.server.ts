// OneDrive サービスの型定義のみ（実装なし）

export type OneDriveAuth = {
  /** Microsoft Entra ID (旧AAD) / MSAL経由のアクセストークン */
  accessToken: string;
};

export type DriveItemId = string;

export type DriveItem = {
  id: DriveItemId;
  name: string;
  webUrl: string;
  size?: number;
  mimeType?: string;
};

export interface OneDriveService {
  /** 指定パスにテキストを保存（存在しなければ作成、あれば上書き） */
  saveText(path: string, content: string): Promise<DriveItem>;
  /** テキストを取得 */
  getText(path: string): Promise<string>;
}
