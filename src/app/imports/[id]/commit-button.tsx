"use client";

import { DatabaseZap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function CommitButton({ batchId, disabled, committed }: { batchId: string; disabled: boolean; committed: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function commit() {
    if (!window.confirm("确认把已验收的暂存记录写入正式游戏、资产与库存业务表？")) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/v1/import-batches/${batchId}/commit`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "提交失败");
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "提交失败"); }
    finally { setBusy(false); }
  }
  return <div className="inline-action"><button className="primary-button compact" type="button" onClick={commit} disabled={disabled || busy}><DatabaseZap size={15} />{committed ? "已提交" : busy ? "提交中…" : "提交正式数据"}</button>{message ? <span className="form-error">{message}</span> : null}</div>;
}
