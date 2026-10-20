/**
 * The historical entry point, kept as sugar: DeepSeek speaks the standard
 * OpenAI chat-completions wire format, so it is simply a preconfigured
 * {@link OpenAiCompletionsProvider} against api.deepseek.com.
 */
export { OpenAiCompletionsProvider, type OpenAiCompletionsOptions } from './openai.ts'
import { OpenAiCompletionsProvider, type OpenAiCompletionsOptions } from './openai.ts'

/**
 * Models the hosted DeepSeek API serves, default first. `deepseek-chat` and
 * `deepseek-reasoner` were retired on 2026-07-24 and now fail, so neither is
 * offered; `deepseek-v4-flash` is a legacy name still routed to the current
 * Flash model. Shared by the CLI and the web host's env seed.
 */
export const DEEPSEEK_MODELS: readonly string[] = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash']

export class DeepSeekProvider extends OpenAiCompletionsProvider {
  constructor(apiKey: string, baseUrl = 'https://api.deepseek.com', options?: Pick<OpenAiCompletionsOptions, 'credentialHasher'>) {
    super({
      name: 'deepseek',
      apiKey,
      baseUrl,
      models: DEEPSEEK_MODELS,
      ...(options?.credentialHasher !== undefined ? { credentialHasher: options.credentialHasher } : {}),
    })
  }
}
