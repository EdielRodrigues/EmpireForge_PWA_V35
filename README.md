# Empire Forge Backend V35.2 — PostgreSQL

Esta versão remove completamente SQLite/better-sqlite3.

## Variáveis obrigatórias no Render
- JWT_SECRET
- DATABASE_URL
- PUBLIC_BACKEND_URL
- MERCADOPAGO_ACCESS_TOKEN
- FRONTEND_ORIGIN (quando o site estiver publicado)

## Banco
As tabelas `users` e `pix_orders` são criadas automaticamente no primeiro start.

## Teste
Abra `/health`.
O esperado:
- online: true
- version: 35.2-postgres
- database: true
- databaseType: postgresql
- pixConfigured: true (se o token do Mercado Pago estiver configurado)

## Importante
Dados que estavam apenas no SQLite antigo não são copiados automaticamente para o PostgreSQL.
