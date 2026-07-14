"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

export function LogoutButton() {
  const [pending, setPending] = useState(false);
  return (
    <button
      className="nav-action"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await fetch("/api/v1/auth/logout", { method: "POST" });
        window.location.assign("/login");
      }}
      type="button"
    >
      <LogOut size={16} aria-hidden="true" />
      {pending ? "退出中" : "退出登录"}
    </button>
  );
}
