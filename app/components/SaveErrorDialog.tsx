/*
  保存エラー表示ダイアログコンポーネント
*/

import { useEffect, useRef } from "react";

// 保存エラーダイアログのプロパティ
type SaveErrorDialogProps = {
  open: boolean; // ダイアログ表示フラグ
  onClose: () => void; // ダイアログ閉じるコールバック
  error: string; // エラーメッセージ
  isAuthError: boolean; // 認証エラーかどうか
};

export function SaveErrorDialog({ open, onClose, error, isAuthError }: SaveErrorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    // ダイアログの開閉制御
    if (!dialogRef.current) return;
    if (open && !dialogRef.current.open) {
      dialogRef.current.showModal();
    } else if (!open && dialogRef.current.open) {
      dialogRef.current.close();
    }
  }, [open]);

  if (!error) return null;

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="save-error-dialog-title"
      onClose={onClose}
    >
      <div className="dialog-card">
        <h2 id="save-error-dialog-title" className="dialog-title">
          {isAuthError ? "OneDrive の再認証が必要です" : "保存に失敗しました"}
        </h2>
        <p className="dialog-text">
          {isAuthError
            ? "認証が切れている可能性があります。再認証してから保存をやり直してください。"
            : error}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
