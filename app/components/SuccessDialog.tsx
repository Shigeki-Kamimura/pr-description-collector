// 保存成功ダイアログコンポーネント
import { useEffect, useRef } from "react";

type SuccessDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function SuccessDialog({ open, onClose }: SuccessDialogProps) {
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
        <p className="dialog-text">jsonファイル の保存に成功しました。</p>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
