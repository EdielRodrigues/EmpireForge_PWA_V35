BACKEND V35.3
Nova rota POST /api/wallet/spend.
O desconto é transacional no PostgreSQL, impede saldo negativo e usa transactionId contra cobrança duplicada.
Publique este backend antes do SITE V35.6.
