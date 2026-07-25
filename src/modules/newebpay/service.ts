import {
  AbstractPaymentProvider,
  PaymentSessionStatus,
} from "@medusajs/framework/utils";

/**
 * 藍新金流（NewebPay）Payment Provider Module。
 *
 * 藍新的付款流程是「瀏覽器導向 MPG 頁面 → 背景 NotifyURL 回調」，不像 TapPay/Stripe
 * 那樣可以在 API 呼叫當下同步拿到付款結果，所以這個 provider 本身不會呼叫任何藍新 API：
 *
 * - `initiatePayment` 只負責建立 PENDING 狀態的付款 session（實際 MPG 表單在
 *   `/store/newebpay-checkout` route 裡另外組出來）
 * - 真正的授權/請款是在 `/newebpay/notify` 收到背景通知、驗證簽章成功後，直接呼叫
 *   `paymentModuleService.authorizePaymentSession` / `capturePayment` 觸發的，
 *   這裡的 `authorizePayment` / `capturePayment` 只是滿足 Medusa 核心流程的 pass-through。
 */
class NewebpayPaymentService extends AbstractPaymentProvider<any> {
  static identifier = "newebpay";

  constructor(container: any, options: any) {
    super(container, options);
  }

  async getPaymentStatus(paymentSessionData: any): Promise<any> {
    return { status: PaymentSessionStatus.PENDING, data: paymentSessionData };
  }

  async initiatePayment(input: any): Promise<any> {
    return {
      data: input?.data || input?.context?.data || {},
      status: PaymentSessionStatus.PENDING,
    };
  }

  async authorizePayment(input: any): Promise<any> {
    return {
      status: PaymentSessionStatus.AUTHORIZED,
      data: input?.data || input?.paymentSessionData || {},
    };
  }

  async updatePayment(input: any): Promise<any> {
    return { data: input?.data || {} };
  }

  async capturePayment(input: any): Promise<any> {
    return { data: input?.data || {} };
  }

  async refundPayment(input: any): Promise<any> {
    return { data: input?.data || {} };
  }

  async cancelPayment(input: any): Promise<any> {
    return { data: input?.data || {} };
  }

  async deletePayment(input: any): Promise<any> {
    return { data: input?.data || {} };
  }

  async retrievePayment(input: any): Promise<any> {
    return { data: input?.data || {} };
  }

  async getWebhookActionAndData(): Promise<any> {
    return { action: "not_supported", data: {} };
  }
}

export default NewebpayPaymentService;
