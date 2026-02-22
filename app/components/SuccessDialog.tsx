// 保存成功ダイアログコンポーネント
import { useEffect, useRef } from "react";

type SuccessDialogProps = {
  open: boolean;
  onClose: () => void;
  evidenceImages?: {
    total: number;
    success: number;
    failed: number;
  } | null;
};

// 画像保存の結果をユーザーフレンドリーなメッセージに変換するユーティリティ関数
export function formatEvidenceImagesMessage(evidenceImages: {
  total: number;
  success: number;
  failed: number;
}): string {
  if (evidenceImages.total === 0) {
    return "画像は対象が0件でした。";
  }
  if (evidenceImages.success === 0 && evidenceImages.failed > 0) {
    return `画像は保存できませんでした（成功: ${evidenceImages.success}件 / 失敗: ${evidenceImages.failed}件）。`;
  }
  return `画像を保存しました（成功: ${evidenceImages.success}件 / 失敗: ${evidenceImages.failed}件）。`;
}

// PR説明とエビデンス画像の保存成功を知らせるダイアログコンポーネント
export function SuccessDialog({ open, onClose, evidenceImages }: SuccessDialogProps) {
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
        <p className="dialog-text">description.md と archive.json を保存しました。</p>
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
