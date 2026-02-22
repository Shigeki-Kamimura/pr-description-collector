// 保存成功ダイアログコンポーネント
import { useEffect, useRef } from "react";

type SuccessDialogProps = {
  open: boolean;
  onClose: () => void;
  alreadySavedFiles?: {
    descriptionMd: boolean;
    archiveJson: boolean;
  } | null;
  evidenceImages?: {
    total: number;
    success: number;
    failed: number;
    alreadySaved: number;
  } | null;
};

// 画像保存の結果をユーザーフレンドリーなメッセージに変換するユーティリティ関数
export function formatEvidenceImagesMessage(evidenceImages: {
  total: number;
  success: number;
  failed: number;
  alreadySaved: number;
}): string {
  if (evidenceImages.total === 0) {
    return "画像は対象が0件でした。";
  }
  if (evidenceImages.alreadySaved > 0 && evidenceImages.success === evidenceImages.alreadySaved && evidenceImages.failed === 0) {
    return `画像は保存済みです（${evidenceImages.alreadySaved}件）。`;
  }
  if (evidenceImages.success === 0 && evidenceImages.failed > 0) {
    return `画像は保存できませんでした（成功: ${evidenceImages.success}件 / 失敗: ${evidenceImages.failed}件）。`;
  }
  const baseMessage = `画像を保存しました（成功: ${evidenceImages.success}件 / 失敗: ${evidenceImages.failed}件）。`;
  if (evidenceImages.alreadySaved > 0) {
    return `${baseMessage} 画像は保存済みです（${evidenceImages.alreadySaved}件）。`;
  }
  return baseMessage;
}

export function formatArchiveFilesMessage(
  alreadySavedFiles: { descriptionMd: boolean; archiveJson: boolean } | null | undefined,
  evidenceImages: { total: number; success: number; failed: number; alreadySaved: number } | null | undefined,
): string {
  const filesSavedMessage = alreadySavedFiles?.descriptionMd && alreadySavedFiles?.archiveJson
    ? "description.md と archive.json は保存済みでした。"
    : "description.md と archive.json を保存しました。";
  const imagesSaved = (evidenceImages?.total ?? 0) > 0 && (evidenceImages?.failed ?? 0) === 0;
  if (alreadySavedFiles?.descriptionMd && alreadySavedFiles?.archiveJson && imagesSaved) {
    return `${filesSavedMessage} 画像も保存できています。`;
  }
  return filesSavedMessage;
}

// PR説明とエビデンス画像の保存成功を知らせるダイアログコンポーネント
export function SuccessDialog({ open, onClose, alreadySavedFiles, evidenceImages }: SuccessDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // ダイアログの開閉制御
  useEffect(() => {
    if (!dialogRef.current) return;
    if (open && !dialogRef.current.open) {
      dialogRef.current.showModal();
    } else if (!open && dialogRef.current.open) {
      dialogRef.current.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="success-dialog-title"
      onClose={onClose}
    >
      <div className="dialog-card">
        <h2 id="success-dialog-title" className="dialog-title">
          保存が完了しました
        </h2>
        <p className="dialog-text">{formatArchiveFilesMessage(alreadySavedFiles, evidenceImages)}</p>
        {evidenceImages ? (
          <p className="dialog-text">{formatEvidenceImagesMessage(evidenceImages)}</p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
