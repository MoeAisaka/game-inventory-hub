"use client";

import { LockKeyhole, UserRound } from "lucide-react";
import { FormEvent, useState } from "react";

export function LoginForm() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error?.message ?? "登录失败，请稍后再试");
        return;
      }
      window.location.assign("/");
    } catch {
      setError("无法连接登录服务，请检查系统状态");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <div className="form-heading"><strong>登录工作台</strong><span>使用本地管理员账号</span></div>
      <label><span>用户名</span><div className="input-wrap"><UserRound size={17} /><input autoComplete="username" name="username" required minLength={3} maxLength={64} /></div></label>
      <label><span>密码</span><div className="input-wrap"><LockKeyhole size={17} /><input autoComplete="current-password" name="password" type="password" required minLength={8} maxLength={256} /></div></label>
      <div className="form-error" aria-live="polite">{error}</div>
      <button className="primary-button" disabled={pending} type="submit">{pending ? "验证中…" : "进入系统"}</button>
      <small>连续5次失败将暂时锁定15分钟。</small>
    </form>
  );
}
