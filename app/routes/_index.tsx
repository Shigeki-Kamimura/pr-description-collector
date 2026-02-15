import type { ActionFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useSearchParams } from "react-router";
import { useEffect, useMemo, useState } from "react";
// Markdown-it本体とタスクリストプラグイン
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
// チェックリスト解析ロジック
import { parseChecklist, summarize, type Checklist } from "../services/checklist";
// GitHub APIサービスと型
import type { ApiCollectResponse } from "./api.collect";
// OneDrive APIサービスと型
import type { ApiOneDriveUploadResponse } from "./api.onedrive.upload";
// OneDriveセッション確認APIの型
import type { ApiOneDriveSessionStatusResponse } from "./api.onedrive.session-status";
// GitHubサービスのファクトリと型
import { createGitHubServiceFromEnv, type PullRequestRef } from "../services/github.server";
// PR のオーナー、リポジトリ名、PR番号の入力をバリデーションするユーティリティ
import { validatePrRefInput } from "../services/validation";
// OctokitのRequestErrorを使ってエラー判定

// ダイアログコンポーネント群
import { RequestError } from "@octokit/request-error"; // エラー
import { OneDriveAuthDialog } from "../components/OneDriveAuthDialog"; // OneDrive認証完了
import { SaveErrorDialog } from "../components/SaveErrorDialog"; // 保存エラー
import { SuccessDialog } from "../components/SuccessDialog"; // 保存成功

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

// action の戻り値は成功/失敗を判別できるように型で分ける。
type ActionData =
  | { ok: true; description: string; result: Checklist }
  | { ok: false; error: string };

function getHttpStatus(error: unknown): number | null {
  if (error instanceof RequestError) return error.status;
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  // owner/repo/prNumber からサーバー側でPR本文を取得して解析する。
  const formData = await request.formData();
  const validation = validatePrRefInput(formData);
  if (!validation.ok) {
    return Response.json(
      { ok: false, error: validation.error } satisfies ActionData,
      { status: 400 },
    );
  }

  try {
    // サーバ側でPR本文を取得して解析（大きな本文をフォームで送らない）
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
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    // RequestError の型が崩れても、status が取れればユーザー向け文言へ変換する
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
            { ok: false, error: `GitHub APIエラー (${status}): ${errorMessage}` },
            { status: 502 },
          );
      }
    }

    return Response.json(
      { ok: false, error: errorMessage },
      { status: 502 },
    );
  }
}

