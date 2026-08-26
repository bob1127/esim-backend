// 後端 Supabase service-role client（僅供伺服器端使用，例如藍新 notify 付款成功後
// 把夥伴店訂單的分潤列寫回 Supabase 供結算）。憑證只存在後端環境變數。
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (cached) return cached;
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    "";
  if (!url || !key) return null;
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
