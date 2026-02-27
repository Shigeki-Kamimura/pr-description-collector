import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { parseChecklist, summarize, type Checklist } from "../services/checklist";
import { isSamePrRef, normalizePrRef, type PrRefInput } from "../services/pr-ref";
import type { ApiCollectResponse } from "./api.collect";
import type { ApiOneDriveArchiveResponse } from "./api.onedrive.archive";
import type { ApiOneDriveUploadResponse } from "./api.onedrive.upload";
import type { ApiOneDriveSessionStatusResponse } from "./api.onedrive.session-status";
import { createGitHubServiceFromEnv, type PullRequestRef } from "../services/github.server";
import { INVALID_PR_REF_ERROR, validatePrRefFields, validatePrRefInput } from "../services/validation";
import { getHttpStatus } from "../services/http-status";
import { ensureCsrfToken, verifyCsrfToken } from "../services/csrf.server";
import { normalizeEvidenceSourceUrl } from "../services/evidence-url";

import { OneDriveAuthDialog } from "../components/OneDriveAuthDialog";
import { SaveErrorDialog } from "../components/SaveErrorDialog";
import { SavingDialog } from "../components/SavingDialog";
import { SuccessDialog } from "../components/SuccessDialog";
import { ChecklistCard } from "../components/ChecklistCard";

/**
 * ルート: /
 * この画面は仮です。後続IssueでUI強化予定。
 * この画面の責務:
 * - PR description（Markdown）の表示
 * - 「Get Description」でGitHubからPR本文を取得して表示する
 * - 「Parse Checklist」でMarkdownのチェックリストを解析して表示する
 *
 * 設計メモ:
 * - GitHub取得は fetcher（/api/collect）で実行し、ページ遷移なしで反映
 * - チェックリスト解析はこのルートの action で実行（既存フローを維持）
 */

export const meta = () => [{ title: "PR Description Collector" }];

type ActionData =
  | { ok: true; description: string; result: Checklist }
  | { ok: false; error: string };
type LoaderData = { csrfToken: string };

const FETCHER_TRANSPORT_ERROR_KEY = "fetcher-transport-error";
const FETCHER_TRANSPORT_ERROR_MESSAGE =
  "サーバーエラーが発生しました。トップページに戻りました。しばらくしてから再実行してください。";
const OAUTH_CALLBACK_ERROR_MESSAGE =
  "OneDrive 認証に失敗しました。Connect OneDrive から再試行してください。";
const CSRF_ERROR_MESSAGE = "不正なリクエストです。ページを再読み込みして再試行してください。";
// Evidence画像URLがhttp(s)で始まるURLであれば返す。それ以外はnullを返す。
const CHECKBOX_LINE_RE = /^\s*(?:[*-]|\d+\.)\s*\[(?: |x|X)\]\s*/;
const RESULT_LINE_RE = /^\s*Result[：:]\s*(.*)$/i;
const EVIDENCE_LINE_RE = /^\s*Evidence[：:]\s*(.*)$/i;
const MARKDOWN_IMAGE_URL_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i;
const PLAIN_HTTP_URL_RE = /(https?:\/\/[^\s)]+)/i;
// PR descriptionから、チェックリストの各行に対するResult: の内容を抽出する。
export function extractResultByChecklistLine(description: string): Record<number, string> {
  const lines = description.split(/\r?\n/);
  const resultByLine: Record<number, string> = {};

  for (let i = 0; i < lines.length; i += 1) {
    if (!CHECKBOX_LINE_RE.test(lines[i])) continue;
    let nextChecklist = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (CHECKBOX_LINE_RE.test(lines[j])) {
        nextChecklist = j;
        break;
      }
    }
    for (let k = i + 1; k < nextChecklist; k += 1) {
      const matched = lines[k].match(RESULT_LINE_RE);
      if (!matched) continue;
      const extracted = matched[1].trim();
      resultByLine[i + 1] = extracted.length > 0 ? extracted : "未設定";
      break;
    }
  }

  return resultByLine;
}
// チェックリストの次のチェックリストまでの行を順に見ていき、最初に見つかったEvidence: の内容を抽出する。
function extractHttpUrl(value: string): string | null {
  const markdownImageMatched = value.match(MARKDOWN_IMAGE_URL_RE)?.[1];
  const plainUrlMatched = value.match(PLAIN_HTTP_URL_RE)?.[1];
  const candidate = markdownImageMatched ?? plainUrlMatched ?? "";
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

// PR descriptionから、チェックリストの各行に対するEvidence画像URLを抽出する。
export function extractEvidenceImageByChecklistLine(description: string): Record<number, string> {
  const lines = description.split(/\r?\n/);
  const evidenceByLine: Record<number, string> = {};

  for (let i = 0; i < lines.length; i += 1) {
    if (!CHECKBOX_LINE_RE.test(lines[i])) continue;
    let nextChecklist = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (CHECKBOX_LINE_RE.test(lines[j])) {
        nextChecklist = j;
        break;
      }
    }
    for (let k = i + 1; k < nextChecklist; k += 1) {
      const matched = lines[k].match(EVIDENCE_LINE_RE);
      if (!matched) continue;
      const url = extractHttpUrl(matched[1]?.trim() ?? "");
      if (url) {
        evidenceByLine[i + 1] = url;
      }
      break;
    }
  }

  return evidenceByLine;
}
// Evidence画像URLは、Markdownの画像URL形式かプレーンなHTTP URL形式で記載されることを想定している。
// 両方に対応するため、Markdown画像URL形式を優先的に抽出し、次にプレーンなHTTP URL形式を抽出する。
function buildEvidenceImageApiUrl(onedrivePath: string, imageAccessToken: string): string {
  const params = new URLSearchParams({ path: onedrivePath, token: imageAccessToken });
  return `/api/onedrive/evidence-image?${params.toString()}`;
}

