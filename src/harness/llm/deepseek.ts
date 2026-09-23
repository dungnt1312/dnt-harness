/**
 * The historical entry point, kept as sugar: DeepSeek speaks the standard
 * OpenAI chat-completions wire format, so it is simply a preconfigured
 * {@link OpenAiCompletionsProvider} against api.deepseek.com.
 */
export { OpenAiCompletionsProvider, type OpenAiCompletionsOptions } from './openai.ts'
import { OpenAiCompletionsProvider } from './openai.ts'

export class DeepSeekProvider extends OpenAiCompletionsProvider {
  constructor(apiKey: string, baseUrl = 'https://api.deepseek.com') {
    super({
      name: 'deepseek',
      apiKey,
      baseUrl,
      models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
    })
  }
}
