/**
 * OneDrive連携（サーバー側）
 *
 * 現時点の前提:
 * - アクセストークンは OAuth/MSAL（onedrive-auth.server 経由）で取得する
 * - 開発用途として、環境変数からアクセストークンを渡す経路もサポートする
 */

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

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

// OneDriveのユーザー情報
export type OneDriveUser = {
  id: string;
  displayName: string | null;
  userPrincipalName: string | null;
};

export type OneDriveDriveInfo = {
  id: string;
  driveType: string | null;
};

export interface OneDriveService {
  /** 指定パスにテキストを保存（存在しなければ作成、あれば上書き） */
  saveText(path: string, content: string): Promise<DriveItem>;
  /** 指定パスにバイナリを保存（存在しなければ作成、あれば上書き） */
  saveBinary(path: string, content: Uint8Array, contentType?: string): Promise<DriveItem>;
  /** テキストを取得 */
  getText(path: string): Promise<string>;
  /** 指定パスのアイテム情報を取得（未存在時は null） */
  getItem(path: string): Promise<DriveItem | null>;
  /** 指定パスのファイル/フォルダを削除 */
  deleteItem(path: string): Promise<void>;
  /** 現在のユーザー情報を取得 */
  getCurrentUser(): Promise<OneDriveUser>;
  /** 現在のドライブ情報を取得（セッション有効性確認に利用） */
  getDriveInfo(): Promise<OneDriveDriveInfo>;
}

// OneDrive APIのエラーレスポンス
type GraphErrorResponse = {
  error?: {
    code?: string;
    message?: string;
    innerError?: {
      "request-id"?: string;
      "client-request-id"?: string;
      date?: string;
    };
  };
};

// OneDrive APIのドライブアイテム情報
type GraphDriveItem = {
  id: string; // itemId
  name: string; // ファイル・フォルダ名
  webUrl?: string; // Web表示用URL
  size?: number; // バイト数
  file?: {
    mimeType?: string; // MIMEタイプ
  };
  folder?: unknown; // フォルダの場合に存在するフィールド
};

// OneDrive APIのユーザー情報
type GraphUser = {
  id: string;
  displayName?: string | null;
  userPrincipalName?: string | null;
};

// Graph APIで必要なスコープ
type GraphDrive = {
  id: string;
  driveType?: string | null;
};
export class OneDriveApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "OneDriveApiError";
    this.status = status;
    this.code = code;
  }
}
// Graph APIのエラーレスポンスを解析して、OneDriveApiErrorを構築するユーティリティ関数。
// これにより、APIエラーの詳細情報を含む例外を一元的に生成できるようになる。
function buildOneDriveApiError(response: Response, responseText: string): OneDriveApiError {
  let details = "";
  let errorCode = "";
  let errorMessage = "";
  let requestMeta = "";
  try {
    // Graph APIのエラー形式を解析して、エラーコードやメッセージ、リクエストIDなどの情報を抽出する。
    const json = JSON.parse(responseText) as GraphErrorResponse;
    errorCode = json.error?.code ?? "";
    errorMessage = json.error?.message ?? "";
    details = errorMessage ? `: ${errorMessage}` : "";
    const requestId =
      json.error?.innerError?.["request-id"] ?? response.headers.get("request-id") ?? "";
    const clientRequestId =
      json.error?.innerError?.["client-request-id"] ??
      response.headers.get("client-request-id") ??
      "";
    const date = json.error?.innerError?.date ?? response.headers.get("date") ?? "";
    const meta = [
      requestId ? `request-id=${requestId}` : "",
      clientRequestId ? `client-request-id=${clientRequestId}` : "",
      date ? `date=${date}` : "",
    ].filter(Boolean);
    requestMeta = meta.length > 0 ? ` [${meta.join(" ")}]` : "";
  } catch {
    const fallback = responseText.trim();
    if (fallback) {
      const summarized = fallback.length > 300 ? `${fallback.slice(0, 300)}...` : fallback;
      details = `: ${summarized}`;
    }
  }
  const codePart = errorCode ? ` [code=${errorCode}]` : "";
  return new OneDriveApiError(
    `OneDrive API error (${response.status})${codePart}${details}${requestMeta}`,
    response.status,
    errorCode || undefined,
  );
}

// パスの正規化とエンコード
function normalizeDrivePath(path: string) {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "")
    .replace(/\/+/g, "/");
}

// パスをURLエンコード（セグメントごとに）
function encodeDrivePath(path: string) {
  const normalized = normalizeDrivePath(path);
  if (!normalized) return "";
  return normalized.split("/").map(encodeURIComponent).join("/");
}

// Graph APIのドライブアイテムを内部のDriveItem型に変換する
function toDriveItem(item: GraphDriveItem): DriveItem {
  return {
    id: item.id,
    name: item.name,
    webUrl: item.webUrl ?? "",
    size: item.size,
    mimeType: item.file?.mimeType,
  };
}

