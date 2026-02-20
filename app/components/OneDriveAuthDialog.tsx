/*
  OneDrive 認証完了ダイアログコンポーネント
  oAuth認証の到達は別ルートで処理するため、単純に完了通知のみを行う
*/

import { useEffect, useRef } from "react";

type OneDriveAuthDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function OneDriveAuthDialog({ open, onClose }: OneDriveAuthDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

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
      aria-labelledby="onedrive-auth-dialog-title"
      onClose={onClose}
    >
      <div className="dialog-card">
        <h2 id="onedrive-auth-dialog-title" className="dialog-title">
          OneDrive 認証が完了しました
        </h2>
        <p className="dialog-text">OneDrive への接続が完了しました。</p>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
