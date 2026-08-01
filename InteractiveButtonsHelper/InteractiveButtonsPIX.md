# Interactive Buttons — Card PIX (Zapo e Whaileys / Baileys)

Guia para enviar o **card de chave PIX** do WhatsApp (logo + nome + chave + “Copiar chave Pix”) a partir de um CRM ou painel próprio.

O payload protobuf é o mesmo. O que muda é **como cada lib anexa o nó binário `biz`**. Por isso Zapo e Whaileys/Baileys estão em seções separadas.

---

## 1. Do que se trata

Não existe um tipo de mensagem “PIX” pronto nas libs não-oficiais. O card simples é um **Native Flow**:

| Botão (`name`)   | O que aparece no celular                | Uso neste guia |
|------------------|-----------------------------------------|----------------|
| `payment_info`   | Chave PIX + “Copiar chave Pix”          | Sim            |
| `review_and_pay` | Cobrança (itens, total, nº do pedido)   | Não (outro fluxo) |

Usar `review_and_pay` no lugar de `payment_info` gera o card de **cobrança**, não o de chave.

Conta pessoal também envia `payment_info`. Não depende da API Oficial (Cloud API / WABA).

---

## 2. Regra de ouro: o nó `biz`

O protobuf sozinho não basta. No envio precisa ir um nó companheiro `<biz>`.

### PIX simples (`payment_info`)

```js
{
  tag: "biz",
  attrs: { native_flow_name: "payment_info" }
  // sem filhos
}
```

### Cobrança (`review_and_pay`)

```js
{
  tag: "biz",
  attrs: { native_flow_name: "order_details" }
  // sem filhos
}
```

### Botões comuns (quick reply, CTA, lista genérica)

```js
{
  tag: "biz",
  attrs: {},
  content: [
    {
      tag: "interactive",
      attrs: { type: "native_flow", v: "1" },
      content: [
        { tag: "native_flow", attrs: { v: "9", name: "mixed" } }
      ]
    }
  ]
}
```

### Erros comuns

| Sintoma | Causa típica |
|---------|----------------|
| Ack **479** | `biz` com `native_flow_name=payment_info` **e** filhos dentro |
| Aparece no Web, some no celular | Foi com `mixed` em vez de `payment_info` |
| Card de cobrança (total R$ 0,00) | Usou `review_and_pay` |
| “Visualização única” / card estranho | Envelope `viewOnceMessage` no PIX |

Formato **errado** para PIX:

```js
{
  tag: "biz",
  attrs: { native_flow_name: "payment_info" },
  content: [ /* interactive / native_flow */ ]
}
```

---

## 3. Payload da mensagem (comum)

### 3.1 Tipos de chave

`PHONE` | `CPF` | `CNPJ` | `EMAIL` | `EVP`

Sugestão de normalização:

- `PHONE`, `CPF`, `CNPJ` → só dígitos  
- `EMAIL`, `EVP` → trim

### 3.2 `buttonParamsJson` (objeto → `JSON.stringify`)

```js
{
  order: {
    items: [
      {
        name: "",
        retailer_id: `custom-item-${referenceId}`,
        amount: { offset: 1, value: 0 },
        quantity: 0
      }
    ],
    order_type: "ORDER_WITHOUT_AMOUNT",
    status: "payment_requested",
    subtotal: { value: 0, offset: 1 }
  },
  total_amount: { value: 0, offset: 1 },
  reference_id: referenceId,
  payment_settings: [
    {
      type: "pix_static_code",
      pix_static_code: {
        key_type: "CPF",
        merchant_name: "Nome do recebedor",
        key: "12345678901"
      }
    },
    {
      type: "cards",
      cards: { enabled: false }
    }
  ],
  external_payment_configurations: [
    {
      payment_instruction: "",
      type: "payment_instruction"
    }
  ],
  additional_note: "",
  currency: "BRL",
  type: "physical-goods"
}
```

`referenceId`: string curta aleatória.

### 3.3 Corpo protobuf

```js
{
  interactiveMessage: {
    nativeFlowMessage: {
      buttons: [
        {
          name: "payment_info",
          buttonParamsJson: JSON.stringify(buttonParams)
        }
      ],
      messageVersion: 1
    }
  },
  messageContextInfo: {
    messageSecret: /* 32 bytes aleatórios */
  }
}
```

`body` / `header` / `footer` não são obrigatórios nesse card.

Comportamento alinhado ao envio tipo WPPConnect `sendPixKeyMessage` (`payment_info` + mesmo JSON).

---

## 4. Zapo

### 4.1 Envio

A Zapo aceita o protobuf no envio de mensagem:

```js
await client.message.send(jid, {
  interactiveMessage: {
    nativeFlowMessage: { buttons: [...], messageVersion: 1 }
  },
  messageContextInfo: { messageSecret }
});
```

### 4.2 Problema

Por padrão a lib costuma anexar sempre:

