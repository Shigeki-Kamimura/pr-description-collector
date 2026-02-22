/*
  保存エラー表示ダイアログコンポーネント
*/

import { useEffect, useRef } from "react";

export function formatPartialWriteErrorMessage(error: string): string | null {
  if (!error.includes("partial-write:")) return null;
  // セキュリティ上の理由で、内部処理状態や詳細理由はUIに表示しない。
  return "保存中にエラーが発生しました。一部のファイルが保存されたまま残っている可能性があります。再実行する前に OneDrive 上の保存先フォルダーを確認し、重複や不要なファイルを整理してください。解決しない場合は、再認証または時間をおいて再実行してください。";
}

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

  const formattedPartialWriteError = !isAuthError
    ? formatPartialWriteErrorMessage(error)
    : null;
  const title = isAuthError
    ? "OneDrive の再認証が必要です"
    : formattedPartialWriteError
      ? "保存に失敗しました（途中まで保存）"
      : "保存に失敗しました";
  const message = isAuthError
    ? `${error}\n再認証してから保存をやり直してください。解決しない場合は管理者にお問い合わせください。`
    : (formattedPartialWriteError ?? error);

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby="save-error-dialog-title"
      onClose={onClose}
    >
      <div className="dialog-card">
        <h2 id="save-error-dialog-title" className="dialog-title">
          {title}
        </h2>
        <p className="dialog-text">
          {message}
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
