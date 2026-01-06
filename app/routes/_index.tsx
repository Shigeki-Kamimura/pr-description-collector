import type { ActionFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { parseChecklist, summarize, type Checklist } from "../services/checklist";
import type { ApiCollectResponse } from "./api.collect";

/**
 * ルート: /
 * この画面は仮です。後続IssueでUI強化予定。
 * この画面の責務:
 * - PR description（Markdown）の表示
 * - 「Get Description」でGitHubからPR本文を取得してtextareaへ反映する
 * - 「Parse Checklist」でMarkdownのチェックリストを解析して表示する
 *
 * 設計メモ:
 * - GitHub取得は fetcher（/api/collect）で実行し、ページ遷移なしで反映
 * - チェックリスト解析はこのルートの action で実行（既存フローを維持）
 */

export const meta = () => [{ title: "PR Description Collector" }];

type ActionData = { description: string; result: Checklist };

export async function action({ request }: ActionFunctionArgs) {
  // textareaから送信されたPR本文（Markdown）を受け取り、チェックリスト解析結果を返す。
  const formData = await request.formData();
  const description = (formData.get("description") || "") as string;
  const result = parseChecklist(description);
  return Response.json({ description, result } satisfies ActionData);
}

export default function Index() {
  // action（Parse Checklist）の返却値
  const data = useActionData<ActionData>();
  const summary = data?.result ? summarize(data.result) : null;

  // GitHub取得用のfetcher（/api/collect にPOST）
  const collectFetcher = useFetcher<ApiCollectResponse>();

  // GitHub参照（owner/repo/prNumber）
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [prNumber, setPrNumber] = useState("");

  // textareaの中身（GitHub取得→反映、ユーザー編集→維持のためcontrolledにする）
  const [descriptionText, setDescriptionText] = useState("");

  useEffect(() => {
    // actionの結果でdescriptionが返ってきたら textarea 側へ同期する
    if (data?.description != null) setDescriptionText(data.description);
  }, [data?.description]);

  useEffect(() => {
    // GitHub取得に成功したら textarea へ反映する
    if (collectFetcher.data?.ok) setDescriptionText(collectFetcher.data.description);
  }, [collectFetcher.data]);

  const collectError = useMemo(() => {
    // fetcherの失敗レスポンスをUI表示向けに取り出す
    return collectFetcher.data && !collectFetcher.data.ok
      ? collectFetcher.data.error
      : null;
  }, [collectFetcher.data]);

  return (
    <main className="container">
      <h1 className="page-title">PR Description Collector</h1>

      <section className="fetch-section">
        <h2>Fetch from GitHub</h2>
        <div className="form">
          <label>
            <span className="form-label">owner</span>
            <input
              className="input-contents basic-block"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="octocat"
              autoComplete="off"
            />
          </label>
          <label>
            <span className="form-label">repo</span>
            <input
              className="input-contents basic-block"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="Hello-World"
              autoComplete="off"
            />
          </label>
          <label>
            <span className="form-label">prNumber</span>
            <input
              className="input-contents basic-block"
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
              placeholder="123"
              inputMode="numeric"
              autoComplete="off"
            />
          </label>

          <button
            type="button"
            className="btn"
            onClick={() => {
              // /api/collect へPOSTし、成功したら上のuseEffectでtextareaに反映される
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

          {collectError && <p className="error-text">{collectError}</p>}
          {collectFetcher.data?.ok && (
            <p className="hint-text">Fetched: {collectFetcher.data.pullRequest.title}</p>
          )}
        </div>
      </section>

      <Form method="post" className="form">
        {/* 解析対象の本文（Markdown）。サーバactionでチェックリスト抽出する */}
        <label>
          <span className="form-label">PR Description (Markdown)</span>
          <textarea
            name="description"
            rows={10}
            value={descriptionText}
            onChange={(e) => setDescriptionText(e.target.value)}
            className="textarea basic-block"
            placeholder="- [ ] Task A\n- [x] Task B"
          />
        </label>
        <button type="submit" className="btn">Parse Checklist</button>
      </Form>

      {data?.result && (
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
