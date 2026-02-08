import type { ActionFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher } from "react-router";
import { useMemo, useState } from "react";
// Markdown-it本体とタスクリストプラグイン
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
// チェックリスト解析ロジック
import { parseChecklist, summarize, type Checklist } from "../services/checklist";
// GitHub APIサービスと型
import type { ApiCollectResponse } from "./api.collect";
import { createGitHubServiceFromEnv, type PullRequestRef } from "../services/github.server";
// OctokitのRequestErrorを使ってエラー判定
import { RequestError } from "@octokit/request-error";

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

export async function action({ request }: ActionFunctionArgs) {
  // owner/repo/prNumber からサーバー側でPR本文を取得して解析する。
  const formData = await request.formData();
  const owner = String(formData.get("owner") ?? "").trim();
  const repo = String(formData.get("repo") ?? "").trim();
  const prNumberRaw = String(formData.get("prNumber") ?? "").trim();
  const prNumber = Number(prNumberRaw);

  // 最低限の入力チェック（サーバ側で再取得するため必須）
  // owner/repo/prNumber はサーバー側で再取得するため必須
  // prNumber は整数であることを確認
  // 負の数や0はありえないので除外
  if (!owner || !repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    return Response.json(
      { ok: false, error: "owner/repo/prNumber を正しく指定してください" } satisfies ActionData,
      { status: 400 },
    );
  }

  try {
    // サーバ側でPR本文を取得して解析（大きな本文をフォームで送らない）
    const github = await createGitHubServiceFromEnv();
    const ref: PullRequestRef = { repo: { owner, name: repo }, number: prNumber };
    const pullRequest = await github.getPullRequest(ref);
    const description = pullRequest.body;
    const result = parseChecklist(description);

    return Response.json(
      { ok: true, description, result } satisfies ActionData,
      { status: 200 },
    );
  } catch (error) {
    // Octokit の RequestError からステータスコード別にユーザー向けメッセージを返す
    if (error instanceof RequestError) {
      const status = error.status;
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
            { ok: false, error: `GitHub APIエラー (${status}): ${error.message}` },
            { status: 502 },
          );
      }
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json(
      { ok: false, error: message },
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

  // GitHub参照（owner/repo/prNumber）
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [prNumber, setPrNumber] = useState("");

  // 表示/解析対象のPR本文（Markdown）。
  // fetcherの取得結果があればそちらを優先し、なければactionの値を使う。
  const descriptionText = useMemo(() => {
    if (collectFetcher.data?.ok) return collectFetcher.data.description;
    if (data?.ok) return data.description;
    return "";
  }, [collectFetcher.data, data]);

  const collectError = useMemo(() => {
    // fetcherの失敗レスポンスをUI表示向けに取り出す
    return collectFetcher.data && !collectFetcher.data.ok
      ? collectFetcher.data.error
      : null;
  }, [collectFetcher.data]);

  const markdown = useMemo(() => {
    // セキュリティ設計:
    // - html: false → 生HTML(<script>等)はエスケープされる
    // - markdown-it はデフォルトで javascript: スキームのリンクを無効化する
    // - linkify: true → URLの自動リンク化のみ、XSSベクトルにはならない
    // - task-lists プラグイン → <input type="checkbox"> と <label> のみ生成
    // 上記により dangerouslySetInnerHTML のXSSリスクは十分に低減されている。
    const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
    md.use(taskLists, { enabled: true, label: true, labelAfter: true });
    return md;
  }, []);

  const renderedDescriptionHtml = useMemo(() => {
    return descriptionText ? markdown.render(descriptionText) : "";
  }, [descriptionText, markdown]);

  return (
    <main className="container">
      <h1 className="page-title">PR Description Collector</h1>

      <section className="fetch-section">
        <h2>Fetch from GitHub</h2>
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
                // /api/collect へPOSTし、成功したら取得した description を表示/解析に使う
                collectFetcher.submit(
                  { owner, repo, prNumber },
                  { method: "post", action: "/api/collect" },
                );
              }}
              // 連打防止（通信中はdisabled）
              disabled={collectFetcher.state !== "idle"}
            >
              Get Description
            </button>

            {/* メッセージ領域は常に確保して、表示/非表示でレイアウトがズレないようにする */}
            <div className="btn-status" aria-live="polite">
              {collectError ? (
                <p className="error-text">{collectError}</p>
              ) : collectFetcher.data?.ok ? (
                <p className="hint-text">Fetched: {collectFetcher.data.pullRequest.title}</p>
              ) : (
                <p className="hint-text">&nbsp;</p>
              )}
            </div>
          </div>
        </div>
      </section>

      <Form method="post" className="form">
        {/* 解析対象はサーバー側で再取得するため、PR参照情報だけ渡す */}
        <input type="hidden" name="owner" value={owner} />
        <input type="hidden" name="repo" value={repo} />
        <input type="hidden" name="prNumber" value={prNumber} />
        <button type="submit" className="btn" disabled={!owner || !repo || !prNumber}>
          Parse Checklist
        </button>
        {!owner || !repo || !prNumber ? (
          <p className="hint-text">owner/repo/prNumber を入力してください。</p>
        ) : data && !data.ok ? (
          <p className="error-text">{data.error}</p>
        ) : null}
      </Form>

      <section className="result-section">
        <h2>Description (Rendered)</h2>
        {renderedDescriptionHtml ? (
          <article
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
        ) : (
          <p className="hint-text">No description yet.</p>
        )}
      </section>

      {data && data.ok && (
        <section className="result-section">
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
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