`biz > interactive > native_flow name=mixed`

Com isso o card de chave falha no celular (ou o servidor responde 479 se o `biz` estiver malformado).

### 4.3 Correção

Ajustar (via patch nos exports internos, uma vez no processo) as funções que decidem e montam o addon:

1. Resolver o tipo do addon a partir do 1º botão:  
   - `payment_info` → `"payment_info"`  
   - `review_and_pay` → `"order_details"`  
   - demais → comportamento original

2. Ao montar o nó:  
   - `payment_info` / `order_details` → só  
     `{ tag: "biz", attrs: { native_flow_name: "..." } }`  
   - demais → builder original (`mixed`, lista, etc.)

Se o `exports` do pacote bloquear `require("zapo-js/dist/...")`, carregue os arquivos pelo caminho absoluto a partir de `require.resolve("zapo-js")` (pasta `dist/`).

### 4.4 Observação

O patch só muda o addon nesses botões. Texto e mídia normais não precisam de mudança.

---

## 5. Whaileys / Baileys (fork)

### 5.1 Envio

Mesmo protobuf, via `generateWAMessageFromContent` + `relayMessage`:

```js
const generated = generateWAMessageFromContent(jid, content, { userJid });
await sock.relayMessage(jid, generated.message, {
  messageId: generated.key.id
});
```

### 5.2 Problema

Várias forks montam sempre `native_flow name=mixed` dentro do `<biz>`.

Em muitas versões, `additionalNodes` no `relayMessage` **não existe** ou é ignorado.  
Trocar `sock.sendNode` depois do connect também não resolve: o `relayMessage` usa o `sendNode` guardado na **closure** na criação do socket.

### 5.3 Correção

Alterar o builder do nó `biz` **no código da lib** (ex.: em `messages-send`), algo como:

1. Desembrulhar wrappers (`viewOnce`, `ephemeral`, `documentWithCaption`, etc.).  
2. Ler `buttons[0].name`.  
3. `payment_info` → biz só com `native_flow_name: "payment_info"`.  
4. `review_and_pay` → `native_flow_name: "order_details"`.  
5. Caso contrário → lista ou `mixed` como já era.

Empurrar o nó completo no stanza:

```js
const buttonBizNode = createButtonBizNode(innerMessage);
if (buttonBizNode) stanza.content.push(buttonBizNode);
```

Não embrulhar de novo em outro `{ tag: "biz", content: ... }`.

Rebuild/publicar a lib e atualizar a dependência no app. Isso só afeta mensagem interativa — não mexe em login/QR.

### 5.4 Evitar

- Confiar em `additionalNodes` sem checar a sua versão.  
- Patch de `sendNode` depois do `makeWASocket`.  
- `viewOnceMessage` em volta do PIX “porque botão precisa”.

---

## 6. Camada do CRM / painel

### 6.1 API

Endpoint de exemplo:

`POST /conversations/:id/pix`  
(ou o padrão de rotas do seu sistema)

Body de exemplo:

```json
{
  "merchantName": "Nome do recebedor",
  "key": "chave",
  "keyType": "CPF",
  "instructions": "texto opcional"
}
```

Fluxo sugerido:

1. Resolver a conversa e a conexão WhatsApp usada nela.  
2. Se a conexão for Zapo → enviar pelo caminho Zapo.  
3. Se for Whaileys/Baileys → enviar pelo caminho Baileys.  
4. Se for Cloud API Oficial → este native flow não se aplica.  
5. Salvar no histórico um registro próprio (tipo + JSON com nome/chave) para o front desenhar o card no painel.

### 6.2 Interface

- Mostrar “Pix” no anexo só quando a conexão da conversa for Zapo ou Baileys/Whaileys.  
- Formulário: nome, tipo de chave, chave.  
- Na bolha do painel: card local a partir do JSON salvo (não precisa decodificar o proto).

### 6.3 Destino

Usar o mesmo JID/LID que o restante do envio da conversa (`@s.whatsapp.net`, `@lid`, `@g.us`).

---

## 7. Checklist

1. Zapo: card no celular e no Web.  
2. Whaileys/Baileys: idem.  
3. Não aparece layout de cobrança (nº / total).  
4. “Copiar chave Pix” funciona no app.  
5. Texto e mídia normais continuam ok.  
6. Cloud API Oficial não usa este botão.  
7. Se der **479**, revisar o `biz` (sem filhos no `payment_info`).

---

## 8. Resumo

```
Protobuf: buttons[0].name = "payment_info"
JSON:     ORDER_WITHOUT_AMOUNT + pix_static_code
Biz:      { tag: "biz", attrs: { native_flow_name: "payment_info" } }

Zapo:     ajustar resolve/build do addon (path absoluto se exports bloquear)
Baileys:  ajustar builder do biz na lib (não usar mixed no PIX)
App:      endpoint + UI só nas conexões que usam essas libs
```