export default function Index() {
  // action（Parse Checklist）の返却値
  const data = useActionData<ActionData>();
  const summary = data && data.ok ? summarize(data.result) : null;

  // GitHub取得用のfetcher（/api/collect にPOST）
  const collectFetcher = useFetcher<ApiCollectResponse>();

  // OneDrive保存用のfetcher（/api/onedrive/upload にPOST）
  const uploadFetcher = useFetcher<ApiOneDriveUploadResponse>();
  // OneDriveセッション確認用のfetcher（/api/onedrive/session-status にGET）
  const sessionStatusFetcher = useFetcher<ApiOneDriveSessionStatusResponse>();

  // GitHub参照（owner/repo/prNumber）
  // これらはフォームの入力値としても使うが、fetcherのsubmitで直接渡すこともあるため、状態として管理する。
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [prNumber, setPrNumber] = useState("");
  // URLの入力値を line 番号に紐づけて管理する状態
  const [evidenceByLine, setEvidenceByLine] = useState<Record<number, string>>({});
  // owner/repo/prNumber の入力エラー注釈表示フラグ
  const [showPrRefAnnotation, setShowPrRefAnnotation] = useState(false);
  // 取得エラー注釈表示フラグ
  const [showCollectErrorAnnotation, setShowCollectErrorAnnotation] = useState(false);
  // 解析エラー注釈表示フラグ
  const [showParseErrorAnnotation, setShowParseErrorAnnotation] = useState(false);

  // 表示/解析対象のPR本文（Markdown）。
  // fetcherの取得結果があればそちらを優先し、なければactionの値を使う。
  const descriptionText = useMemo(() => {
    if (collectFetcher.data?.ok) return collectFetcher.data.description;
    if (data?.ok) return data.description;
    return "";
  }, [collectFetcher.data, data]);

  // 入力値を一時保存して OAuth 復帰後に復元する
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.sessionStorage.getItem("pr-ref"); // { owner, repo, prNumber }
      if (!raw) return;
      // 復元の際、現在の入力値が空の場合のみ保存値で上書きする。これにより、OAuth復帰後もユーザーが入力した値を保持できる。
      const saved = JSON.parse(raw) as { owner?: string; repo?: string; prNumber?: string };
      if (saved.owner) setOwner((prev) => prev || saved.owner || ""); // 現在の入力値が空の場合のみ復元
      if (saved.repo) setRepo((prev) => prev || saved.repo || ""); // 同上
      if (saved.prNumber) setPrNumber((prev) => prev || saved.prNumber || ""); // 同上
    } catch {
      // ignore
    }
  }, []);

  // 入力値が変わるたびに保存する
  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = JSON.stringify({ owner, repo, prNumber });
    window.sessionStorage.setItem("pr-ref", payload);
  }, [owner, repo, prNumber]);

  const collectError = useMemo(() => {
    // fetcherの失敗レスポンスをUI表示向けに取り出す
    return collectFetcher.data && !collectFetcher.data.ok
      ? collectFetcher.data.error
      : null;
  }, [collectFetcher.data]);

  // OneDriveアップロードエラーメッセージ
  const uploadError = useMemo(() => {
    return uploadFetcher.data && !uploadFetcher.data.ok
      ? uploadFetcher.data.error
      : null;
  }, [uploadFetcher.data]);

  // OneDriveセッション確認エラーメッセージ
  const sessionStatusError = useMemo(() => {
    return sessionStatusFetcher.data && !sessionStatusFetcher.data.ok
      ? sessionStatusFetcher.data.error
      : null;
  }, [sessionStatusFetcher.data]);

  // OneDrive OAuth接続状態
  // クエリパラメータを操作するためのフック
  const [searchParams, setSearchParams] = useSearchParams();
  // OneDrive接続完了のクエリパラメータを検出するフラグ
  const onedriveConnected = searchParams.get("onedrive") === "connected";
  // OAuth復帰直後のセッション確認フロー中かどうか
  const [isCheckingOneDriveSession, setIsCheckingOneDriveSession] = useState(false);
  // 認証エラーかどうかのフラグ
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  // 保存エラー表示のフラグとメッセージ
  const [isErrorDialogOpen, setIsErrorDialogOpen] = useState(false);
  // 保存成功表示のフラグ
  const [isSuccessDialogOpen, setIsSuccessDialogOpen] = useState(false);
  // アップロードエラーメッセージから認証エラーかどうかを判定する（簡易的にキーワードマッチ）
  const effectiveError = uploadError ?? sessionStatusError;
  const uploadErrorMessage = effectiveError ?? "";
  const isAuthError = /OAuth token|認証|401|403/.test(uploadErrorMessage);

  // アップロードエラー発生時にダイアログを開く
  useEffect(() => {
    if (effectiveError) setIsErrorDialogOpen(true);
  }, [effectiveError]);

  // 取得エラー注釈の表示制御
  useEffect(() => {
    if (collectError) {
      setShowCollectErrorAnnotation(true); // エラーがある場合は注釈を表示
    } else {
      setShowCollectErrorAnnotation(false); // エラーがない場合は注釈を非表示
    }
  }, [collectError]);

  // 解析エラー注釈の表示制御
  useEffect(() => {
    if (data && !data.ok) {
      setShowParseErrorAnnotation(true);
    } else {
      setShowParseErrorAnnotation(false);
    }
  }, [data]);

  // アップロード成功時にダイアログを開く
  useEffect(() => {
    if (uploadFetcher.data?.ok) setIsSuccessDialogOpen(true);
  }, [uploadFetcher.data]);

  // OneDrive接続完了クエリパラメータを削除
  useEffect(() => {
    if (!onedriveConnected) return;
    // OAuthから戻った直後にセッション状態を確認する
    setIsCheckingOneDriveSession(true);
    // セッション状態を確認するAPIを呼び出す
    sessionStatusFetcher.load("/api/onedrive/session-status");
    // クエリパラメータを削除してURLをクリーンにする
    const next = new URLSearchParams(searchParams);
    next.delete("onedrive");
    setSearchParams(next, { replace: true });
  }, [onedriveConnected, searchParams, setSearchParams]);

  useEffect(() => {
    // OAuth復帰直後に実行したセッション確認が成功した時だけ、1回だけ表示する
    if (isCheckingOneDriveSession && sessionStatusFetcher.data?.ok) {
      setIsAuthDialogOpen(true);
      setIsCheckingOneDriveSession(false);
    }
    // セッション確認が失敗した場合はダイアログを表示しないで終了する
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
    // enabled: false で checkbox を disabled にする
    md.use(taskLists, { enabled: false, label: true, labelAfter: true });
    return md;
  }, []);

  const renderedDescriptionHtml = useMemo(() => {
    return descriptionText ? markdown.render(descriptionText) : "";
  }, [descriptionText, markdown]);

  return (
    <main id="main-content" className="container">
      <h1 id="page-title" className="page-title">PR Description Collector</h1>

      <section id="fetch-section" className="fetch-section">
        <h2>Fetch from GitHub</h2>
        {/* 注釈エリア */}
        <div className="annotation-wrapper" aria-live="polite">
 
          {!collectFetcher.data?.ok ? (
            // 最初から表示しておく
            <p className="annotation-text">Get Description を押してから保存してください。</p>
          ) : null}
          {showPrRefAnnotation ? (
            // 入力エラー注釈
            <p className="annotation-text-small">owner/repo/prNumber を正しく指定してください。</p>
          ) : null}
          {showCollectErrorAnnotation && collectError ? (
            // 取得エラー注釈
            <p className="annotation-text-small">{collectError}</p>
          ) : null}
          {showParseErrorAnnotation && data && !data.ok ? (
            // 解析エラー注釈
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
              // owner/repo/prNumber をフォームの状態から直接渡す（URLにするのではなく）ことで、入力エラーがあっても正しい値だけを送ることができる。
              onClick={() => {
                if (!owner || !repo || !prNumber) {
                  setShowPrRefAnnotation(true);
                } else {
                  setShowPrRefAnnotation(false);
                }
                setShowCollectErrorAnnotation(true);
                // /api/collect へPOSTし、成功したら取得した description を表示/解析に使う
                collectFetcher.submit(
                  { owner, repo, prNumber },
                  { method: "post", action: "/api/collect" },
                );
              }}
              // disabled判定、owner/repo/prNumber が未入力、または他のfetcherが動作中の場合
              disabled={
                collectFetcher.state !== "idle" ||
                uploadFetcher.state !== "idle" ||
                !owner || !repo || !prNumber
              }
            >
              Get Description
            </button>
              {/* OneDrive OAuthログインへのリンク */}
            <a className="btn connect-one-drive-btn" href="/auth/onedrive/login">
              Connect OneDrive
            </a>

            <button
              type="button"
              className="btn"
              onClick={() => {
                if (!owner || !repo || !prNumber) {
                  setShowPrRefAnnotation(true);
                } else {
                  setShowPrRefAnnotation(false);
                }
                // /api/onedrive/upload へPOSTし、OneDriveへ保存を実行する
                uploadFetcher.submit(
                  { owner, repo, prNumber },
                  { method: "post", action: "/api/onedrive/upload" },
                );
              }}
              disabled={
                uploadFetcher.state !== "idle" ||
                collectFetcher.state !== "idle" ||
                !collectFetcher.data?.ok
              }
            >
              Save to OneDrive
            </button>

            <Form method="post" className="form">
              {/* 解析対象はサーバー側で再取得するため、PR参照情報だけ渡す */}
              <input type="hidden" name="owner" value={owner} />
              <input type="hidden" name="repo" value={repo} />
              <input type="hidden" name="prNumber" value={prNumber} />
              <button
                type="submit"
                className="btn"
                disabled={!owner || !repo || !prNumber}
                onClick={() => {
                  if (!owner || !repo || !prNumber) {
                    setShowPrRefAnnotation(true);
                  } else {
                    setShowPrRefAnnotation(false);
                  }
                  setShowParseErrorAnnotation(true);
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
          <p>Fetched Pullrequest Title: <span className="fetched-pr-title">{collectFetcher.data.pullRequest.title}</span></p>
        ) : null}
        {renderedDescriptionHtml ? (
          <details open>
            <summary>Show description</summary>
            <article
              className="markdown-body"
              // markdown-itで生成したHTMLを表示する（HTML埋め込みは無効化している）
              // セキュリティ設計:
              // - html: false → 生HTML(<script>等)はエスケープされる
              // - markdown-it はデフォルトで javascript: スキームのリンクを無効化する
              // - linkify: true → URLの自動リンク化のみ、XSSベクトルにはならない
              // - task-lists プラグイン → <input type="checkbox"> と <label> のみ生成
              // 上記により dangerouslySetInnerHTML のXSSリスクは十分に低減されている。
              id="markdown-view"
              dangerouslySetInnerHTML={{ __html: renderedDescriptionHtml }}
            />
          </details>
        ) : (
          <p>No description yet.</p>
        )}
      </section>

      {data && data.ok && (
        <section id="checklist-result-secition" className="result-section">
          <h2>Result</h2>
          {summary && (
            <p className="result-meta">
              {summary.checked}/{summary.total} done ({summary.percent}%)
            </p>
          )}
          <ul className="result-list">
            {data.result.items.map((item) => (
              <li key={item.line} className="result-item">
                <input type="checkbox" checked={item.checked} readOnly />
                <span>{item.text}</span>
                <span className="result-line">(line {item.line})</span>
                <input
                  className="input-contents basic-block"
                  type="text"
                  placeholder="evidence URL or filename"
                  value={evidenceByLine[item.line] ?? ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    setEvidenceByLine((prev) => ({ ...prev, [item.line]: value }));
                  }}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {/* oAuth接続確認通知ダイアログ */}
      <OneDriveAuthDialog
        open={isAuthDialogOpen}
        onClose={() => setIsAuthDialogOpen(false)}
      />
      {/* 保存エラーダイアログ */}
      <SaveErrorDialog
        open={isErrorDialogOpen}
        onClose={() => setIsErrorDialogOpen(false)}
        error={effectiveError ?? ""}
        isAuthError={isAuthError}
      />
      <SuccessDialog
        open={isSuccessDialogOpen}
        onClose={() => setIsSuccessDialogOpen(false)}
      />
    </main>
  );
}
