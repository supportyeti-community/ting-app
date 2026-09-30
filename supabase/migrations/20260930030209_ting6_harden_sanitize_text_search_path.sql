-- TING-6: pin sanitize_text() to a deterministic search_path.
-- Production ledger version: 20260930030209.
ALTER FUNCTION public.sanitize_text() SET search_path = '';
