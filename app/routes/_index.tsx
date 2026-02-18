import type { ActionFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useSearchParams } from "react-router";
import { useEffect, useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { parseChecklist, summarize, type Checklist } from "../services/checklist";
import type { ApiCollectResponse } from "./api.collect";
import type { ApiOneDriveUploadResponse } from "./api.onedrive.upload";
import type { ApiOneDriveSessionStatusResponse } from "./api.onedrive.session-status";
import { createGitHubServiceFromEnv, type PullRequestRef } from "../services/github.server";
import { validatePrRefInput } from "../services/validation";
import { getHttpStatus } from "../services/http-status";

import { OneDriveAuthDialog } from "../components/OneDriveAuthDialog";
import { SaveErrorDialog } from "../components/SaveErrorDialog";
import { SuccessDialog } from "../components/SuccessDialog";

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

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const validation = validatePrRefInput(formData);
  if (!validation.ok) {
    return Response.json(
      { ok: false, error: validation.error } satisfies ActionData,
      { status: 400 },
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
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
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
  const data = useActionData<ActionData>();
  const summary = data && data.ok ? summarize(data.result) : null;

  const collectFetcher = useFetcher<ApiCollectResponse>();
  const uploadFetcher = useFetcher<ApiOneDriveUploadResponse>();
  const sessionStatusFetcher = useFetcher<ApiOneDriveSessionStatusResponse>();

  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [evidenceByLine, setEvidenceByLine] = useState<Record<number, string>>({});
  const [showPrRefAnnotation, setShowPrRefAnnotation] = useState(false);
  const [showCollectErrorAnnotation, setShowCollectErrorAnnotation] = useState(false);
  const [showParseErrorAnnotation, setShowParseErrorAnnotation] = useState(false);

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

  const sessionStatusError = useMemo(() => {
    return sessionStatusFetcher.data && !sessionStatusFetcher.data.ok
      ? sessionStatusFetcher.data.error
      : null;
  }, [sessionStatusFetcher.data]);

  const [searchParams, setSearchParams] = useSearchParams();
  const onedriveConnected = searchParams.get("onedrive") === "connected";
  const [isCheckingOneDriveSession, setIsCheckingOneDriveSession] = useState(false);
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  const [isErrorDialogOpen, setIsErrorDialogOpen] = useState(false);
  const [isSuccessDialogOpen, setIsSuccessDialogOpen] = useState(false);
  const effectiveError = uploadError ?? sessionStatusError;
  const isAuthError =
    (uploadFetcher.data && !uploadFetcher.data.ok && uploadFetcher.data.isAuthError) ||
    (sessionStatusFetcher.data &&
      !sessionStatusFetcher.data.ok &&
      sessionStatusFetcher.data.isAuthError) ||
    false;

  useEffect(() => {
    if (effectiveError) setIsErrorDialogOpen(true);
  }, [effectiveError]);

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
    if (uploadFetcher.data?.ok) setIsSuccessDialogOpen(true);
  }, [uploadFetcher.data]);

  useEffect(() => {
    if (!onedriveConnected) return;
    setIsCheckingOneDriveSession(true);
    sessionStatusFetcher.load("/api/onedrive/session-status");
    const next = new URLSearchParams(searchParams);
    next.delete("onedrive");
    setSearchParams(next, { replace: true });
  }, [onedriveConnected, searchParams, setSearchParams, sessionStatusFetcher]);

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

  return (
    <main id="main-content" className="container">
      <h1 id="page-title" className="page-title">PR Description Collector</h1>

      <section id="fetch-section" className="fetch-section">
        <h2>Fetch from GitHub</h2>
        <div className="annotation-wrapper" aria-live="polite">
          {!collectFetcher.data?.ok ? (
            <p className="annotation-text">Get Description を押してから保存してください。</p>
          ) : null}
          {showPrRefAnnotation ? (
            <p className="annotation-text-small">owner/repo/prNumber を正しく指定してください。</p>
          ) : null}
          {showCollectErrorAnnotation && collectError ? (
            <p className="annotation-text-small">{collectError}</p>
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
                if (!owner || !repo || !prNumber) {
                  setShowPrRefAnnotation(true);
                } else {
                  setShowPrRefAnnotation(false);
                }
                setShowCollectErrorAnnotation(true);
                collectFetcher.submit(
                  { owner, repo, prNumber },
                  { method: "post", action: "/api/collect" },
                );
              }}
              disabled={
                collectFetcher.state !== "idle" ||
                uploadFetcher.state !== "idle" ||
                !owner || !repo || !prNumber
              }
            >
              Get Description
            </button>
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
          <p>Fetched Pull Request Title: <span className="fetched-pr-title">{collectFetcher.data.pullRequest.title}</span></p>
        ) : null}
        {renderedDescriptionHtml ? (
          <details open>
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
      <OneDriveAuthDialog
        open={isAuthDialogOpen}
        onClose={() => setIsAuthDialogOpen(false)}
      />
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
