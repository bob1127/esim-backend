// 藍新金流（NewebPay）MPG 共用加解密工具
// 加密：產生 TradeInfo/TradeSha 給結帳表單用
// 解密：驗證並解開背景通知 / 導回頁面帶回來的 TradeInfo

import crypto from "crypto";
import qs from "qs";

export type NewebpayResult = Record<string, any>;

/** AES-256-CBC 加密（給結帳表單用）：物件 → querystring → hex */
export function newebpayAesEncrypt(
  data: Record<string, any>,
  key: string,
  iv: string,
): string {
  const text = new URLSearchParams(data as Record<string, string>).toString();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

/** SHA256 驗章（大寫 hex） */
export function newebpayShaEncrypt(
  aesEncryptedHex: string,
  key: string,
  iv: string,
): string {
  const raw = `HashKey=${key}&${aesEncryptedHex}&HashIV=${iv}`;
  return crypto.createHash("sha256").update(raw).digest("hex").toUpperCase();
}

/** 從原始 POST body（application/x-www-form-urlencoded）裡，不經過 body parser 直接取出某個欄位的原始字串值 */
export function extractRawParam(raw: string, name: string): string {
  const start = raw.indexOf(`${name}=`);
  if (start < 0) return "";
  const s = start + name.length + 1;
  const amp = raw.indexOf("&", s);
  return (amp === -1 ? raw.slice(s) : raw.slice(s, amp)).trim();
}

/** TradeInfo 可能因為 urlencode/空白轉換而有幾種變形，全部列出來試 */
function tradeInfoCandidates(ti: string): string[] {
  const out: string[] = [];
  const hasPct = /%[0-9a-fA-F]{2}/.test(ti);
  out.push(ti);

  if (hasPct) {
    try {
      out.push(decodeURIComponent(ti));
    } catch {
      /* ignore */
    }
  }

  if (!hasPct && /\s/.test(ti)) {
    const restored = ti.replace(/\s/g, "+");
    out.push(restored);
    try {
      out.push(decodeURIComponent(restored));
    } catch {
      /* ignore */
    }
  }

  return Array.from(new Set(out.filter(Boolean)));
}

/** 寬鬆解密：先試正常 auto padding，失敗則手動剪尾找出 JSON 或 querystring 主體 */
function decryptLenient(
  encrypted: string,
  key: string,
  iv: string,
  encoding: "hex" | "base64",
): { plaintext: string; mode: string } | null {
  const normalized =
    encoding === "base64"
      ? (() => {
          const norm = encrypted
            .replace(/\s+/g, "+")
            .replace(/-/g, "+")
            .replace(/_/g, "/");
          return norm + "===".slice((norm.length + 3) % 4);
        })()
      : encrypted;

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(key, "utf8"),
      Buffer.from(iv, "utf8"),
    );
    decipher.setAutoPadding(true);
    let out = decipher.update(normalized, encoding, "utf8");
    out += decipher.final("utf8");
    return { plaintext: out, mode: `${encoding}-auto` };
  } catch {
    /* fall through to lenient mode below */
  }

  try {
    const buf = Buffer.from(normalized, encoding);
    const decipher2 = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(key, "utf8"),
      Buffer.from(iv, "utf8"),
    );
    decipher2.setAutoPadding(false);
    const raw = Buffer.concat([decipher2.update(buf), decipher2.final()]);
    const txt = raw.toString("utf8");

    const l = txt.indexOf("{");
    const r = txt.lastIndexOf("}");
    if (l !== -1 && r !== -1 && r > l) {
      return { plaintext: txt.slice(l, r + 1), mode: `${encoding}-lenient-json` };
    }

    if (txt.includes("=") && txt.includes("&")) {
      const lastAmp = txt.lastIndexOf("&");
      return {
        plaintext: lastAmp > 0 ? txt.slice(0, lastAmp) : txt,
        mode: `${encoding}-lenient-qs`,
      };
    }

    return { plaintext: txt, mode: `${encoding}-lenient-raw` };
  } catch {
    return null;
  }
}

