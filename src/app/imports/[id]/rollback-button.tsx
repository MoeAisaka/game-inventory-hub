"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function RollbackButton({ batchId, disabled }: { batchId: string; disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function rollback() {
    if (!window.confirm("确认清空该批次的全部暂存行、图片锚点和对账结果？源文件不会被修改。")) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/v1/import-batches/${batchId}/rollback`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "回滚失败");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回滚失败");
    } finally {
      setBusy(false);
    }
  }

  return <div className="inline-action"><button className="danger-button" type="button" onClick={rollback} disabled={disabled || busy}><RotateCcw size={16} />{busy ? "回滚中…" : "回滚暂存数据"}</button>{message ? <span className="form-error">{message}</span> : null}</div>;
}
