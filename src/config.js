// Публичные параметры проекта Supabase. anon-ключ можно держать в коде: доступ к данным
// ограничивают политики RLS, описанные в supabase/schema.sql.
// Значения берутся из Supabase → Project Settings → API.
export const SUPABASE_URL =
	window.ARIS_SUPABASE_URL || 'https://aygkstwuptddirtsomxw.supabase.co'
export const SUPABASE_ANON_KEY =
	window.ARIS_SUPABASE_ANON_KEY ||
	'sb_publishable_ZS20L6w5J6KNaIorjmI-5w_FE-3M8n4'
export const BUCKET = 'attachments'
export const FISH_AUDIO_API_KEY =
	window.ARIS_FISH_AUDIO_API_KEY ||
	'sk-fish-Lp_Ys5WOsHNJtV6olrpFuB8v3nf1t1ogMU4QMo49wYw'
export const isConfigured = () =>
	/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL) &&
	SUPABASE_ANON_KEY.length > 40
