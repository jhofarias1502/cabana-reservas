# Cabana · Reservas diretas + Airbnb

Site de reserva direta com calendário sincronizado com o Airbnb, para não ter reserva dupla.

## Como funciona

- **Airbnb → site:** a cada 15 min o servidor baixa o link iCal (exportação) do Airbnb e bloqueia essas datas no calendário público. Antes de aceitar uma reserva, ele confere o Airbnb de novo.
- **Site → Airbnb:** o servidor publica um feed iCal (`/ical/<token>.ics`) só com as reservas diretas e bloqueios manuais. Você cola esse link no Airbnb e ele bloqueia as datas lá.
- **Reserva direta:** o hóspede (vindo do link no Instagram) escolhe as datas e vê lado a lado o preço no Airbnb (diárias + limpeza + taxa de serviço do Airbnb) e o preço direto, 20% menor. Ao tocar em **Continuar no WhatsApp**, as datas ficam seguradas por 24 h e o WhatsApp abre com uma mensagem pronta (datas, hóspedes, valor). Você combina o pagamento por lá e clica em **Confirmar** no painel. Se não confirmar no prazo, as datas se liberam sozinhas.
- **Opção Airbnb:** o link "Prefiro reservar pelo Airbnb" abre seu anúncio já com as datas e hóspedes escolhidos.
- **Painel `/admin`** (senha em `ADMIN_PASSWORD`): reservas diretas, reservas importadas do Airbnb, bloqueios manuais, link do feed e alerta de conflito.

## Rodar

Requer Node 18+ e nenhuma dependência.

```
cp config.example.json config.json   # preencha os dados
node server.js
```

Abra http://localhost:3000 (site) e http://localhost:3000/admin (painel). Variáveis de ambiente com os mesmos nomes sobrescrevem o `config.json`.

## Página e fotos

Textos, comodidades, regras e fotos vêm do `config.json` (veja `config.example.json`). Coloque as fotos em `public/fotos/` e liste em `PHOTOS`; a primeira vira a foto grande da galeria. Sem fotos, a página mostra uma ilustração no lugar.

## Ligar ao Airbnb

1. No Airbnb: **Calendário → Disponibilidade → Sincronizar calendários → Exportar calendário**. Copie o link e coloque em `AIRBNB_ICAL_URLS` (vários anúncios: separe por vírgula).
2. No painel `/admin`, copie o link do feed e, no Airbnb, use **Importar calendário** com ele.

O Airbnb atualiza calendários importados a cada poucas horas, então ainda existe uma pequena janela de risco logo depois de uma reserva direta. Para datas muito disputadas, bloqueie também à mão no app do Airbnb.

## Limites desta versão

- A taxa de serviço do Airbnb varia por reserva; `AIRBNB_GUEST_FEE_PCT` é uma média. Confira numa simulação no seu anúncio e ajuste.
- Dados ficam em `data/db.json`; faça backup desse arquivo.
- Não envia e-mail/WhatsApp automático ainda.