type ImageErrorDialogInfo = { message: string; isAuthError: boolean } | null;
// 保存済み画像の表示に失敗した場合のエラー内容を、HTTPステータスコードからユーザー向けのメッセージと認証エラーかどうかのフラグにマッピングする。
type UploadEvidenceSummary = {
  total: number;
  success: number;
  failed: number;
  alreadySaved: number;
};

export function mapPrimaryImageErrorToDialog(status: number): ImageErrorDialogInfo {
  switch (status) {
    case 401:
      return {
        message: "保存済み画像の表示に失敗しました（OneDrive 認証エラー）。",
        isAuthError: true,
      };
    case 403:
      return {
        message: "保存済み画像の表示に失敗しました（OneDrive 権限不足）。",
        isAuthError: false,
      };
    case 429:
      return {
        message:
          "保存済み画像の表示に失敗しました（OneDrive レート制限）。しばらく待って再試行してください。",
        isAuthError: false,
      };
    default:
      return status >= 500
        ? {
            message: "保存済み画像の表示に失敗しました（OneDrive 側の一時障害）。",
            isAuthError: false,
          }
        : null;
  }
}

function isFetcherApiResponse(value: unknown): value is { ok: boolean } {
  return typeof value === "object" && value !== null && typeof (value as { ok?: unknown }).ok === "boolean";
}
// 保存結果のサマリーから、すべての画像の保存に失敗しているかどうかを判定する。
// これにより、OneDrive 上の imgs フォルダ構成や権限の問題で画像が保存できていないケースを検出し、ユーザーに適切なエラーメッセージを表示できるようにする。
export function shouldShowUploadAllEvidenceFailedError(summary: UploadEvidenceSummary | null | undefined): boolean {
  if (!summary) return false;
  return summary.total > 0 && summary.success === 0 && summary.failed > 0;
}
// APIからのエラーは、ユーザーに画面上の注釈で表示するため、APIエラーがある場合はエラー表示用ダイアログは開かないようにする。
export function shouldUseArchiveChecklistFallback(data: ActionData | undefined): boolean {
  return Boolean(
    data &&
      !data.ok &&
      data.error !== INVALID_PR_REF_ERROR &&
      data.error !== CSRF_ERROR_MESSAGE,
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { token, setCookie } = await ensureCsrfToken(request);
  return Response.json(
    { csrfToken: token } satisfies LoaderData,
    { headers: setCookie ? { "Set-Cookie": setCookie } : undefined },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const validation = validatePrRefInput(formData);
  if (!validation.ok) {
    return Response.json(
      { ok: false, error: validation.error } satisfies ActionData,
      { status: 400 },
    );
  }
  if (!(await verifyCsrfToken(request, formData))) {
    return Response.json(
      {
        ok: false,
        error: "不正なリクエストです。ページを再読み込みして再試行してください。",
      } satisfies ActionData,
      { status: 403 },
    );
  }

  try {
    const github = await createGitHubServiceFromEnv();
    const ref: PullRequestRef = {
      repo: { owner: validation.owner, name: validation.repo },
      number: validation.prNumber,
    };
    const pullRequest = await github.getPullRequest(ref);
    const description = pullRequest.body;
    const result = parseChecklist(description);

    return Response.json(
      { ok: true, description, result } satisfies ActionData,
      { status: 200 },
    );
  } catch (error) {
    const status = getHttpStatus(error);
    if (status !== null) {
      switch (status) {
        case 401:
          return Response.json(
            { ok: false, error: "GitHub認証に失敗しました。トークンを確認してください。" },
            { status: 401 },
          );
        case 403:
          return Response.json(
            { ok: false, error: "アクセスが拒否されました。権限またはレート制限を確認してください。" },
            { status: 403 },
          );
        case 404:
          return Response.json(
            { ok: false, error: "指定されたPRが見つかりません。owner/repo/prNumber を確認してください。" },
            { status: 404 },
          );
        case 429:
          return Response.json(
            { ok: false, error: "レート制限のため一時的に失敗しました。しばらくしてから再実行してください。" },
            { status: 429 },
          );
        default:
          return Response.json(
            { ok: false, error: "GitHub API への接続に失敗しました。しばらくしてから再実行してください。" },
            { status: 502 },
          );
      }
    }

    return Response.json(
      { ok: false, error: "GitHub API への接続に失敗しました。しばらくしてから再実行してください。" },
      { status: 502 },
    );
  }
}

export default function Index() {
  const { csrfToken } = useLoaderData<LoaderData>();
  const data = useActionData<ActionData>();

  const collectFetcher = useFetcher<ApiCollectResponse>();
  const archiveFetcher = useFetcher<ApiOneDriveArchiveResponse>();
  const uploadFetcher = useFetcher<ApiOneDriveUploadResponse>();
  const sessionStatusFetcher = useFetcher<ApiOneDriveSessionStatusResponse>();

  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [showPrRefAnnotation, setShowPrRefAnnotation] = useState(false);
  const [showCollectErrorAnnotation, setShowCollectErrorAnnotation] = useState(false);
  const [showParseErrorAnnotation, setShowParseErrorAnnotation] = useState(false);
  const [pendingCollectRef, setPendingCollectRef] = useState<PrRefInput | null>(null);
  const [lastCollectedRef, setLastCollectedRef] = useState<PrRefInput | null>(null);

  const currentPrRef = useMemo(
    () => normalizePrRef({ owner, repo, prNumber }),
    [owner, repo, prNumber],
  );
  const prRefValidation = useMemo(
    () => validatePrRefFields(owner, repo, prNumber),
    [owner, repo, prNumber],
  );

  const descriptionText = useMemo(() => {
    if (collectFetcher.data?.ok) return collectFetcher.data.description;
    if (data?.ok) return data.description;
    return "";
  }, [collectFetcher.data, data]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.sessionStorage.getItem("pr-ref");
      if (!raw) return;
      const saved = JSON.parse(raw) as { owner?: string; repo?: string; prNumber?: string };
      if (saved.owner) setOwner((prev) => prev || saved.owner || "");
      if (saved.repo) setRepo((prev) => prev || saved.repo || "");
      if (saved.prNumber) setPrNumber((prev) => prev || saved.prNumber || "");
    } catch {
      // ignore invalid sessionStorage payload
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = JSON.stringify({ owner, repo, prNumber });
    window.sessionStorage.setItem("pr-ref", payload);
  }, [owner, repo, prNumber]);

  const collectError = useMemo(() => {
    return collectFetcher.data && !collectFetcher.data.ok
      ? collectFetcher.data.error
      : null;
  }, [collectFetcher.data]);

  const uploadError = useMemo(() => {
    return uploadFetcher.data && !uploadFetcher.data.ok
      ? uploadFetcher.data.error
      : null;
  }, [uploadFetcher.data]);
  const uploadValidationError = useMemo(() => {
    return uploadError === INVALID_PR_REF_ERROR ? uploadError : null;
  }, [uploadError]);

  const sessionStatusError = useMemo(() => {
    return sessionStatusFetcher.data && !sessionStatusFetcher.data.ok
      ? sessionStatusFetcher.data.error
      : null;
  }, [sessionStatusFetcher.data]);
  const archiveError = useMemo(() => {
    return archiveFetcher.data && !archiveFetcher.data.ok
      ? archiveFetcher.data.error
      : null;
  }, [archiveFetcher.data]);

  const [searchParams, setSearchParams] = useSearchParams();
  const onedriveConnected = searchParams.get("onedrive") === "connected";
  const onedriveOAuthFailed = searchParams.get("onedrive") === "oauth_failed";
  const [isCheckingOneDriveSession, setIsCheckingOneDriveSession] = useState(false);
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  const [isErrorDialogOpen, setIsErrorDialogOpen] = useState(false);
  const [isSuccessDialogOpen, setIsSuccessDialogOpen] = useState(false);
  const [isDescriptionOpen, setIsDescriptionOpen] = useState(true);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [uploadResultError, setUploadResultError] = useState<string | null>(null);
  const [primaryImageErrorDialog, setPrimaryImageErrorDialog] = useState<ImageErrorDialogInfo>(null);
  const primaryImageErrorKeyRef = useRef<string | null>(null);
  const collectRequestStartedRef = useRef(false);
  const uploadRequestStartedRef = useRef(false);
  const sessionStatusRequestStartedRef = useRef(false);
  const archiveRequestStartedRef = useRef(false);
  const archiveLookupKeyRef = useRef<string | null>(null);
  const archiveRefreshOnUploadKeyRef = useRef<string | null>(null);
  const archiveRequestedKeyRef = useRef<string | null>(null);
  const [archiveDataKey, setArchiveDataKey] = useState<string | null>(null);
  // prRefValidationの内容から、現在表示しているPRを一意に識別するキーを生成する。
  // prRefValidationが有効でない場合はnullになる。
  const currentPrKey = useMemo(
    () =>
      prRefValidation.ok
        ? `${prRefValidation.owner}/${prRefValidation.repo}#${prRefValidation.prNumber}`
        : null,
    [prRefValidation],
  );
  const activeChecklistPrKey = useMemo(
    () =>
      data && prRefValidation.ok
        ? `${prRefValidation.owner}/${prRefValidation.repo}#${prRefValidation.prNumber}`
        : null,
    [data, prRefValidation],
  );
  const canAutoLookupArchive = Boolean(
    sessionStatusFetcher.data?.ok || uploadFetcher.data?.ok || archiveFetcher.data?.ok,
  );

  const redirectToTopOnTransportError = () => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(FETCHER_TRANSPORT_ERROR_KEY, FETCHER_TRANSPORT_ERROR_MESSAGE);
    window.location.assign("/");
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const persistedError = window.sessionStorage.getItem(FETCHER_TRANSPORT_ERROR_KEY);
    if (!persistedError) return;
    setTransportError(persistedError);
    window.sessionStorage.removeItem(FETCHER_TRANSPORT_ERROR_KEY);
  }, []);

  const archiveErrorForCurrentPr =
    archiveError && currentPrKey && archiveDataKey === currentPrKey
      ? archiveError
      : null;
  const shouldShowArchiveErrorDialog = data !== undefined;
  const effectiveError =
    uploadResultError ??
    (uploadError && uploadError !== INVALID_PR_REF_ERROR ? uploadError : null) ??
    sessionStatusError ??
    (shouldShowArchiveErrorDialog ? archiveErrorForCurrentPr : null);
  const effectiveErrorCode =
    (uploadFetcher.data && !uploadFetcher.data.ok ? uploadFetcher.data.errorCode : undefined) ??
    (archiveFetcher.data &&
    !archiveFetcher.data.ok &&
    archiveDataKey === currentPrKey
      ? archiveFetcher.data.errorCode
      : undefined);
  const isAuthError =
    (uploadFetcher.data && !uploadFetcher.data.ok && uploadFetcher.data.isAuthError) ||
    (sessionStatusFetcher.data &&
      !sessionStatusFetcher.data.ok &&
      sessionStatusFetcher.data.isAuthError) ||
    (archiveFetcher.data &&
      !archiveFetcher.data.ok &&
      archiveDataKey === currentPrKey &&
      archiveFetcher.data.isAuthError) ||
    primaryImageErrorDialog?.isAuthError ||
    false;
  const dialogErrorMessage = transportError ?? effectiveError ?? primaryImageErrorDialog?.message ?? "";
  const hasArchiveDisplayError = Boolean(shouldShowArchiveErrorDialog && archiveErrorForCurrentPr);
  const dialogErrorContext: "save" | "display" | "image" = primaryImageErrorDialog
    ? "image"
    : hasArchiveDisplayError
      ? "display"
      : "save";
  const submitArchiveLookup = useCallback(
    (ownerValue: string, repoValue: string, prNumberValue: number, key: string) => {
      if (archiveLookupKeyRef.current === key) return;
      archiveLookupKeyRef.current = key;
      archiveRequestedKeyRef.current = key;
      setArchiveDataKey(null);
      archiveFetcher.submit(
        {
          owner: ownerValue,
          repo: repoValue,
          prNumber: String(prNumberValue),
          csrfToken,
        },
        { method: "post", action: "/api/onedrive/archive" },
      );
    },
    [archiveFetcher, csrfToken],
  );

  // 画面上のエラー表示は、APIからのエラーと通信エラーで分ける。
  useEffect(() => {
    if (effectiveError) setIsErrorDialogOpen(true);
  }, [effectiveError]);
  // APIからのエラーは画面上の注釈で表示するため、APIエラーがある場合はエラー表示用ダイアログは開かないようにする。
  useEffect(() => {
    if (transportError) setIsErrorDialogOpen(true);
  }, [transportError]);

  useEffect(() => {
    if (collectError) {
      setShowCollectErrorAnnotation(true);
    } else {
      setShowCollectErrorAnnotation(false);
    }
  }, [collectError]);

  useEffect(() => {
    if (data && !data.ok) {
      setShowParseErrorAnnotation(true);
    } else {
      setShowParseErrorAnnotation(false);
    }
  }, [data]);

  useEffect(() => {
    if (!uploadFetcher.data?.ok) return;
    if (shouldShowUploadAllEvidenceFailedError(uploadFetcher.data.evidenceImages)) {
      setUploadResultError(
        "画像の保存にすべて失敗しました。OneDrive 上の imgs フォルダ構成と権限を確認して再実行してください。",
      );
      return;
    }
    setIsSuccessDialogOpen(true);
  }, [uploadFetcher.data]);

  useEffect(() => {
    if (collectFetcher.state !== "idle") {
      collectRequestStartedRef.current = true;
      return;
    }
    if (!collectRequestStartedRef.current) return;
    collectRequestStartedRef.current = false;
    if (!isFetcherApiResponse(collectFetcher.data)) {
      redirectToTopOnTransportError();
    }
  }, [collectFetcher.state, collectFetcher.data]);

  useEffect(() => {
    if (uploadFetcher.state !== "idle") {
      uploadRequestStartedRef.current = true;
      archiveRefreshOnUploadKeyRef.current = null;
      setUploadResultError(null);
      return;
    }
    if (!uploadRequestStartedRef.current) return;
    uploadRequestStartedRef.current = false;
    if (!isFetcherApiResponse(uploadFetcher.data)) {
      redirectToTopOnTransportError();
    }
  }, [uploadFetcher.state, uploadFetcher.data]);

  useEffect(() => {
    if (sessionStatusFetcher.state !== "idle") {
      sessionStatusRequestStartedRef.current = true;
      return;
    }
    if (!sessionStatusRequestStartedRef.current) return;
    sessionStatusRequestStartedRef.current = false;
    if (!isFetcherApiResponse(sessionStatusFetcher.data)) {
      redirectToTopOnTransportError();
    }
  }, [sessionStatusFetcher.state, sessionStatusFetcher.data]);

  useEffect(() => {
    if (archiveFetcher.state !== "idle") {
      archiveRequestStartedRef.current = true;
      return;
    }
    if (!archiveRequestStartedRef.current) return;
    archiveRequestStartedRef.current = false;
    if (!isFetcherApiResponse(archiveFetcher.data)) {
      redirectToTopOnTransportError();
      return;
    }
    setArchiveDataKey(archiveRequestedKeyRef.current);
  }, [archiveFetcher.state, archiveFetcher.data]);

  useEffect(() => {
    if (collectFetcher.state !== "idle") return;
    if (collectFetcher.data?.ok && pendingCollectRef) {
      setLastCollectedRef(pendingCollectRef);
    }
    if (pendingCollectRef) {
      setPendingCollectRef(null);
    }
  }, [collectFetcher.state, collectFetcher.data, pendingCollectRef]);

  useEffect(() => {
    if (!onedriveConnected) return;
    setIsCheckingOneDriveSession(true);
    sessionStatusFetcher.load("/api/onedrive/session-status");
    const next = new URLSearchParams(searchParams);
    next.delete("onedrive");
    setSearchParams(next, { replace: true });
  }, [onedriveConnected, searchParams, setSearchParams, sessionStatusFetcher]);

  useEffect(() => {
    if (!onedriveOAuthFailed) return;
    setTransportError(OAUTH_CALLBACK_ERROR_MESSAGE);
    const next = new URLSearchParams(searchParams);
    next.delete("onedrive");
    setSearchParams(next, { replace: true });
  }, [onedriveOAuthFailed, searchParams, setSearchParams]);

  useEffect(() => {
    if (!prRefValidation.ok) return;
    if (!canAutoLookupArchive) return;
    if (collectFetcher.state !== "idle" || uploadFetcher.state !== "idle" || archiveFetcher.state !== "idle") return;
    const key = `${prRefValidation.owner}/${prRefValidation.repo}#${prRefValidation.prNumber}`;
    submitArchiveLookup(prRefValidation.owner, prRefValidation.repo, prRefValidation.prNumber, key);
  }, [
    prRefValidation,
    canAutoLookupArchive,
    collectFetcher.state,
    uploadFetcher.state,
    archiveFetcher.state,
    submitArchiveLookup,
  ]);

  useEffect(() => {
    if (!uploadFetcher.data?.ok || !prRefValidation.ok) return;
    const key = `${prRefValidation.owner}/${prRefValidation.repo}#${prRefValidation.prNumber}`;
    if (archiveRefreshOnUploadKeyRef.current === key) return;
    archiveRefreshOnUploadKeyRef.current = key;
    archiveLookupKeyRef.current = null;
    submitArchiveLookup(prRefValidation.owner, prRefValidation.repo, prRefValidation.prNumber, key);
  }, [uploadFetcher.data, prRefValidation, submitArchiveLookup]);

  // Parse Checklist が GitHub 取得失敗で終わった場合でも、
  // 保存済み archive.json からのフォールバック表示を試行する。
  useEffect(() => {
    if (!prRefValidation.ok) return;
    if (!shouldUseArchiveChecklistFallback(data)) return;
    if (archiveFetcher.state !== "idle") return;
    const key = `${prRefValidation.owner}/${prRefValidation.repo}#${prRefValidation.prNumber}`;
    if (archiveRequestedKeyRef.current === key) return;
    submitArchiveLookup(prRefValidation.owner, prRefValidation.repo, prRefValidation.prNumber, key);
  }, [data, prRefValidation, archiveFetcher.state, submitArchiveLookup]);

  useEffect(() => {
    if (isCheckingOneDriveSession && sessionStatusFetcher.data?.ok) {
      setIsAuthDialogOpen(true);
      setIsCheckingOneDriveSession(false);
    }
    if (isCheckingOneDriveSession && sessionStatusFetcher.data && !sessionStatusFetcher.data.ok) {
      setIsCheckingOneDriveSession(false);
    }
  }, [isCheckingOneDriveSession, sessionStatusFetcher.data]);

  // Markdown-it インスタンス（タスクリストプラグイン有効化）
  const markdown = useMemo(() => {
    // セキュリティ設計:
    // - html: false → 生HTML(<script>等)はエスケープされる
    // - markdown-it はデフォルトで javascript: スキームのリンクを無効化する
    // - linkify: true → URLの自動リンク化のみ、XSSベクトルにはならない
    // - task-lists プラグイン → <input type="checkbox"> と <label> のみ生成
    // 上記により dangerouslySetInnerHTML のXSSリスクは十分に低減されている。
    const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
    md.use(taskLists, { enabled: false, label: true, labelAfter: true });
    return md;
  }, []);

  const renderedDescriptionHtml = useMemo(() => {
    return descriptionText ? markdown.render(descriptionText) : "";
  }, [descriptionText, markdown]);
  const archiveChecklistForActive = useMemo(() => {
    if (!archiveFetcher.data?.ok || !archiveFetcher.data.found) return null;
    if (!activeChecklistPrKey || archiveDataKey !== activeChecklistPrKey) return null;
    return {
      description: archiveFetcher.data.body,
      items: archiveFetcher.data.checklistItems,
    };
  }, [archiveFetcher.data, archiveDataKey, activeChecklistPrKey]);
  const shouldRenderArchiveFallback =
    shouldUseArchiveChecklistFallback(data) && archiveChecklistForActive !== null;
  const checklistDataForDisplay = useMemo(() => {
    if (data?.ok) {
      return {
        items: data.result.items,
        summary: summarize(data.result),
        description: data.description,
      };
    }
    if (shouldRenderArchiveFallback && archiveChecklistForActive) {
      const total = archiveChecklistForActive.items.length;
      const checked = archiveChecklistForActive.items.filter((item) => item.checked).length;
      return {
        items: archiveChecklistForActive.items,
        summary: {
          total,
          checked,
          percent: total === 0 ? 0 : Math.round((100 * checked) / total),
        },
        description: archiveChecklistForActive.description,
      };
    }
    return null;
  }, [data, shouldRenderArchiveFallback, archiveChecklistForActive]);
  const checklistResultByLine = useMemo(
    () => (checklistDataForDisplay ? extractResultByChecklistLine(checklistDataForDisplay.description) : {}),
    [checklistDataForDisplay],
  );
  const checklistEvidenceByLine = useMemo(
    () => (checklistDataForDisplay ? extractEvidenceImageByChecklistLine(checklistDataForDisplay.description) : {}),
    [checklistDataForDisplay],
  );
  const savedEvidenceBySource = useMemo(() => {
    // セキュリティ設計: ここで扱うURLはすべてOneDriveに保存されたエビデンス画像のURLであり、ユーザーが直接入力するURLではないため、XSSリスクはないと判断している。
    const map = new Map<
      string,
      {
        onedrivePath: string | null;
        imageAccessToken: string | null;
        webUrl: string | null;
        status: "success" | "failed";
      }
    >();
    const canUseArchiveForActiveChecklist =
      activeChecklistPrKey !== null && archiveDataKey === activeChecklistPrKey;
    if (canUseArchiveForActiveChecklist && archiveFetcher.data?.ok && archiveFetcher.data.found) {
      for (const record of archiveFetcher.data.evidenceImages) {
        map.set(record.normalizedSourceUrl, {
          onedrivePath: record.onedrivePath,
          imageAccessToken: record.imageAccessToken,
          webUrl: record.webUrl,
          status: record.status,
        });
      }
      return map;
    }
    if (!uploadFetcher.data?.ok) return map;
    for (const record of uploadFetcher.data.evidenceImageRecords) {
      map.set(normalizeEvidenceSourceUrl(record.sourceUrl), {
        onedrivePath: record.onedrivePath,
        imageAccessToken: record.imageAccessToken,
        webUrl: record.webUrl,
        status: record.status,
      });
    }
    return map;
  }, [archiveFetcher.data, uploadFetcher.data, archiveDataKey, activeChecklistPrKey]);

  const isSaveTargetInSync = isSamePrRef(lastCollectedRef, currentPrRef);

  return (
    <main id="main-content" className="container">
      <h1 id="page-title" className="page-title">PR Description Collector</h1>

      <section id="fetch-section" className="fetch-section">
        <h2>Fetch from GitHub</h2>
        <div className="annotation-wrapper" aria-live="polite">
          {!collectFetcher.data?.ok ? (
            <p className="annotation-text">Get Description は取得のみです。保存（画像含む）は Save to OneDrive で実行します。</p>
          ) : null}
          {showPrRefAnnotation ? (
            <p className="annotation-text-small">
              {!prRefValidation.ok ? prRefValidation.error : "owner/repo/prNumber を正しく指定してください。"}
            </p>
          ) : null}
          {showCollectErrorAnnotation && collectError ? (
            <p className="annotation-text-small">{collectError}</p>
          ) : null}
          {uploadValidationError ? (
            <p className="annotation-text-small">{uploadValidationError}</p>
          ) : null}
          {collectFetcher.data?.ok && !isSaveTargetInSync ? (
            <p className="annotation-text-small">入力を変更したため、再度 Get Description が必要です。</p>
          ) : null}
          {showParseErrorAnnotation && data && !data.ok ? (
            <p className="annotation-text-small">{data.error}</p>
          ) : null}
        </div>
        <div className="form">
          <label htmlFor="owner">
            <span className="form-label">owner</span>
            <input
              className="input-contents basic-block"
              id="owner"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="octocat"
              autoComplete="off"
            />
          </label>
          <label htmlFor="repoTitle">
            <span className="form-label">repo</span>
            <input
              className="input-contents basic-block"
              id="repoTitle"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="Hello-World"
              autoComplete="off"
            />
          </label>
          <label htmlFor="prNumber">
            <span className="form-label">prNumber</span>
            <input
              className="input-contents basic-block"
              id="prNumber"
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
              placeholder="123"
              inputMode="numeric"
              autoComplete="off"
            />
          </label>
          <div className="btn-wrapper">
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (!prRefValidation.ok) {
                  setShowPrRefAnnotation(true);
                  return;
                }
                const submittedRef = normalizePrRef({ owner, repo, prNumber });
                setPendingCollectRef(submittedRef);
                setShowPrRefAnnotation(false);
                setShowCollectErrorAnnotation(true);
                collectFetcher.submit(
                  { owner, repo, prNumber },
                  { method: "post", action: "/api/collect" },
                );
              }}
              disabled={
                collectFetcher.state !== "idle" ||
                uploadFetcher.state !== "idle" ||
                !prRefValidation.ok
              }
            >
              Get Description (Fetch Only)
            </button>
            <a className="btn connect-one-drive-btn" href="/auth/onedrive/login">
              Connect OneDrive
            </a>

            <button
              type="button"
              className="btn"
              onClick={() => {
                if (!prRefValidation.ok) {
                  setShowPrRefAnnotation(true);
                  return;
                } else {
                  setShowPrRefAnnotation(false);
                }
                uploadFetcher.submit(
                  { owner, repo, prNumber, csrfToken },
                  { method: "post", action: "/api/onedrive/upload" },
                );
              }}
              disabled={
                uploadFetcher.state !== "idle" ||
                collectFetcher.state !== "idle" ||
                !collectFetcher.data?.ok ||
                !isSaveTargetInSync
              }
            >
              Save to OneDrive (with images)
            </button>

            <Form method="post" className="form">
              <input type="hidden" name="owner" value={owner} />
              <input type="hidden" name="repo" value={repo} />
              <input type="hidden" name="prNumber" value={prNumber} />
              <input type="hidden" name="csrfToken" value={csrfToken} />
              <button
                type="submit"
                className="btn"
                disabled={!prRefValidation.ok}
                onClick={(e) => {
                  if (!prRefValidation.ok) {
                    e.preventDefault();
                    setShowPrRefAnnotation(true);
                  } else {
                    setShowPrRefAnnotation(false);
                  }
                  // 同一PRで前回のフォールバック要求が残っていると再試行できないため、
                  // Parse クリック時に要求状態を明示的にリセットする。
                  archiveLookupKeyRef.current = null;
                  archiveRequestedKeyRef.current = null;
                  setShowParseErrorAnnotation(true);
                  setIsDescriptionOpen(false);
                }}
              >
                Parse Checklist
              </button>
            </Form>
          </div>
        </div>
      </section>

      <section id="rendered-description-section" className="result-section">
        <h2>Description (Rendered)</h2>
        {collectFetcher.data?.ok ? (
          <p>Fetched Pull Request Title: <span className="fetched-pr-title">{collectFetcher.data.pullRequest.title}</span></p>
        ) : null}
        {renderedDescriptionHtml ? (
          <details open={isDescriptionOpen} onToggle={(e) => setIsDescriptionOpen(e.currentTarget.open)}>
            <summary>Show description</summary>
            <article
              className="markdown-body"
              id="markdown-view"
              dangerouslySetInnerHTML={{ __html: renderedDescriptionHtml }}
            />
          </details>
        ) : (
          <p>No description yet.</p>
        )}
      </section>

      {checklistDataForDisplay && (
        <section id="checklist-result-secition" className="result-section">
          <h2>チェックリスト結果</h2>
          {checklistDataForDisplay.summary && (
            <p className="result-meta">
              {checklistDataForDisplay.summary.checked}/{checklistDataForDisplay.summary.total} done (
              {checklistDataForDisplay.summary.percent}%)
            </p>
          )}
          {checklistDataForDisplay.items.length === 0 ? (
            <p className="checklist-empty-message">チェックリストがありません</p>
          ) : (
            <ul className="checklist-card-list">
              {checklistDataForDisplay.items.map((item) => {
                const checklistResult = checklistResultByLine[item.line] ?? "未設定";
                const sourceEvidenceUrl = checklistEvidenceByLine[item.line] ?? null;
                const savedEvidence = sourceEvidenceUrl
                  ? savedEvidenceBySource.get(normalizeEvidenceSourceUrl(sourceEvidenceUrl))
                  : undefined;
                const evidenceImageUrl =
                  savedEvidence?.status === "success" &&
                  savedEvidence.onedrivePath &&
                  savedEvidence.imageAccessToken
                    ? buildEvidenceImageApiUrl(savedEvidence.onedrivePath, savedEvidence.imageAccessToken)
                    : null;
                const imageSourceLabel = sourceEvidenceUrl ? "未保存プレビュー" : null;
                return (
                  <li key={item.line}>
                    <ChecklistCard
                      item={item}
                      resultText={checklistResult}
                      evidenceImageUrl={evidenceImageUrl}
                      evidenceFallbackUrl={sourceEvidenceUrl}
                      imageSourceLabel={imageSourceLabel}
                      onPrimaryImageError={(status) => {
                        const mapped = mapPrimaryImageErrorToDialog(status);
                        if (!mapped) return;
                        const key = `${status}:${mapped.message}`;
                        if (primaryImageErrorKeyRef.current === key) return;
                        primaryImageErrorKeyRef.current = key;
                        setPrimaryImageErrorDialog(mapped);
                        setIsErrorDialogOpen(true);
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      <OneDriveAuthDialog
        open={isAuthDialogOpen}
        onClose={() => setIsAuthDialogOpen(false)}
      />
      <SavingDialog
        open={uploadFetcher.state !== "idle"}
      />
      <SaveErrorDialog
        open={isErrorDialogOpen}
        onClose={() => {
          setIsErrorDialogOpen(false);
          setTransportError(null);
          setPrimaryImageErrorDialog(null);
          primaryImageErrorKeyRef.current = null;
        }}
        error={dialogErrorMessage}
        errorCode={effectiveErrorCode}
        isAuthError={isAuthError}
        errorContext={dialogErrorContext}
      />
      <SuccessDialog
        open={isSuccessDialogOpen}
        onClose={() => setIsSuccessDialogOpen(false)}
        alreadySavedFiles={uploadFetcher.data?.ok ? uploadFetcher.data.alreadySavedFiles : null}
        evidenceImages={uploadFetcher.data?.ok ? uploadFetcher.data.evidenceImages : null}
      />
    </main>
  );
}
