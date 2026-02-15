/*
  保存エラー表示ダイアログコンポーネント
*/

import { useEffect, useRef } from "react";

function formatPartialWriteErrorMessage(error: string): string | null {
  if (!error.includes("partial-write:")) return null;

  const [rawPart] = error.split("| partial-write:");
  const raw = (rawPart ?? "").trim();

  const rollbackMatch = error.match(
    /rollback=(ok|failed|not-attempted)(?:\s*\(([^)]*)\))?/,
  );
  const rollbackStatus = rollbackMatch?.[1] ?? "unknown";
  const rollbackDetail = rollbackMatch?.[2] ?? null;

  const lines: string[] = ["OneDrive への保存中に途中で失敗しました（部分書き込み）。"];
  if (rollbackStatus === "ok") {
    lines.push("自動ロールバック（description.md の削除）に成功しました。");
  } else if (rollbackStatus === "failed") {
    lines.push("自動ロールバックに失敗しました。");
    lines.push(
      "OneDrive 上に description.md が残っている可能性があります。フォルダを確認して削除してから、保存をやり直してください。",
    );
    if (rollbackDetail) {
      lines.push(`ロールバック失敗理由: ${rollbackDetail}`);
    }
  } else if (rollbackStatus === "not-attempted") {
    lines.push("自動ロールバックは実行されていません。");
  } else {
    lines.push("自動ロールバックの結果が不明です。");
  }

  if (raw) {
    lines.push("");
    lines.push(`詳細: ${raw}`);
  }

  return lines.join("\n");
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
