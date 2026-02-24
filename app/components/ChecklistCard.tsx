import { useEffect, useMemo, useRef, useState } from "react";

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
  onPrimaryImageError?: (status: number) => void;
}

const EVIDENCE_IMAGE_EMPTY_TEXT = "エビデンス画像なし";

function toHttpImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) return trimmed;
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

// 設計メモ: チェックリストカードは、項目のテキストとチェック状態を表示するだけでなく、関連するエビデンス画像も表示することができる。
export function ChecklistCard({
  item,
  resultText,
  evidenceImageUrl,
  evidenceFallbackUrl,
  imageSourceLabel,
  onPrimaryImageError,
}: ChecklistCardProps) {
  const primaryImageUrl = useMemo(() => toHttpImageUrl(evidenceImageUrl), [evidenceImageUrl]);
  const fallbackImageUrl = useMemo(() => toHttpImageUrl(evidenceFallbackUrl), [evidenceFallbackUrl]);
  const isPrimaryOneDriveApiImage =
    primaryImageUrl !== null && primaryImageUrl.startsWith("/api/onedrive/evidence-image");
  const [primaryResolvedUrl, setPrimaryResolvedUrl] = useState<string | null>(
    isPrimaryOneDriveApiImage ? null : primaryImageUrl,
  );
  const [isFallbackBroken, setIsFallbackBroken] = useState(false);
  const reportedPrimaryErrorStatusesRef = useRef<Set<number>>(new Set());
  const onPrimaryImageErrorRef = useRef<typeof onPrimaryImageError>(onPrimaryImageError);

  useEffect(() => {
    onPrimaryImageErrorRef.current = onPrimaryImageError;
  }, [onPrimaryImageError]);

  useEffect(() => {
    let active = true;
    let objectUrlToRevoke: string | null = null;
    const controller = new AbortController();
    reportedPrimaryErrorStatusesRef.current.clear();
    setIsFallbackBroken(false);
    setPrimaryResolvedUrl(isPrimaryOneDriveApiImage ? null : primaryImageUrl);

    if (!isPrimaryOneDriveApiImage || !primaryImageUrl) {
      return () => {
        controller.abort();
        if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
      };
    }
    void fetch(primaryImageUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) {
          if (!reportedPrimaryErrorStatusesRef.current.has(response.status)) {
            reportedPrimaryErrorStatusesRef.current.add(response.status);
            onPrimaryImageErrorRef.current?.(response.status);
          }
          return;
        }
        const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
        if (!contentType.startsWith("image/")) {
          const unsupportedStatus = 415;
          if (!reportedPrimaryErrorStatusesRef.current.has(unsupportedStatus)) {
            reportedPrimaryErrorStatusesRef.current.add(unsupportedStatus);
            onPrimaryImageErrorRef.current?.(unsupportedStatus);
          }
          return;
        }
        const bodyBlob = await response.blob();
        if (!active) return;
        objectUrlToRevoke = URL.createObjectURL(bodyBlob);
        setPrimaryResolvedUrl(objectUrlToRevoke);
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        const networkFailureStatus = 502;
        if (!reportedPrimaryErrorStatusesRef.current.has(networkFailureStatus)) {
          reportedPrimaryErrorStatusesRef.current.add(networkFailureStatus);
          onPrimaryImageErrorRef.current?.(networkFailureStatus);
        }
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
    };
  }, [isPrimaryOneDriveApiImage, primaryImageUrl]);

  const currentImageUrl = primaryResolvedUrl ?? (isFallbackBroken ? null : fallbackImageUrl);
  const isUsingFallbackImage =
    !primaryResolvedUrl && !isFallbackBroken && fallbackImageUrl !== null && currentImageUrl === fallbackImageUrl;

  const handleImageError = () => {
    if (primaryResolvedUrl) {
      setPrimaryResolvedUrl(null);
      return;
    }
    if (fallbackImageUrl) {
      setIsFallbackBroken(true);
    }
  };

  return (
    <article className="checklist-card">
      <div className="evidence-img-wrapper">
        {currentImageUrl ? (
          <img
            src={currentImageUrl}
            alt={`line ${item.line} evidence`}
            loading="lazy"
            className="checklist-card-image"
            onError={handleImageError}
          />
        ) : (
          <p className="checklist-card-media-empty">{EVIDENCE_IMAGE_EMPTY_TEXT}</p>
        )}
        {currentImageUrl && isUsingFallbackImage && imageSourceLabel ? (
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
