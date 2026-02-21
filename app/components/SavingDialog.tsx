/*
  保存中ダイアログコンポーネント

  このファイルを用意した理由:
  - OneDrive 保存に時間がかかる間、処理中であることを明示して誤操作や再送信を防ぐため。

  このファイルが使われる場面:
  - `/api/onedrive/upload` 実行中に、画面上で保存処理の進行中表示を出すとき。
*/

import { useEffect, useRef } from "react";

type SavingDialogProps = {
  open: boolean;
};

export function SavingDialog({ open }: SavingDialogProps) {
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
      aria-labelledby="saving-dialog-title"
    >
      <div className="dialog-card">
        <h2 id="saving-dialog-title" className="dialog-title">
          保存中です
        </h2>
        <p className="dialog-text">
          OneDrive へ保存しています。画像件数によっては時間がかかることがあります。
        </p>
      </div>
    </dialog>
  );
}
