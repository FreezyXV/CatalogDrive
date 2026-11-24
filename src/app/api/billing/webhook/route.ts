import { errorResponse } from "@/server/http";
import { handleStripeEvent, verifyWebhook } from "@/server/billing/stripe";

export const runtime = "nodejs";

/**
 * Stripe webhook. The signature is checked on the raw body; any error other
 * than a bad signature answers 5xx so that Stripe retries the delivery.
 */
export async function POST(request: Request) {
  try {
    const event = await verifyWebhook(
      await request.text(),
      request.headers.get("stripe-signature"),
    );
    const result = await handleStripeEvent(event);
    return Response.json({ received: true, result });
  } catch (error) {
    return errorResponse(error);
  }
}
