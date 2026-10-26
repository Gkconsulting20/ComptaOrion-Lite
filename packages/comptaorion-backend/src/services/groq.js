// Only this server module talks to Groq. No SDK, browser key, or OpenAI model.
export const GROQ_MODEL = 'qwen/qwen3.8-27b';
export const GROQ_LICENSE = 'Apache-2.0';
const API = 'https://api.groq.com/openai/v1';

export class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export async function groqRequest(path, body, { fetcher = fetch, key = process.env.GROQ_API_KEY } = {}) {
  if (!key) throw new AiError('Groq n’est pas configuré : ajoutez GROQ_API_KEY aux secrets du serveur.', 503);
  let response;
  try {
    response = await fetcher(`${API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new AiError('Groq est momentanément inaccessible. Réessayez sans modifier le brouillon.', 504);
  }
  // Never return provider bodies, which can echo document contents.
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new AiError('Vérifiez la clé Groq et les autorisations du modèle côté serveur.', 503);
    if (response.status === 429) {
      let providerErrorType = null;
      let providerErrorCode = null;
      try {
        const providerError = (await response.clone().json())?.error;
        const safeField = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : null;
        providerErrorType = safeField(providerError?.type);
        providerErrorCode = safeField(providerError?.code);
      } catch {}
      const diagnostics = {
        path,
        status: response.status,
        providerErrorType,
        providerErrorCode,
        retryAfter: response.headers.get('retry-after'),
        requestLimit: response.headers.get('x-ratelimit-limit-requests'),
        requestsRemaining: response.headers.get('x-ratelimit-remaining-requests'),
        requestReset: response.headers.get('x-ratelimit-reset-requests'),
        tokenLimit: response.headers.get('x-ratelimit-limit-tokens'),
        tokensRemaining: response.headers.get('x-ratelimit-remaining-tokens'),
        tokenReset: response.headers.get('x-ratelimit-reset-tokens'),
      };
      console.warn('[Groq] Rate limit response (safe metadata only):', JSON.stringify(diagnostics));
      const step = path === '/models' ? 'la vérification du modèle' : 'la lecture de la facture';
      throw new AiError(`Groq a limité ${step}. Réessayez plus tard.`, 429);
    }
    throw new AiError('Groq n’a pas pu traiter la demande. Vérifiez le modèle et réessayez.');
  }
  try { return await response.json(); }
  catch { throw new AiError('Réponse Groq illisible. Aucun enregistrement effectué.'); }
}

export async function checkGroqModel(options) {
  const result = await groqRequest('/models', undefined, options);
  if (!result.data?.some(m => m.id === GROQ_MODEL && m.active !== false)) {
    throw new AiError(`Le modèle autorisé ${GROQ_MODEL} n’est pas accessible sur ce compte. Aucun autre modèle ne sera utilisé.`, 503);
  }
}

export async function groqJson(messages, { schema, ...options } = {}) {
  await checkGroqModel(options);
  const result = await groqRequest('/chat/completions', {
    model: GROQ_MODEL,
    messages,
    reasoning_effort: 'none',
    temperature: 0.2,
    max_completion_tokens: 1800,
    response_format: schema ? {
      type: 'json_schema',
      json_schema: { name: 'lite_assistant_result', strict: true, schema },
    } : { type: 'json_object' },
  }, options);
  if (result.choices?.[0]?.finish_reason !== 'stop') throw new AiError('Réponse IA incomplète. Réessayez avec une photo plus lisible.');
  try { return JSON.parse(result.choices[0].message.content); }
  catch { throw new AiError('Réponse IA invalide. Aucun enregistrement effectué.'); }
}