function smartDecrypt(
  encrypted: string,
  key: string,
  iv: string,
): { plaintext: string; mode: string } | null {
  const ti = String(encrypted || "").trim();
  const isHex = /^[0-9a-fA-F]+$/.test(ti) && ti.length % 2 === 0;
  return isHex
    ? decryptLenient(ti, key, iv, "hex")
    : decryptLenient(ti, key, iv, "base64");
}

function parseDecrypted(text: string): any {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.Result === "string") {
      try {
        obj.Result = JSON.parse(obj.Result);
      } catch {
        obj.Result = qs.parse(obj.Result);
      }
    }
    return obj;
  } catch {
    const r: any = qs.parse(text);
    if (r?.Result && typeof r.Result === "string") {
      try {
        r.Result = JSON.parse(r.Result);
      } catch {
        r.Result = qs.parse(r.Result);
      }
    }
    return r;
  }
}

export type VerifyOutcome = {
  shaOk: boolean;
  result: NewebpayResult | null;
  payloadStatus?: string;
  decodeMode?: string;
  error?: string;
};

/**
 * 驗證 TradeSha 並解密 TradeInfo。
 * tiRaw / tsRaw 建議直接從 raw body 用 extractRawParam 取出，避免 body parser 把 + 轉成空白。
 */
export function verifyAndDecryptTradeInfo(
  tiRaw: string,
  tsRaw: string,
  key: string,
  iv: string,
): VerifyOutcome {
  if (!tiRaw || !tsRaw) {
    return { shaOk: false, result: null, error: "缺少 TradeInfo 或 TradeSha" };
  }

  const candidates = tradeInfoCandidates(tiRaw);
  let matched = "";
  for (const cand of candidates) {
    if (newebpayShaEncrypt(cand, key, iv) === tsRaw) {
      matched = cand;
      break;
    }
  }

  if (!matched) {
    return { shaOk: false, result: null, error: "TradeSha 驗證失敗" };
  }

  try {
    const decrypted = smartDecrypt(matched, key, iv);
    if (!decrypted) {
      return { shaOk: true, result: null, error: "解密失敗" };
    }
    const payload = parseDecrypted(decrypted.plaintext);
    return {
      shaOk: true,
      result: payload?.Result ?? null,
      payloadStatus: payload?.Status,
      decodeMode: decrypted.mode,
    };
  } catch (e: any) {
    return { shaOk: true, result: null, error: e?.message || String(e) };
  }
}

/** 是否已經真正付款完成（有付款時間戳；信用卡另外看 Status） */
export function hasPayMoment(result: NewebpayResult | null): boolean {
  return !!(
    result?.PayTime ||
    result?.PaymentTime ||
    result?.PayDate ||
    result?.CloseTime
  );
}

export function firstPayMoment(result: NewebpayResult | null): string {
  return (
    result?.PayTime ||
    result?.PaymentTime ||
    result?.PayDate ||
    result?.CloseTime ||
    ""
  );
}

export function isPaidResult(
  result: NewebpayResult | null,
  status?: string,
): boolean {
  const t = String(result?.PaymentType || "").toUpperCase();
  const paid = hasPayMoment(result);
  if (t === "CREDIT") return status === "SUCCESS" || paid;
  return paid;
}

export function isOffsitePendingResult(result: NewebpayResult | null): boolean {
  const t = String(result?.PaymentType || "").toUpperCase();
  return (
    (t === "VACC" || t === "CVS" || t === "WEBATM") && !hasPayMoment(result)
  );
}

export function buildOffsiteInfo(result: NewebpayResult | null) {
  return {
    PaymentType: String(result?.PaymentType || "").toUpperCase(),
    BankCode: result?.BankCode || result?.BankNo || result?.PayBankCode || "",
    CodeNo:
      result?.CodeNo ||
      result?.ATMAccNo ||
      result?.PaymentNo ||
      result?.PayerAccount5Code ||
      "",
    PaymentNo: result?.PaymentNo || "",
    StoreType: result?.StoreType || "",
    ExpireDate: result?.ExpireDate || result?.ExpireTime || "",
    TradeNo: result?.TradeNo || "",
    Amt: result?.Amt,
  };
}
