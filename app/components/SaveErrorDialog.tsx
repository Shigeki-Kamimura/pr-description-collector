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
  errorCode?: string; // エラーコード
  isAuthError: boolean; // 認証エラーかどうか
  errorContext?: "save" | "image"; // エラー文脈
};

export function SaveErrorDialog({
  open,
  onClose,
  error,
  errorCode,
  isAuthError,
  errorContext = "save",
}: SaveErrorDialogProps) {
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

  const isImageContext = errorContext === "image";
  const isArchiveJsonInvalid = errorCode === "ARCHIVE_JSON_INVALID";
  const formattedPartialWriteError = !isAuthError && !isImageContext
    ? formatPartialWriteErrorMessage(error)
    : null;
  const title = isImageContext
    ? isAuthError
      ? "OneDrive の再認証が必要です"
      : "画像表示に失敗しました"
    : isAuthError
      ? "OneDrive の再認証が必要です"
      : isArchiveJsonInvalid
        ? "archive.json を削除してください"
      : formattedPartialWriteError
        ? "保存に失敗しました（途中まで保存）"
        : "保存に失敗しました";
  const message = isImageContext
    ? isAuthError
      ? `${error}\n再認証してから画像表示を再試行してください。`
      : error
    : isAuthError
      ? `${error}\n再認証してから保存をやり直してください。解決しない場合は管理者にお問い合わせください。`
      : isArchiveJsonInvalid
        ? "保存済みの archive.json が壊れています。OneDrive 上の archive.json を削除してから、Get Description (Fetch Only) と Save to OneDrive (with images) を再実行してください。"
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
