# Gestor de Património — versão local (HTML/CSS/JS puro)

## Como abrir
Basta abrir `index.html` diretamente no navegador (duplo-clique). Não há
build, não há `npm install`, não há servidor. Os dados ficam guardados no
`localStorage` do navegador onde abrires o ficheiro.

## Ficheiros
- `index.html` — estrutura da página
- `styles.css` — estilos (mesma linguagem visual que já tinhas)
- `app.js` — tudo o resto: estado, cálculos financeiros, parser DEGIRO, importação, e renderização das páginas
- `backend-futuro/` — o `schema.sql` e a Edge Function que já tinhas feitos, guardados para quando ligarmos a app a uma base de dados a sério (ver `backend-futuro/NOTAS.md`)

## Bugs de lógica corrigidos nesta versão

1. **Importação DEGIRO "não atualizava em todo o lado"** — a versão
   anterior exigia que já existisse, à mão, uma conta do tipo Corretora
   com "degiro" no nome; se não existisse, a importação falhava com um
   erro que só aparecia 2 segundos num toast e desaparecia. Agora, se não
   existir, a conta "DEGIRO" é **criada automaticamente**, e no fim da
   importação fica um resumo persistente na página a dizer exatamente
   quantos movimentos entraram, quantos já lá estavam e se a conta foi
   criada.

2. **Compras/vendas de ações não mexiam no saldo em dinheiro** — no
   modelo anterior, comprar ações só criava uma posição no portfólio, sem
   nunca reduzir o saldo da conta DEGIRO. Isso inflacionava o património
   total artificialmente (o dinheiro "ficava lá" e o valor da ação também
   contava). Agora, cada transação de investimento está ligada a uma
   conta (`accountId`) e o saldo da conta = saldo inicial + receitas/despesas
   manuais + efeito de compras/vendas/dividendos/comissões/impostos.

3. **Comissões e impostos contados a dobrar** — antes, uma comissão
   entrava simultaneamente como custo extra na posição do ativo (subindo
   artificialmente o preço médio) **e** como despesa em dinheiro. Agora só
   afeta o saldo em dinheiro da conta; o custo médio do ativo só reflete
   compras e vendas reais.

4. **Uma venda maior do que a posição existente rebentava a app inteira**
   — o cálculo lançava uma exceção não tratada, o que podia deixar o ecrã
   em branco por causa de uma única linha mal interpretada do CSV. Agora
   fica sinalizado por baixo do ativo em causa ("venda excede posição"),
   sem quebrar o resto da aplicação.

5. **Cotações do portfólio nunca eram preenchidas** — sem ligação a uma
   API (que exigia backend, por causa de CORS), o valor de mercado de
   cada posição ficava sempre a 0. Adicionei um campo simples para
   introduzires a cotação manualmente por ativo; isto é temporário até
   ligarmos a Edge Function que já tens feita.

## Próximo passo
Quando quiseres, avançamos para a ligação a sério ao Supabase (autenticação
+ leitura/escrita real + cotações automáticas via a Edge Function). Ver
`backend-futuro/NOTAS.md` para o que precisa de mudar.
