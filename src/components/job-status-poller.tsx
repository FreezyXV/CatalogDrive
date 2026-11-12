"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Refreshes the server-rendered page while an import is queued or being
 * processed by the integration worker (JOB_DISPATCH=queue).
 */
export function JobStatusPoller({
  intervalMs = 2000,
}: {
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
