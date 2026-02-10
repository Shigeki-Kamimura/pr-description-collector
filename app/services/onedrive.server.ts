/**
 * OneDrive連携（サーバー側）
 *
 * 現時点の前提:
 * - アクセストークンは環境変数から渡す（開発用）
 * - 認証フロー（OAuth/MSAL）は後続Issueで追加する
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

export interface OneDriveService {
  /** 指定パスにテキストを保存（存在しなければ作成、あれば上書き） */
  saveText(path: string, content: string): Promise<DriveItem>;
  /** テキストを取得 */
  getText(path: string): Promise<string>;
}

type GraphErrorResponse = {
  error?: {
    code?: string;
    message?: string;
  };
};

type GraphDriveItem = {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
  file?: {
    mimeType?: string;
  };
  folder?: unknown;
};

function normalizeDrivePath(path: string) {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "")
    .replace(/\/+/g, "/");
}

function encodeDrivePath(path: string) {
  const normalized = normalizeDrivePath(path);
  if (!normalized) return "";
  return normalized.split("/").map(encodeURIComponent).join("/");
}

function toDriveItem(item: GraphDriveItem): DriveItem {
  return {
    id: item.id,
    name: item.name,
    webUrl: item.webUrl ?? "",
    size: item.size,
    mimeType: item.file?.mimeType,
  };
}

async function graphJson<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let details = "";
    try {
      const json = (await response.json()) as GraphErrorResponse;
      const message = json.error?.message;
      details = message ? `: ${message}` : "";
    } catch {
      // ignore
    }
    throw new Error(`OneDrive API error (${response.status})${details}`);
  }

  return (await response.json()) as T;
}

async function graphText(accessToken: string, path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`OneDrive API error (${response.status})`);
  }
  return await response.text();
}

async function getItemByPath(accessToken: string, path: string): Promise<GraphDriveItem> {
  const encoded = encodeDrivePath(path);
  // メタデータ取得は末尾コロンが必要
  return await graphJson<GraphDriveItem>(accessToken, `/me/drive/root:/${encoded}:`, {
    method: "GET",
  });
}

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

  const path =
    parentId === "root"
      ? `/me/drive/root/children`
      : `/me/drive/items/${encodeURIComponent(parentId)}/children`;

  return await graphJson<GraphDriveItem>(accessToken, path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function ensureFolderPath(accessToken: string, folderPath: string): Promise<void> {
  const normalized = normalizeDrivePath(folderPath);
  if (!normalized) return;

  const segments = normalized.split("/").filter(Boolean);
  let parentId: "root" | DriveItemId = "root";
  let currentPath = "";

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;

    try {
      const existing = await getItemByPath(accessToken, currentPath);
      if (!existing.folder) {
        throw new Error(`OneDrive path is not a folder: ${currentPath}`);
      }
      parentId = existing.id;
      continue;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const isNotFound = message.includes("(404)");
      if (!isNotFound) throw error;
    }

    try {
      const created = await createFolder(accessToken, parentId, segment);
      parentId = created.id;
    } catch (error) {
      // 競合などが起きた場合は再取得して進める
      const existing = await getItemByPath(accessToken, currentPath);
      if (!existing.folder) {
        throw new Error(`OneDrive path is not a folder: ${currentPath}`);
      }
      parentId = existing.id;
    }
  }
}

export function createOneDriveService(auth: OneDriveAuth): OneDriveService {
  return {
    async saveText(path: string, content: string): Promise<DriveItem> {
      const normalized = normalizeDrivePath(path);
      if (!normalized) throw new Error("OneDrive saveText: path is empty");

      const parts = normalized.split("/");
      const folderPath = parts.slice(0, -1).join("/");
      if (folderPath) {
        await ensureFolderPath(auth.accessToken, folderPath);
      }

      const encoded = encodeDrivePath(normalized);
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

    async getText(path: string): Promise<string> {
      const normalized = normalizeDrivePath(path);
      if (!normalized) throw new Error("OneDrive getText: path is empty");
      const encoded = encodeDrivePath(normalized);
      return await graphText(auth.accessToken, `/me/drive/root:/${encoded}:/content`, {
        method: "GET",
      });
    },
  };
}

/**
 * 環境変数または OAuth から OneDriveService を作る（開発用）。
 */
export async function createOneDriveServiceFromEnv(): Promise<OneDriveService> {
  const accessToken = process.env.ONEDRIVE_ACCESS_TOKEN ?? "";
  if (accessToken) {
    return createOneDriveService({ accessToken });
  }

  const { getAccessToken } = await import("./onedrive-auth.server");
  const oauthToken = await getAccessToken();
  return createOneDriveService({ accessToken: oauthToken });
}
