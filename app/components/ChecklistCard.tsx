/**
 * なぜ必要か:
 * - チェックリストカードの表示責務をルートから分離し、可読性と再利用性を高めるため。
 *
 * 使う場面:
 * - チェックリスト結果画面で、各項目をカードとして繰り返し表示する時。
 * - 項目データと画像URL、Result表示値を props で注入して表示したい時。
 */
export interface ChecklistCardItem {
  line: number;
  text: string;
  checked: boolean;
}

// GitHub認証情報
export interface ChecklistCardProps {
  item: ChecklistCardItem;
  resultText: string;
  evidenceImageUrl?: string | null;
  evidenceFallbackUrl?: string | null;
  imageSourceLabel?: string | null;
}

const EVIDENCE_IMAGE_EMPTY_TEXT = "エビデンス画像なし";

function toHttpImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function resolveChecklistCardImageUrl(
  primaryUrl: string | null | undefined,
  fallbackUrl: string | null | undefined,
): string | null {
  return toHttpImageUrl(primaryUrl) ?? toHttpImageUrl(fallbackUrl);
}

export function checklistResultText(checked: boolean): string {
  return checked ? "完了" : "未完了";
}

export function ChecklistCard({
  item,
  resultText,
  evidenceImageUrl,
  evidenceFallbackUrl,
  imageSourceLabel,
}: ChecklistCardProps) {
  const resolvedImageUrl = resolveChecklistCardImageUrl(evidenceImageUrl, evidenceFallbackUrl);

  return (
    <article className="checklist-card">
      <div className="evidence-img-wrapper">
        {resolvedImageUrl ? (
          <img
            src={resolvedImageUrl}
            alt={`line ${item.line} evidence`}
            loading="lazy"
            className="checklist-card-image"
          />
        ) : (
          <p className="checklist-card-media-empty">{EVIDENCE_IMAGE_EMPTY_TEXT}</p>
        )}
        {resolvedImageUrl && imageSourceLabel ? (
          <span className="checklist-image-source-badge">{imageSourceLabel}</span>
        ) : null}
      </div>
      <div className="checklist-card-body">
        <div className="checklist-card-meta">
          <span className={`status-chip ${item.checked ? "done" : "todo"}`}>
            チェック状態: {checklistResultText(item.checked)}
          </span>
          <span className="line-chip">line {item.line}</span>
        </div>
        <h3 className="checklist-card-title">{item.text}</h3>
        <p className="checklist-result-text">Result: {resultText}</p>
      </div>
    </article>
  );
}