// Graph APIを呼び出してJSONレスポンスを取得するユーティリティ
async function graphJson<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });

  // エラーハンドリング
  if (!response.ok) {
    throw buildOneDriveApiError(response, await response.text());
  }

  return (await response.json()) as T;
}

// Graph APIを呼び出してテキストレスポンスを取得するユーティリティ
async function graphText(accessToken: string, path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  // エラーハンドリング
  if (!response.ok) {
    throw buildOneDriveApiError(response, await response.text());
  }
  return await response.text();
}

async function graphVoid(accessToken: string, path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (response.ok) return;
  throw buildOneDriveApiError(response, await response.text());
}

// 指定パスのドライブアイテムのメタデータを取得するユーティリティ
async function getItemByPath(accessToken: string, path: string): Promise<GraphDriveItem> {
  // パスをエンコードしてAPIを呼び出す。これに成功すればアイテムの存在が確認できる。
  const encoded = encodeDrivePath(path);
  // メタデータ取得は末尾コロンが必要
  return await graphJson<GraphDriveItem>(accessToken, `/me/drive/root:/${encoded}:`, {
    method: "GET",
  });
}

// フォルダを作成するユーティリティ
async function createFolder(
  accessToken: string,
  parentId: "root" | DriveItemId,
  name: string,
): Promise<GraphDriveItem> {
  const body = {
    name,
    folder: {},
    "@microsoft.graph.conflictBehavior": "fail",
  };
  // parentIdが "root" の場合はルート直下に作成する。
  // それ以外は指定された親IDの下に作成する。これに成功すればフォルダが作成される。
  const path =
    parentId === "root"
      ? `/me/drive/root/children`
      : `/me/drive/items/${encodeURIComponent(parentId)}/children`;

  // 返り値は作成されたフォルダの情報。
  // これにより、次の階層の作成やファイルの保存に必要なIDやURLが得られる。
  return await graphJson<GraphDriveItem>(accessToken, path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// OneDrive上で指定フォルダ階層を存在させる（なければ作成する）
async function ensureFolderPath(accessToken: string, folderPath: string): Promise<void> {
  // フォルダパスを正規化して分割し、階層ごとに存在確認と作成を行う。
  const normalized = normalizeDrivePath(folderPath);
  if (!normalized) return;
  const segments = normalized.split("/").filter(Boolean);
  let parentId: "root" | DriveItemId = "root";
  let currentPath = "";

  // 各セグメントについて、存在確認と作成を行う。
  // これにより、必要なフォルダ階層がすべて確実に存在するようになる。
  for (const segment of segments) {
    // currentPathを更新する。これにより、エラー時のパス情報が正確になる。
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;

    // フォルダの存在確認をする。これに成功すれば次の階層へ進む。
    try {
      const existing = await getItemByPath(accessToken, currentPath);
      if (!existing.folder) {
        throw new Error(`OneDrive path is not a folder: ${currentPath}`);
      }
      parentId = existing.id;
      continue;
    } catch (error) {
      // 404（未作成）だけを許容し、それ以外は失敗として扱う。
      if (!(error instanceof OneDriveApiError) || error.status !== 404) throw error;
    }

    try {
      // フォルダが存在しない場合は作成する。これに成功すればフォルダが作成される。
      const created = await createFolder(accessToken, parentId, segment);
      parentId = created.id;
    } catch (createError) {
      // 競合 (409) の場合のみ再取得して進める。
      if (!(createError instanceof OneDriveApiError) || createError.status !== 409) {
        throw createError;
      }
      try {
        const existing = await getItemByPath(accessToken, currentPath);
        if (!existing.folder) {
          throw new Error(`OneDrive path is not a folder: ${currentPath}`);
        }
        parentId = existing.id;
      } catch (refetchError) {
        const createReason = createError instanceof Error ? createError.message : String(createError);
        const refetchReason = refetchError instanceof Error ? refetchError.message : String(refetchError);
        throw new Error(
          `Failed to ensure OneDrive folder path: ${currentPath} ` +
            `(create failed: ${createReason}; refetch failed: ${refetchReason})`,
        );
      }
    }
  }
}

export function createOneDriveService(auth: OneDriveAuth): OneDriveService {
  return {
    // テキスト保存ユーティリティ
    async saveText(path: string, content: string): Promise<DriveItem> {
      const normalized = normalizeDrivePath(path);
      if (!normalized) throw new Error("OneDrive saveText: path is empty");

      // フォルダパスを正規化して分割し、必要なフォルダ階層がすべて存在するようにする。
      const parts = normalized.split("/");
      const folderPath = parts.slice(0, -1).join("/");
      if (folderPath) {
        await ensureFolderPath(auth.accessToken, folderPath);
      }
      // ファイルパスをエンコードしてAPIを呼び出す。これに成功すればファイルが保存される。
      const encoded = encodeDrivePath(normalized);
      // コンテンツを保存する。これに成功すれば保存されたアイテムの情報が得られる。
      const item = await graphJson<GraphDriveItem>(
        auth.accessToken,
        `/me/drive/root:/${encoded}:/content`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
          body: content,
        },
      );

      return toDriveItem(item);
    },
    // バイナリ保存ユーティリティ
    async saveBinary(path: string, content: Uint8Array, contentType?: string): Promise<DriveItem> {
      const normalized = normalizeDrivePath(path);
      if (!normalized) throw new Error("OneDrive saveBinary: path is empty");

      const parts = normalized.split("/");
      const folderPath = parts.slice(0, -1).join("/");
      if (folderPath) {
        await ensureFolderPath(auth.accessToken, folderPath);
      }

      const encoded = encodeDrivePath(normalized);
      const binary = Uint8Array.from(content);
      const item = await graphJson<GraphDriveItem>(
        auth.accessToken,
        `/me/drive/root:/${encoded}:/content`,
        {
          method: "PUT",
          headers: {
            "Content-Type": contentType ?? "application/octet-stream",
          },
          body: new Blob([binary], { type: contentType ?? "application/octet-stream" }),
        },
      );
      return toDriveItem(item);
    },
    // テキスト取得ユーティリティ
    async getText(path: string): Promise<string> {
      // パス正規化とエンコード
      const normalized = normalizeDrivePath(path);
      if (!normalized) throw new Error("OneDrive getText: path is empty");
      const encoded = encodeDrivePath(normalized);
      // コンテンツ取得
      return await graphText(auth.accessToken, `/me/drive/root:/${encoded}:/content`, {
        method: "GET",
      });
    },
    // アイテム情報取得ユーティリティ
    async getItem(path: string): Promise<DriveItem | null> {
      const normalized = normalizeDrivePath(path);
      if (!normalized) throw new Error("OneDrive getItem: path is empty");
      const encoded = encodeDrivePath(normalized);
      try {
        const item = await graphJson<GraphDriveItem>(auth.accessToken, `/me/drive/root:/${encoded}:`, {
          method: "GET",
        });
        return toDriveItem(item);
      } catch (error) {
        if (error instanceof OneDriveApiError && error.status === 404) return null;
        throw error;
      }
    },
    // アイテム削除ユーティリティ
    async deleteItem(path: string): Promise<void> {
      const normalized = normalizeDrivePath(path);
      if (!normalized) throw new Error("OneDrive deleteItem: path is empty");
      const encoded = encodeDrivePath(normalized);
      try {
        await graphVoid(auth.accessToken, `/me/drive/root:/${encoded}:`, { method: "DELETE" });
      } catch (error) {
        // 既に削除済み(404)は成功扱いにする。
        if (error instanceof OneDriveApiError && error.status === 404) return;
        throw error;
      }
    },

    // 現在のユーザー情報を取得するユーティリティ
    async getCurrentUser(): Promise<OneDriveUser> {
      const user = await graphJson<GraphUser>(auth.accessToken, "/me", { method: "GET" });
      return {
        id: user.id,
        displayName: user.displayName ?? null,
        userPrincipalName: user.userPrincipalName ?? null,
      };
    },

    // ドライブ情報を取得するユーティリティ
    async getDriveInfo(): Promise<OneDriveDriveInfo> {
      const drive = await graphJson<GraphDrive>(auth.accessToken, "/me/drive?$select=id,driveType", {
        method: "GET",
      });
      return {
        id: drive.id,
        driveType: drive.driveType ?? null,
      };
    },
  };
}

/**
 * 環境変数または OAuth から OneDriveService を作る（開発用）。
 */
export async function createOneDriveServiceFromEnv(request?: Request): Promise<OneDriveService> {
  // request がないサーバー内部経路でのみ env token を利用する。
  const accessToken = process.env.ONEDRIVE_ACCESS_TOKEN ?? "";
  // request がある API 経路では、必ずその request の OAuth セッションを使う。
  const { getAccessToken } = await import("./onedrive-auth.server");

  if (request) {
    try {
      const oauthToken = await getAccessToken(request);
      return createOneDriveService({ accessToken: oauthToken });
    } catch (oauthError) {
      const reason = oauthError instanceof Error ? oauthError.message : String(oauthError);
      throw new Error(
        `OneDrive OAuth セッションからアクセストークンを取得できませんでした: ${reason} ` +
          `(request 経路では ONEDRIVE_ACCESS_TOKEN へはフォールバックしません。` +
          `/auth/onedrive/login で再認証してください。)`,
      );
    }
  }

  if (accessToken) {
    return createOneDriveService({ accessToken });
  }

  throw new Error(
    "OneDrive アクセストークンを解決できません。request なし経路では ONEDRIVE_ACCESS_TOKEN を設定してください。",
  );
}
