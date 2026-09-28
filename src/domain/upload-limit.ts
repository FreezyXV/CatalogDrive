export const SMALL_UPLOAD_BYTES = 5 * 1024 * 1024;
export const SUPABASE_FREE_UPLOAD_BYTES = 50_000_000;
export const B2_TRIAL_UPLOAD_BYTES = 200_000_000;
export const DEFAULT_UPLOAD_BYTES = SUPABASE_FREE_UPLOAD_BYTES;

export function uploadLimitBytes() {
  const value = process.env.UPLOAD_MAX_BYTES;
  if (!value) return DEFAULT_UPLOAD_BYTES;
  if (value === String(SMALL_UPLOAD_BYTES)) return SMALL_UPLOAD_BYTES;
  if (value === String(SUPABASE_FREE_UPLOAD_BYTES))
    return SUPABASE_FREE_UPLOAD_BYTES;
  if (value === String(B2_TRIAL_UPLOAD_BYTES)) return B2_TRIAL_UPLOAD_BYTES;
  throw new Error(
    "UPLOAD_MAX_BYTES doit valoir 5242880, 50000000, 200000000 ou être absent.",
  );
}

export function uploadLimitLabel(bytes = uploadLimitBytes()) {
  if (bytes === SMALL_UPLOAD_BYTES) return "5 Mio";
  if (bytes === SUPABASE_FREE_UPLOAD_BYTES) return "50 Mo";
  return `${Math.floor(bytes / 1_000_000)} Mo`;
}
