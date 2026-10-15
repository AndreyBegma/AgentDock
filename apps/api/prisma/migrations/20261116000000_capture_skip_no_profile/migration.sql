-- Issue #272 D8: a capture with no usable runtime profile is skipped, not failed.
-- Existing `failed` rows with `error = 'no_profile: …'` are not back-filled.

-- AlterEnum
ALTER TYPE "CardCaptureSkipReason" ADD VALUE 'no_profile';
