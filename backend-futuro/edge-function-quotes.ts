import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (request) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const { ticker, asset_id: assetId } = await request.json().catch(() => ({ ticker: '', asset_id: '' }))
  if (!ticker || !assetId) return new Response(JSON.stringify({ error: 'ticker obrigatório' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const previous = await supabase.from('portfolio_quotes').select('price,currency,quoted_at,is_stale').eq('asset_id', assetId).maybeSingle()
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`)
    if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`)
    const json = await response.json()
    const result = json.chart?.result?.[0]
    const prices = result?.indicators?.quote?.[0]?.close?.filter((value: number | null) => value !== null)
    const price = prices?.at(-1)
    if (typeof price !== 'number') throw new Error('cotação indisponível')
    const row = { asset_id: assetId, ticker, price, currency: result.meta?.currency ?? null, quoted_at: new Date().toISOString(), is_stale: false }
    await supabase.from('portfolio_quotes').upsert(row, { onConflict: 'asset_id' })
    return new Response(JSON.stringify(row), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (error) {
    if (previous.data) return new Response(JSON.stringify({ ...previous.data, is_stale: true, warning: 'Cotação desatualizada: foi usado o último preço conhecido.' }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify({ error: 'Não foi possível obter a cotação e não existe preço anterior.' }), { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
