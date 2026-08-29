# Notas para a próxima fase (ligação a sério ao Supabase)

Estes ficheiros (`schema.sql` e `edge-function-quotes.ts`) são os que já
tinhas feito antes. Ficam aqui guardados, não são usados pela app local
(`index.html` / `app.js`) por agora.

Quando ligarmos a app a sério à base de dados, há 3 coisas a alinhar entre
o modelo local (`app.js`) e o schema:

1. **Autenticação** — o schema exige `auth.users` (RLS por `user_id`). A
   app local não tem login nenhum; isso tem de ser construído nessa fase
   (Supabase Auth: email/password ou magic link, o mais simples de início).

2. **Ativos (`assets`)** — localmente cada posição é identificada por
   `assetKey` (o ISIN, ou o nome do produto quando não há ISIN). No schema
   existe uma tabela `assets` própria com `id` (uuid) e `isin`. Ao ligar a
   sério, cada `assetKey` novo encontrado no import tem de criar/encontrar
   uma linha em `assets` (`upsert` por `isin`), e as `investment_transactions`
   passam a referenciar `asset_id` em vez do `assetKey` em texto livre.

3. **Cotações** — localmente as cotações são inseridas à mão (`quotes` no
   estado, por `assetKey`). A tabela `portfolio_quotes` já está pronta para
   receber cotações automáticas via a Edge Function (que usa a Yahoo
   Finance). Isso só funciona a partir do browser através da Edge Function
   (por causa de CORS) — por isso ficou de fora da versão local em
   HTML/CSS/JS puro.

O resto da lógica financeira (saldo de conta = saldo inicial + efeito de
cash + efeito de compras/vendas/comissões/dividendos; custo médio ponderado
por ativo) já está escrita em `app.js` exatamente como deve ficar quando
ligada à base de dados — só muda a origem dos dados (Supabase em vez de
`localStorage`).
