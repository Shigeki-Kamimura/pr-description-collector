import type { ActionFunctionArgs } from "react-router";
import { Form, useActionData } from "react-router";
import { parseChecklist, summarize, type Checklist } from "../services/checklist";

export const meta = () => [{ title: "PR Description Collector" }];

type ActionData = { description: string; result: Checklist };

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const description = (formData.get("description") || "") as string;
  const result = parseChecklist(description);
  return Response.json({ description, result } satisfies ActionData);
}

export default function Index() {
  const data = useActionData<ActionData>();
  const summary = data?.result ? summarize(data.result) : null;

  return (
    <main className="container">
      <h1 className="page-title">PR Description Collector</h1>

      <Form method="post" className="form">
        <label>
          <span className="form-label">PR Description (Markdown)</span>
          <textarea
            name="description"
            rows={10}
            defaultValue={data?.description ?? ""}
            className="textarea"
            placeholder="- [ ] Task A\n- [x] Task B"
          />
        </label>
        <button type="submit" className="btn">Parse Checklist</button>
      </Form>

      {data?.result && (
        <section className="section">
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
