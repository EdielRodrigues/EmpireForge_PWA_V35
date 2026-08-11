# Empire Forge Backend V35

## O que já está pronto
- Cadastro com nome, e-mail, telefone/DDD e senha.
- Login com JWT.
- ID único de jogador.
- Saldo de gemas por usuário.
- Criação de Pix para os 4 pacotes oficiais definidos no jogo.
- Webhook de pagamento.
- Crédito automático de gemas **uma única vez** após status `approved`.
- Consulta de status pelo frontend.

## Para ativar
1. Publique esta pasta em um servidor Node.js (por exemplo, Render).
2. Copie `.env.example` para `.env` e configure:
   - `JWT_SECRET`
   - `MERCADOPAGO_ACCESS_TOKEN`
   - `PUBLIC_BACKEND_URL`
   - `FRONTEND_ORIGIN`
3. No `config.js` do PWA, coloque a URL do backend em `API_BASE`.
4. Configure a URL HTTPS do webhook no provedor de pagamento.
5. Antes de produção, configure validação de assinatura do webhook conforme a configuração da sua conta/provedor.

## Banco
A V35 usa SQLite local no backend para deixar o fluxo completo e testável. Antes de escalar multiplayer, migrar para um banco gerenciado é recomendado.
