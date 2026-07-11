import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Users } from "@medusajs/icons";
import { useEffect, useRef } from "react";

const DASHBOARD_URL =
  (typeof import.meta !== "undefined" &&
    (import.meta as ImportMeta & { env?: Record<string, string> }).env
      ?.VITE_JEKO_PARTNER_DASHBOARD_URL) ||
  "http://localhost:3000/admin-boss?embed=1";

function readAdminToken() {
  if (typeof window === "undefined") return null;
  const keys = [
    "medusa_auth_token",
    "medusa_token",
    "token",
  ];
  for (const k of keys) {
    const v = localStorage.getItem(k) || sessionStorage.getItem(k);
    if (v) return v.replace(/^Bearer\s+/i, "");
  }
  // Medusa v2 可能用 JSON session
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k || !/auth|token|session/i.test(k)) continue;
      try {
        const raw = store.getItem(k);
        if (!raw) continue;
        if (raw.startsWith("eyJ")) return raw;
        const parsed = JSON.parse(raw);
        const t = parsed?.token || parsed?.access_token || parsed?.jwt;
        if (typeof t === "string" && t.length > 20) return t.replace(/^Bearer\s+/i, "");
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function readAdminEmail() {
  if (typeof window === "undefined") return "";
  try {
    const raw = localStorage.getItem("medusa_user") || sessionStorage.getItem("medusa_user");
    if (raw) {
      const u = JSON.parse(raw);
      return u.email || "";
    }
  } catch {
    /* ignore */
  }
  return "";
}

const PartnerManagementPage = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.data?.type !== "jeko_boss_ready") return;
      const token = readAdminToken();
      if (!token || !iframeRef.current?.contentWindow) return;
      iframeRef.current.contentWindow.postMessage(
        {
          type: "jeko_boss_token",
          token,
          email: readAdminEmail(),
        },
        "*",
      );
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="flex h-[calc(100vh-64px)] w-full flex-col bg-ui-bg-subtle">
      <iframe
        ref={iframeRef}
        title="JEKO 夥伴管理"
        src={DASHBOARD_URL}
        className="h-full w-full flex-1 border-0"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
};

export const config = defineRouteConfig({
  label: "夥伴管理",
  icon: Users,
});

export default PartnerManagementPage;
