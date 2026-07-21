import { nanoid } from 'nanoid'
import type { AgentTeamTemplate, AiProvider, TeamPermissionPolicy } from '../../shared/types'

// OpenRouter / DeepSeek üzerinden, kullanıcının hedefine göre profesyonel bir
// agent takımı (üyeler + sistem talimatları + görevler) tasarlatır. Çıktı kesin
// JSON şeması ile doğrulanır; hatalarda anlamlı Türkçe mesaj fırlatılır.

const TIMEOUT_MS = 60_000
const VALID_POLICIES: TeamPermissionPolicy[] = ['review', 'controlled', 'balanced', 'full']

interface ChatEndpoint {
  url: string
  headers: Record<string, string>
}

function endpointFor(provider: AiProvider, apiKey: string): ChatEndpoint {
  if (provider === 'openrouter') {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://termflow.app',
        'X-Title': 'TermFlow'
      }
    }
  }
  if (provider === 'deepseek') {
    return {
      url: 'https://api.deepseek.com/chat/completions',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  }
  throw new Error('Geçersiz AI sağlayıcı')
}

const SYSTEM_PROMPT = `Sen kıdemli bir yazılım ekip liderisin. Kullanıcının hedefine göre, birlikte çalışacak profesyonel bir yapay zeka ajan takımı tasarlarsın.
Çıktıyı YALNIZCA geçerli JSON olarak ver (açıklama, markdown veya kod bloğu YOK). Şema:
{
  "name": string,               // kısa takım adı
  "description": string,        // takımın amacını özetleyen 1-2 cümle
  "permissionPolicy": "review" | "controlled" | "balanced" | "full",
  "members": [                  // 2-6 üye
    { "name": string, "role": string, "instructions": string }
  ],
  "tasks": [
    { "title": string, "description": string, "assigneeIndex": number, "acceptanceCriteria": string[] }
  ]
}
Her üyenin "instructions" alanı, o ajanın TAM sistem talimatı olacak şekilde ayrıntılı ve profesyonel Türkçe yazılmalıdır: sorumlulukları, çalışma yöntemi, kalite kapıları ve sınırları içermelidir.
"assigneeIndex" members dizisindeki 0 tabanlı üye indeksidir. Tüm metinler Türkçe olsun.`

function pickContent(data: unknown): string {
  const choices = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices
  const content = choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI yanıtı boş döndü')
  return content
}

function coerceTemplate(raw: unknown): AgentTeamTemplate {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    // Bazı modeller JSON'u kod bloğuna sarabilir; ilk { .. son } aralığını dene.
    const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
    try {
      parsed = JSON.parse(text)
    } catch {
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start < 0 || end <= start) throw new Error('AI yanıtı geçerli JSON değil')
      parsed = JSON.parse(text.slice(start, end + 1))
    }
  }
  const obj = parsed as Record<string, unknown>
  if (!obj || typeof obj !== 'object') throw new Error('AI yanıtı geçerli JSON değil')
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  const description = typeof obj.description === 'string' ? obj.description.trim() : ''
  if (!name) throw new Error('AI yanıtında takım adı eksik')
  const policy = VALID_POLICIES.includes(obj.permissionPolicy as TeamPermissionPolicy)
    ? (obj.permissionPolicy as TeamPermissionPolicy)
    : 'controlled'
  const rawMembers = Array.isArray(obj.members) ? obj.members : []
  if (rawMembers.length < 2 || rawMembers.length > 6) throw new Error('AI takımı 2-6 üye içermeli')
  const members = rawMembers.map((m) => {
    const item = m as Record<string, unknown>
    const mName = typeof item.name === 'string' ? item.name.trim() : ''
    const role = typeof item.role === 'string' ? item.role.trim() : ''
    const instructions = typeof item.instructions === 'string' ? item.instructions.trim() : ''
    if (!mName || !role || !instructions) throw new Error('AI üyelerinde boş alan var')
    return { name: mName, role, instructions }
  })
  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : []
  const tasks = rawTasks.map((t) => {
    const item = t as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const taskDesc = typeof item.description === 'string' ? item.description.trim() : ''
    if (!title) throw new Error('AI görevlerinde başlık eksik')
    const idx = Number(item.assigneeIndex)
    const assigneeIndex = Number.isInteger(idx) && idx >= 0 && idx < members.length ? idx : 0
    const criteria = Array.isArray(item.acceptanceCriteria)
      ? item.acceptanceCriteria.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      : []
    return { title, description: taskDesc, assigneeIndex, acceptanceCriteria: criteria }
  })
  const ts = new Date().toISOString()
  return { id: nanoid(), name, description, permissionPolicy: policy, members, tasks, createdAt: ts, updatedAt: ts }
}

export async function generateTeamSpec(
  provider: AiProvider,
  apiKey: string,
  model: string,
  objective: string,
  teamSizeHint?: number
): Promise<AgentTeamTemplate> {
  const goal = objective.trim()
  if (!goal) throw new Error('Takım hedefi boş olamaz')
  if (!apiKey) throw new Error('AI sağlayıcı anahtarı ayarlı değil')
  if (!model) throw new Error('AI modeli seçilmedi')
  const { url, headers } = endpointFor(provider, apiKey)
  const sizeLine = teamSizeHint ? `\n\nYaklaşık ${teamSizeHint} üyeli bir takım tasarla.` : ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Hedef: ${goal}${sizeLine}` }
        ]
      })
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('AI isteği zaman aşımına uğradı (60 sn)')
    throw new Error(`AI sağlayıcısına ulaşılamadı: ${err instanceof Error ? err.message : 'bilinmeyen hata'}`)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.text()).slice(0, 300) } catch { /* ignore */ }
    throw new Error(`AI sağlayıcı hatası (${response.status}): ${detail || response.statusText}`)
  }
  const data = await response.json()
  return coerceTemplate(pickContent(data))
}
