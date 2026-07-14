"use client";

import { FileCheck2, LoaderCircle } from "lucide-react";
import { useState } from "react";

export function ImportMetadataForm() {
  const [file, setFile] = useState<File>();
  const [state, setState] = useState<"idle" | "hashing" | "saving" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function register() {
    if (!file) return;
    setState("hashing");
    setMessage("正在本机计算 SHA-256，文件内容不会上传。大型Excel可能需要几秒。");
    try {
      const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())))
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      setState("saving");
      setMessage("正在登记批次元数据…");
      const response = await fetch("/api/v1/import-batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceName: file.name, sourceChecksum: checksum, sourceByteSize: file.size, totalRows: 0 })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "登记失败");
      setState("success");
      setMessage(payload.data.created ? "批次已创建，文件仍保留在你的设备上。" : "该文件已登记，已返回原批次。未产生重复数据。");
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "登记失败");
    }
  }

  return (
    <section className="import-tool" aria-labelledby="import-tool-title">
      <div><span className="tool-icon"><FileCheck2 size={20} /></span><div><h2 id="import-tool-title">登记源文件</h2><p>选择XLSX文件后仅计算本地校验值。解析和正式入库将在下一阶段启用。</p></div></div>
      <div className="import-controls"><input accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0]); setState("idle"); setMessage(""); }} type="file" /><button className="primary-button compact" disabled={!file || state === "hashing" || state === "saving"} onClick={register} type="button">{state === "hashing" || state === "saving" ? <LoaderCircle className="spin" size={16} /> : null}{state === "hashing" ? "计算中" : state === "saving" ? "登记中" : "登记批次"}</button></div>
      {message ? <div className={`tool-message ${state}`}>{message}</div> : null}
    </section>
  );
}
