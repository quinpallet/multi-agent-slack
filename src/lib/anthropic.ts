import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
const SYSTEM_PROMPT =
  process.env.ANTHROPIC_SYSTEM ??
  'あなたは親切なアシスタントです。Slack 上でのやり取りなので、日本語で簡潔に回答してください。';

/** Generate a reply for the given user message using the Anthropic Messages API. */
export async function generateReply(apiKey: string, userMessage: string): Promise<string> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage || 'こんにちは' }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock && textBlock.type === 'text'
    ? textBlock.text
    : '回答を生成できませんでした。';
}
