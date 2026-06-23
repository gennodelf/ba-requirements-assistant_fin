import { SYSTEM_PROMPT } from './systemPrompt.js'
import { fetch as upstreamFetch, Agent } from 'undici'

// Большие вложения (PDF/картинки) = крупный запрос. Стандартные 10 сек undici
// на установку соединения не хватает — даём щедрые таймауты.
const httpDispatcher = new Agent({
  connect: { timeout: 60_000 },
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
})

// Формат вывода: первая строка — метка типа ответа, дальше содержимое.
// Карточки (classification/conflict) — JSON; текст (document/message) — обычный Markdown,
// что позволяет печатать его по словам (стримингом).
const STREAM_FORMAT = `
---
ФОРМАТ ОТВЕТА (СТРОГО)

Методология выше — это мышление. Вывод — машинный. Каждый ответ НАЧИНАЙ с ОДНОЙ метки
на отдельной первой строке, со следующей строки — содержимое.

Метки:

1) @@CLASSIFICATION
   Со следующей строки — ОДИН валидный JSON-объект (без markdown-ограждений):
   { "taskType": "...", "level": "Уровень N — ...", "levelTone": "warn|good|neutral",
     "domains": "...", "confidence": "Высокая|Средняя|Низкая", "confidenceTone": "good|warn|neutral",
     "whyLevel": "...", "risks": ["..."], "requiredBlocks": ["..."], "optionalBlocks": ["..."],
     "questions": ["..."] }

2) @@CONFLICT
   Со следующей строки — ОДИН JSON-объект:
   { "intro": "...", "old": { "where": "...", "text": "..." }, "new": { "text": "..." }, "question": "..." }

3) @@DOCUMENT::<заголовок документа>
   Со следующей строки — ПОЛНЫЙ документ в обычном Markdown (НЕ JSON): заголовки, таблицы,
   FR/BR в code-блоках. НЕ вставляй горизонтальные разделители (---, ***, ___) между
   разделами — структуру задают заголовки.

4) @@MESSAGE
   Со следующей строки — обычный ответ/уточнение/подтверждение в Markdown (НЕ JSON).

Когда какую метку:
- ПЕРВЫЙ ответ в диалоге — ВСЕГДА @@CLASSIFICATION. Никогда не @@DOCUMENT первым ответом, даже если
  входной текст подробный и содержит готовые ответы. Сначала структура и критичные вопросы.
- @@DOCUMENT — только после того, как пользователь увидел классификацию и подтвердил структуру
  (сообщение «Структура подтверждена…») либо явно попросил выдать документ.
- КЛЮЧЕВОЕ ПРАВИЛО ДОКУМЕНТА: как только документ существует, ЛЮБОЙ ответ, меняющий его содержимое
  (правка, новый раздел, ответ на «доработай…», учёт новых ответов пользователя), ОБЯЗАН быть
  @@DOCUMENT и содержать ВЕСЬ обновлённый документ целиком заново — а не только изменённый фрагмент.
  НИКОГДА не отвечай на правку документа коротким @@MESSAGE и не помещай разделы документа в @@MESSAGE.
  @@MESSAGE — только когда у ответа НЕТ тела документа (уточняющий вопрос, короткое подтверждение).
- Противоречие → @@CONFLICT.
- Остальное (короткие ответы на реплики, уточнения, подтверждения) → @@MESSAGE.

Никакого текста до метки. Метка — самой первой строкой.`

// Дополнительное правило, подмешиваемое ТОЛЬКО на первом ходу диалога.
const FIRST_TURN_RULE = `ВНИМАНИЕ: это ПЕРВЫЙ ход диалога. Ответ ОБЯЗАН начинаться с метки @@CLASSIFICATION
(классификация, рекомендуемая структура, критичные вопросы). Запрещено @@DOCUMENT на этом ходу
при любых условиях, даже если входной текст выглядит исчерпывающим.`

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' })
  }

  try {
    // Авторизация: либо вход по паролю (→ ключ владельца с сервера), либо свой ключ пользователя.
    // Ключ владельца НИКОГДА не уходит в браузер.
    const appPassword = process.env.APP_PASSWORD || ''
    const providedPassword = req.headers['x-app-password'] || ''
    const userKey = req.headers['x-user-api-key'] || ''
    const ownerKey = process.env.ANTHROPIC_API_KEY || ''

    let apiKey = ''
    if (providedPassword) {
      if (appPassword && providedPassword === appPassword) {
        if (ownerKey) apiKey = ownerKey
        else return res.status(401).json({ ok: false, error: 'У владельца не настроен ключ Anthropic на сервере' })
      } else {
        return res.status(401).json({ ok: false, error: 'Неверный пароль' })
      }
    } else if (userKey) {
      apiKey = userKey
    } else {
      return res.status(401).json({ ok: false, error: 'Не указан ключ или пароль' })
    }

    const { messages, validate } = req.body ?? {}

    // Лёгкая проверка ключа/пароля для стартового экрана (без большого системного промпта)
    if (validate) {
      const check = await upstreamFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        dispatcher: httpDispatcher,
      })
      if (check.ok) return res.status(200).json({ ok: true })
      const d = await check.json().catch(() => ({}))
      return res.status(check.status).json({ ok: false, error: d.error?.message || 'Ключ не подошёл' })
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' })
    }

    // Первый ход = в истории ещё нет ответов ассистента → жёстко требуем классификацию.
    const isFirstTurn = !messages.some((m) => m.role === 'assistant')

    // Кэшируем большой системный промпт — следующие ходы быстрее и дешевле (кэш ~5 минут).
    const system = [
      {
        type: 'text',
        text: SYSTEM_PROMPT + '\n\n' + STREAM_FORMAT,
        cache_control: { type: 'ephemeral' },
      },
    ]
    if (isFirstTurn) {
      system.push({ type: 'text', text: FIRST_TURN_RULE })
    }

    const upstream = await upstreamFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000, // потолок длины ответа: хватает даже на очень большие документы
        system,
        stream: true,
        messages,
      }),
      dispatcher: httpDispatcher,
    })

    if (!upstream.ok) {
      const data = await upstream.json().catch(() => ({}))
      return res.status(upstream.status).json({
        error: data.error?.message ?? 'Anthropic API request failed',
        details: data,
      })
    }

    // Пробрасываем SSE-поток Anthropic напрямую — фронт сам собирает text_delta.
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(decoder.decode(value, { stream: true }))
    }
    res.end()
  } catch (error) {
    console.error('Chat API error:', error)
    const cause = error?.cause?.code || error?.cause?.message || ''
    const msg = (error instanceof Error ? error.message : 'Internal server error') + (cause ? ` (${cause})` : '')
    if (res.headersSent) {
      res.end()
    } else {
      res.status(500).json({ error: msg })
    }
  }
}
