import { redirect } from "next/navigation";
import { currentSession } from "@/server/auth/current";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentSession()) redirect("/");
  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-intro">
          <span className="eyebrow">SELF-HOSTED CONTROL DESK</span>
          <h1 id="login-title">游戏与库存系统</h1>
          <p>统一管理游戏进度、科技资产与消耗库存。当前为单账号工程底座。</p>
          <dl className="login-facts">
            <div><dt>数据层</dt><dd>PostgreSQL 16</dd></div>
            <div><dt>访问</dt><dd>本地账号 · 会话可撤销</dd></div>
            <div><dt>审计</dt><dd>关键写操作留痕</dd></div>
          </dl>
        </div>
        <LoginForm />
      </section>
    </main>
  );
}
